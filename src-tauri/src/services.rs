//! Service layer: business orchestration over db + parser + scheduler. All
//! functions here are plain Rust (no Tauri types) so they are directly testable
//! against an in-memory database. `commands.rs` is a thin invoke wrapper.

use crate::db::{self, Card, Db, NewCard};
use crate::import::{self, ImportReport};
use crate::parser::{parse_markdown, ParsedDeck};
use crate::scheduler::{self, CardSched, CardState, Rating, ScheduleConfig};
use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDto {
    pub id: i64,
    pub deck: String,
    pub chapter: String,
    pub title: String,
    pub content_md: String,
    pub state: String,
    pub due_at: String,
    pub learning_step: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckOverview {
    pub name: String,
    pub chapter_count: i64,
    pub card_count: i64,
    pub due_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub decks: u32,
    pub chapters: u32,
    pub cards: u32,
    pub conflicts: u32,
    pub deck_names: Vec<String>,
}

fn state_to_str(s: CardState) -> &'static str {
    match s {
        CardState::New => "new",
        CardState::Learning => "learning",
        CardState::Review => "review",
        CardState::Relearning => "relearning",
    }
}

fn state_from_str(s: &str) -> Option<CardState> {
    match s {
        "new" => Some(CardState::New),
        "learning" => Some(CardState::Learning),
        "review" => Some(CardState::Review),
        "relearning" => Some(CardState::Relearning),
        _ => None,
    }
}

fn rating_from_str(s: &str) -> Option<Rating> {
    match s {
        "again" => Some(Rating::Again),
        "hard" => Some(Rating::Hard),
        "good" => Some(Rating::Good),
        "easy" => Some(Rating::Easy),
        _ => None,
    }
}

/// SPEC §14 review_log rating codes.
fn rating_num(r: Rating) -> i64 {
    match r {
        Rating::Again => 1,
        Rating::Hard => 2,
        Rating::Good => 3,
        Rating::Easy => 4,
    }
}

fn to_dto(c: &Card) -> CardDto {
    CardDto {
        id: c.id,
        deck: c.deck.clone(),
        chapter: c.chapter.clone(),
        title: c.title.clone(),
        content_md: c.content_md.clone(),
        state: c.state.clone(),
        due_at: db::fmt_time(c.due_at),
        learning_step: c.learning_step,
    }
}

fn to_sched(c: &Card) -> CardSched {
    CardSched {
        state: state_from_str(&c.state).unwrap_or(CardState::New),
        stability: c.stability.map(|s| s as f32),
        difficulty: c.difficulty.map(|d| d as f32),
        learning_step: c.learning_step.max(0) as usize,
        last_review_at: c.last_review_at,
    }
}

/// Settings-driven config; falls back to SPEC §7.4 defaults per key.
fn cfg_from_db(db: &Db) -> ScheduleConfig {
    let mut cfg = ScheduleConfig::default();
    if let Some(v) = db.get_setting("steps_min").ok().flatten() {
        // Present-but-empty means intermittent mode: no minute-level steps at
        // all (SPEC §7.2 修订). A missing key keeps the 1/5/10 default.
        cfg.steps_min = v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    }
    if let Some(v) = db.get_setting("retention").ok().flatten() {
        if let Ok(r) = v.parse::<f32>() {
            let clamped = r.clamp(0.80, 0.95);
            cfg.retention = clamped;
        }
    }
    if let Some(v) = db.get_setting("skip_delay_min").ok().flatten() {
        if let Ok(m) = v.parse::<u32>() {
            cfg.skip_delay_min = m.clamp(10, 120);
        }
    }
    cfg
}

pub fn add_card(
    db: &Db,
    deck: &str,
    chapter: &str,
    title: &str,
    content_md: &str,
) -> Result<CardDto, String> {
    if title.trim().is_empty() {
        return Err("卡片标题不能为空".into());
    }
    let id = db
        .insert_card(
            &NewCard {
                deck: deck.trim().to_string(),
                chapter: chapter.trim().to_string(),
                title: title.trim().to_string(),
                content_md: content_md.to_string(),
                source_file: None,
            },
            Utc::now(),
        )
        .map_err(|e| e.to_string())?;
    db.get_card(id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after insert".into())
}

pub fn import_markdown(
    db: &Db,
    files: &[ImportFile],
    prefer_file: bool,
) -> Result<ImportReport, String> {
    let decks = parse_files(files);
    import::import(db, &decks, None, prefer_file).map_err(|e| e.to_string())
}

/// Parse without inserting: SPEC §5.3 import preview (N decks / M chapters / K
/// cards), plus how many locally-edited cards would conflict.
pub fn preview_import(db: &Db, files: &[ImportFile]) -> Result<ImportPreview, String> {
    let decks = parse_files(files);
    let mut preview = ImportPreview {
        decks: decks.len() as u32,
        deck_names: decks.iter().map(|d| d.name.clone()).collect(),
        ..Default::default()
    };
    for d in &decks {
        preview.chapters += d.chapters.len() as u32;
        for ch in &d.chapters {
            preview.cards += ch.cards.len() as u32;
            for card in &ch.cards {
                if existing_local_edit_count(db, &d.name, &ch.name, &card.title) > 0 {
                    preview.conflicts += 1;
                }
            }
        }
    }
    Ok(preview)
}

fn existing_local_edit_count(db: &Db, deck: &str, chapter: &str, title: &str) -> i64 {
    db.0.query_row(
        "SELECT COUNT(*) FROM card c
             JOIN chapter ch ON ch.id = c.chapter_id
             JOIN deck d ON d.id = ch.deck_id
             WHERE d.name = ?1 AND ch.name = ?2 AND c.title = ?3 AND c.locally_edited = 1",
        rusqlite::params![deck, chapter, title],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn parse_files(files: &[ImportFile]) -> Vec<ParsedDeck> {
    let mut decks = Vec::new();
    for f in files {
        let stem = std::path::Path::new(&f.name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名卡包")
            .to_string();
        decks.extend(parse_markdown(&f.content, &stem));
    }
    decks
}

pub fn list_overview(db: &Db) -> Result<Vec<DeckOverview>, String> {
    let sql = "SELECT d.name,
        COUNT(DISTINCT ch.id) AS chapters,
        COUNT(c.id) AS cards,
        COALESCE(SUM(CASE WHEN c.due_at <= ?1 AND c.state NOT IN ('suspended','archived')
                          THEN 1 ELSE 0 END), 0) AS due
        FROM deck d
        LEFT JOIN chapter ch ON ch.deck_id = d.id
        LEFT JOIN card c ON c.chapter_id = ch.id
        GROUP BY d.id ORDER BY d.name";
    let mut stmt = db.0.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([db::fmt_time(Utc::now())], |r| {
            Ok(DeckOverview {
                name: r.get(0)?,
                chapter_count: r.get(1)?,
                card_count: r.get(2)?,
                due_count: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn due_queue(db: &Db, limit: i64) -> Result<Vec<CardDto>, String> {
    Ok(db
        .list_due(Utc::now(), limit)
        .map_err(|e| e.to_string())?
        .iter()
        .map(to_dto)
        .collect())
}

/// Read-only deck browsing (SPEC §15.2 卡包管理 的 M1 只读预览).
pub fn list_cards(db: &Db, deck: &str) -> Result<Vec<CardDto>, String> {
    Ok(db
        .list_cards_by_deck(deck)
        .map_err(|e| e.to_string())?
        .iter()
        .map(to_dto)
        .collect())
}

pub fn rename_deck(db: &Db, old_name: &str, new_name: &str) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("卡包名不能为空".into());
    }
    let renamed = db.rename_deck(old_name, new_name).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "卡包名已存在".to_string()
        } else {
            e.to_string()
        }
    })?;
    if !renamed {
        return Err("卡包不存在".into());
    }
    Ok(())
}

pub fn delete_deck(db: &mut Db, name: &str) -> Result<(), String> {
    if !db.delete_deck(name).map_err(|e| e.to_string())? {
        return Err("卡包不存在".into());
    }
    Ok(())
}

/// SPEC §6: soft delete — suspended cards leave every queue but stay in the DB.
pub fn delete_card(db: &Db, card_id: i64) -> Result<(), String> {
    if !db.delete_card(card_id).map_err(|e| e.to_string())? {
        return Err("卡片不存在".into());
    }
    Ok(())
}

pub fn update_card(
    db: &Db,
    card_id: i64,
    title: &str,
    content_md: &str,
) -> Result<CardDto, String> {
    if title.trim().is_empty() {
        return Err("卡片标题不能为空".into());
    }
    if !db
        .update_card(card_id, title.trim(), content_md)
        .map_err(|e| e.to_string())?
    {
        return Err("卡片不存在".into());
    }
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after update".into())
}

/// Search + filter for the deck browser (SPEC §15.2 搜索/筛选).
pub fn search_cards(
    db: &Db,
    query: Option<String>,
    deck: Option<String>,
    filter: Option<String>,
) -> Result<Vec<CardDto>, String> {
    let filter = filter.unwrap_or_else(|| "all".into());
    Ok(db
        .search_cards(query.as_deref(), deck.as_deref(), &filter)
        .map_err(|e| e.to_string())?
        .iter()
        .map(to_dto)
        .collect())
}

/// Cards by explicit id list, requested order preserved (manual sessions).
pub fn cards_by_ids(db: &Db, ids: &[i64]) -> Result<Vec<CardDto>, String> {
    Ok(db
        .cards_by_ids(ids)
        .map_err(|e| e.to_string())?
        .iter()
        .map(to_dto)
        .collect())
}

/// Explicit-card review session: the popup consumes the pending id list once
/// (set by "复习选中/复习该包"), otherwise falls back to the due queue.
pub type ReviewSession = std::sync::Mutex<Option<Vec<i64>>>;

pub fn set_review_session(slot: &ReviewSession, ids: Vec<i64>) {
    *slot.lock().expect("review session poisoned") = Some(ids);
}

pub fn review_queue(db: &Db, slot: &ReviewSession, due_limit: i64) -> Result<Vec<CardDto>, String> {
    let pending = slot.lock().expect("review session poisoned").take();
    if let Some(ids) = pending {
        return Ok(db
            .cards_by_ids(&ids)
            .map_err(|e| e.to_string())?
            .iter()
            .map(to_dto)
            .collect());
    }
    due_queue(db, due_limit)
}

/// Due cards of one deck — the "复习该包" button.
pub fn due_cards_of_deck(db: &Db, deck: &str) -> Result<Vec<CardDto>, String> {
    search_cards(db, None, Some(deck.to_string()), Some("due".into()))
}

/// Rate a card: scheduler decides, then card update + review_log row commit in
/// one transaction (SPEC §17: a crash must never lose a rating).
pub fn rate(db: &mut Db, card_id: i64, rating: &str) -> Result<CardDto, String> {
    let r = rating_from_str(rating).ok_or_else(|| format!("未知评分: {rating}"))?;
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let now = Utc::now();
    let out = scheduler::review(&to_sched(&card), r, now, &cfg).map_err(|e| e.to_string())?;

    let lapsed = card.state == "review" && r == Rating::Again;
    let tx = db.0.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE card SET state=?1, stability=?2, difficulty=?3, due_at=?4,
         last_review_at=?5, reps=reps+1, lapses=lapses+?6, learning_step=?7
         WHERE id=?8",
        rusqlite::params![
            state_to_str(out.state),
            out.stability,
            out.difficulty,
            db::fmt_time(out.due_at),
            db::fmt_time(now),
            i64::from(lapsed),
            out.learning_step as i64,
            card_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO review_log(card_id, rating, state_before, stability, difficulty,
         scheduled_interval, reviewed_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            card_id,
            rating_num(r),
            card.state,
            out.stability,
            out.difficulty,
            (out.due_at - now).num_minutes().to_string(),
            db::fmt_time(now),
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after rating".into())
}

/// SPEC §7.1: skip rates nothing — no review_log row, only a postponed due_at.
pub fn skip_card(db: &Db, card_id: i64) -> Result<CardDto, String> {
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let due = scheduler::skip(&to_sched(&card), Utc::now(), &cfg);
    db.0.execute(
        "UPDATE card SET due_at=?1 WHERE id=?2",
        rusqlite::params![db::fmt_time(due), card_id],
    )
    .map_err(|e| e.to_string())?;
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after skip".into())
}

pub fn preview_intervals(db: &Db, card_id: i64) -> Result<Vec<Option<f64>>, String> {
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let p = scheduler::preview(&to_sched(&card), Utc::now(), &cfg).map_err(|e| e.to_string())?;
    Ok(p.to_vec())
}

/// Total due count (for tray tooltip, home page and engine tick).
pub fn due_count(db: &Db) -> Result<i64, String> {
    db.0.query_row(
        "SELECT COUNT(*) FROM card
             WHERE due_at <= ?1 AND state NOT IN ('suspended','archived')",
        [db::fmt_time(Utc::now())],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn list_settings(db: &Db) -> Result<Vec<(String, String)>, String> {
    db.list_settings().map_err(|e| e.to_string())
}

pub fn set_settings(db: &Db, map: &[(String, String)]) -> Result<(), String> {
    for (k, v) in map {
        db.set_setting(k, v).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn add_card_creates_new_due_now() {
        let d = db();
        let dto = add_card(&d, "MySQL", "事务", "ACID?", "要点").unwrap();
        assert_eq!(dto.state, "new");
        assert_eq!(dto.learning_step, 0);
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert!(c.due_at <= Utc::now());
    }

    #[test]
    fn add_card_rejects_blank_title() {
        let d = db();
        assert!(add_card(&d, "D", "C", "  ", "x").is_err());
    }

    #[test]
    fn rate_persists_review_log() {
        let mut d = db();
        let dto = add_card(&d, "MySQL", "事务", "ACID?", "要点").unwrap();
        let after = rate(&mut d, dto.id, "good").unwrap();
        // Good on a new card advances to learning step 1 (5 minutes).
        assert_eq!(after.state, "learning");
        assert_eq!(after.learning_step, 1);
        let (n, rating, before): (i64, i64, String) =
            d.0.query_row(
                "SELECT COUNT(*), rating, state_before FROM review_log GROUP BY id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((n, rating, before.as_str()), (1, 3, "new"));
        let due: String =
            d.0.query_row("SELECT due_at FROM card WHERE id=?1", [dto.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(db::parse_time(&due) > Utc::now());
    }

    #[test]
    fn rate_unknown_rating_errors() {
        let mut d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        assert!(rate(&mut d, dto.id, "excellent").is_err());
    }

    #[test]
    fn due_queue_orders_oldest_due_first() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        let b = add_card(&d, "D", "C", "卡B", "x").unwrap();
        d.0.execute(
            "UPDATE card SET due_at=?1 WHERE id=?2",
            rusqlite::params![
                db::fmt_time(Utc::now() - chrono::Duration::minutes(10)),
                a.id
            ],
        )
        .unwrap();
        d.0.execute(
            "UPDATE card SET due_at=?1 WHERE id=?2",
            rusqlite::params![
                db::fmt_time(Utc::now() - chrono::Duration::minutes(1)),
                b.id
            ],
        )
        .unwrap();
        let q = due_queue(&d, 10).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["卡A", "卡B"]
        );
    }

    #[test]
    fn preview_reports_counts_and_conflicts() {
        let d = db();
        let files = vec![ImportFile {
            name: "mysql.md".into(),
            content: "# MySQL\n\n## 事务\n\n### ACID\n要点\n\n### 隔离\n要点\n".into(),
        }];
        import_markdown(&d, &files, false).unwrap();
        let p = preview_import(&d, &files).unwrap();
        assert_eq!((p.decks, p.chapters, p.cards), (1, 1, 2));
        assert_eq!(p.conflicts, 0);
        d.0.execute("UPDATE card SET locally_edited=1 WHERE title='ACID'", [])
            .unwrap();
        let p = preview_import(&d, &files).unwrap();
        assert_eq!(p.conflicts, 1);
    }

    #[test]
    fn skip_postpones_without_log() {
        let d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        let after = skip_card(&d, dto.id).unwrap();
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert!(c.due_at > Utc::now());
        assert_eq!(after.state, "new");
        let n: i64 =
            d.0.query_row("SELECT COUNT(*) FROM review_log", [], |r| r.get(0))
                .unwrap();
        assert_eq!(n, 0, "skip must not write a review log");
    }

    #[test]
    fn preview_intervals_all_present() {
        let d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        let p = preview_intervals(&d, dto.id).unwrap();
        assert_eq!(p.len(), 4);
        assert_eq!(p[0], Some(1.0));
        assert!(p[3].unwrap() > 1000.0);
    }

    #[test]
    fn list_cards_orders_by_deck_reading_order() {
        let d = db();
        add_card(&d, "MySQL", "索引", "B+树", "x").unwrap();
        add_card(&d, "MySQL", "事务", "ACID", "x").unwrap();
        add_card(&d, "Redis", "持久化", "RDB", "x").unwrap();
        let cards = list_cards(&d, "MySQL").unwrap();
        assert_eq!(
            cards.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["B+树", "ACID"]
        );
        assert!(cards.iter().all(|c| c.deck == "MySQL"));
        assert_eq!(list_cards(&d, "不存在").unwrap(), Vec::new());
    }

    #[test]
    fn rename_deck_updates_name_and_keeps_cards() {
        let d = db();
        add_card(&d, "旧名", "C", "T1", "x").unwrap();
        rename_deck(&d, "旧名", "新名").unwrap();
        assert_eq!(list_cards(&d, "新名").unwrap().len(), 1);
        assert!(list_cards(&d, "旧名").unwrap().is_empty());
    }

    #[test]
    fn rename_deck_rejects_duplicate_and_blank() {
        let d = db();
        add_card(&d, "A", "C", "T", "x").unwrap();
        add_card(&d, "B", "C", "T", "x").unwrap();
        assert!(rename_deck(&d, "A", "B").is_err());
        assert!(rename_deck(&d, "A", "  ").is_err());
        assert!(rename_deck(&d, "不存在", "X").is_err());
    }

    #[test]
    fn delete_deck_removes_cards_chapters_and_logs() {
        let mut d = db();
        let dto = add_card(&d, "目标包", "C", "T1", "x").unwrap();
        add_card(&d, "目标包", "C", "T2", "x").unwrap();
        add_card(&d, "保留包", "C", "T3", "x").unwrap();
        rate(&mut d, dto.id, "good").unwrap(); // review_log row exists
        delete_deck(&mut d, "目标包").unwrap();
        let cards: i64 =
            d.0.query_row("SELECT COUNT(*) FROM card", [], |r| r.get(0))
                .unwrap();
        let logs: i64 =
            d.0.query_row("SELECT COUNT(*) FROM review_log", [], |r| r.get(0))
                .unwrap();
        assert_eq!((cards, logs), (1, 0), "target deck fully removed");
        assert_eq!(list_cards(&d, "保留包").unwrap().len(), 1);
        assert!(delete_deck(&mut d, "不存在").is_err());
    }

    #[test]
    fn delete_card_suspends_and_hides() {
        let d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        delete_card(&d, dto.id).unwrap();
        assert!(list_cards(&d, "D").unwrap().is_empty());
        assert!(due_queue(&d, 10).unwrap().is_empty());
        // Soft delete: the row stays with state suspended.
        let state: String =
            d.0.query_row("SELECT state FROM card WHERE id=?1", [dto.id], |r| r.get(0))
                .unwrap();
        assert_eq!(state, "suspended");
        assert!(delete_card(&d, dto.id).is_err(), "already deleted");
    }

    #[test]
    fn update_card_edits_title_and_content() {
        let d = db();
        let dto = add_card(&d, "D", "C", "旧题", "旧内容").unwrap();
        let after = update_card(&d, dto.id, "新题", "新内容").unwrap();
        assert_eq!(
            (after.title.as_str(), after.content_md.as_str()),
            ("新题", "新内容")
        );
        assert!(update_card(&d, dto.id, "", "x").is_err());
    }

    #[test]
    fn search_filters_by_query_deck_and_state() {
        let d = db();
        add_card(&d, "MySQL", "事务", "ACID 是什么", "原子性 一致性").unwrap();
        add_card(&d, "MySQL", "索引", "B+树", "聚簇索引").unwrap();
        add_card(&d, "Redis", "持久化", "RDB", "快照").unwrap();

        // Title match.
        let r = search_cards(&d, Some("ACID".into()), None, None).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "ACID 是什么");
        // Content match.
        let r = search_cards(&d, Some("快照".into()), None, None).unwrap();
        assert_eq!(
            r.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["RDB"]
        );
        // Deck scoping.
        let r = search_cards(&d, None, Some("MySQL".into()), None).unwrap();
        assert_eq!(r.len(), 2);
        // State filter: all cards are new.
        let r = search_cards(&d, None, None, Some("new".into())).unwrap();
        assert_eq!(r.len(), 3);
        let r = search_cards(&d, None, None, Some("due".into())).unwrap();
        assert_eq!(r.len(), 3, "fresh cards are due immediately");
        // LIKE wildcards in user input are literal.
        let r = search_cards(&d, Some("%".into()), None, None).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn review_session_is_consumed_once() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        let b = add_card(&d, "D", "C", "卡B", "x").unwrap();
        let slot = ReviewSession::default();
        set_review_session(&slot, vec![b.id, a.id]);
        let q = review_queue(&d, &slot, 1).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["卡B", "卡A"],
            "session order is preserved"
        );
        // Second call: session consumed, falls back to the due queue (limit 1).
        let q = review_queue(&d, &slot, 1).unwrap();
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn session_includes_not_yet_due_cards() {
        let d = db();
        let c = add_card(&d, "D", "C", "未到期", "x").unwrap();
        d.0.execute(
            "UPDATE card SET due_at=?1 WHERE id=?2",
            rusqlite::params![
                crate::db::fmt_time(Utc::now() + chrono::Duration::days(5)),
                c.id
            ],
        )
        .unwrap();
        let slot = ReviewSession::default();
        set_review_session(&slot, vec![c.id]);
        let q = review_queue(&d, &slot, 10).unwrap();
        assert_eq!(
            q.len(),
            1,
            "manual session reviews cards regardless of due time"
        );
    }

    #[test]
    fn due_cards_of_deck_scopes_correctly() {
        let d = db();
        add_card(&d, "A包", "C", "T1", "x").unwrap();
        add_card(&d, "B包", "C", "T2", "x").unwrap();
        let r = due_cards_of_deck(&d, "A包").unwrap();
        assert_eq!(
            r.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["T1"]
        );
    }

    #[test]
    fn empty_steps_setting_enables_intermittent_mode() {
        let d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // Default 1/5/10: Again previews as one minute.
        assert_eq!(preview_intervals(&d, c.id).unwrap()[0], Some(1.0));
        // Empty steps setting: no minute-level re-pops at all.
        set_settings(&d, &[("steps_min".into(), "".into())]).unwrap();
        let p = preview_intervals(&d, c.id).unwrap();
        assert!(
            p[0].unwrap() > 60.0,
            "intermittent mode should schedule Again hours out, got {:?}",
            p[0]
        );
    }

    #[test]
    fn settings_roundtrip_via_service() {
        let d = db();
        set_settings(&d, &[("popup_interval_min".into(), "15".into())]).unwrap();
        assert_eq!(
            list_settings(&d).unwrap(),
            vec![("popup_interval_min".into(), "15".into())]
        );
    }
}
