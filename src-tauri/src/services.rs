//! Service layer: business orchestration over db + parser + scheduler. All
//! functions here are plain Rust (no Tauri types) so they are directly testable
//! against an in-memory database. `commands.rs` is a thin invoke wrapper.

use crate::db::{self, Card, Db, NewCard};
use crate::import::{self, ImportReport};
use crate::parser::{parse_markdown, ParsedDeck};
use crate::scheduler::{self, CardSched, Rating, ScheduleConfig};
use chrono::{Duration, Utc};
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
    pub needs_attention: bool,
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

fn rating_from_str(s: &str) -> Option<Rating> {
    match s {
        "unknown" => Some(Rating::Unknown),
        "familiar" => Some(Rating::Familiar),
        "speakable" => Some(Rating::Speakable),
        _ => None,
    }
}

/// SPEC §14 review_log rating codes (new scale: 1 不了解 / 2 熟悉 / 3 可以讲出来).
fn rating_num(r: Rating) -> i64 {
    match r {
        Rating::Unknown => 1,
        Rating::Familiar => 2,
        Rating::Speakable => 3,
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
        needs_attention: c.needs_attention,
    }
}

fn to_sched(c: &Card) -> CardSched {
    CardSched {
        interval_min: c.interval_minutes.map(|v| v.max(0) as u32),
        unknown_streak: c.unknown_streak.max(0) as u32,
        speak_streak: c.speak_streak.max(0) as u32,
        needs_attention: c.needs_attention,
    }
}

fn get_u32(db: &Db, key: &str, default: u32) -> u32 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn get_f64(db: &Db, key: &str, default: f64) -> f64 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Settings-driven config (SPEC §7.4). The ordering invariant
/// `min ≤ initial ≤ familiar_cap ≤ max` is re-established by chaining clamps.
fn cfg_from_db(db: &Db) -> ScheduleConfig {
    let mut cfg = ScheduleConfig::default();
    let min = get_u32(db, "min_interval_min", 120).max(30);
    let max = (get_u32(db, "max_interval_days", 60).max(1) * 1440).max(min);
    let familiar_cap = (get_u32(db, "familiar_cap_days", 7).max(1) * 1440).clamp(min, max);
    let initial = (get_u32(db, "initial_interval_days", 1).max(1) * 1440).clamp(min, familiar_cap);
    cfg.min_interval_min = min;
    cfg.initial_interval_min = initial;
    cfg.familiar_cap_min = familiar_cap;
    cfg.max_interval_min = max;
    cfg.familiar_mult = get_f64(db, "familiar_mult", 1.5).clamp(1.0, 10.0);
    cfg.speak_mult = get_f64(db, "speak_mult", 2.5).clamp(cfg.familiar_mult, 10.0);
    cfg.attention_threshold = get_u32(db, "attention_threshold", 3).max(2);
    cfg.attention_interval_min =
        (get_u32(db, "attention_interval_days", 1).max(1) * 1440).clamp(min, max);
    cfg
}

/// Display throttling (SPEC §7 队列规则): (同卡最小展示间隔, 滚动24h上限,
/// 每日新卡上限, 每次会话新卡上限).
fn queue_limits(db: &Db) -> (u32, i64, i64, i64) {
    let gap = get_u32(db, "min_display_gap_min", 120).max(1);
    let max_shows = get_u32(db, "max_daily_shows", 2).clamp(1, 5) as i64;
    let daily_new = get_u32(db, "daily_new_limit", 5) as i64;
    let session_new = get_u32(db, "session_new_limit", 1).clamp(0, 10) as i64;
    (gap, max_shows, daily_new, session_new)
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

/// Popup queue (design §4): due review cards first (oldest due, display-capped),
/// then new cards within the per-session and rolling-24h quotas. Fewer
/// candidates than `limit` means a shorter session; zero means no popup.
pub fn due_queue(db: &Db, limit: i64) -> Result<Vec<CardDto>, String> {
    let now = Utc::now();
    let (gap_min, max_shows, daily_new, session_new) = queue_limits(db);
    let gap_cutoff = now - Duration::minutes(gap_min as i64);
    let day_cutoff = now - Duration::hours(24);

    let mut cards = db
        .due_review_cards(now, limit, gap_cutoff, day_cutoff, max_shows)
        .map_err(|e| e.to_string())?;

    let remaining = (limit - cards.len() as i64).max(0);
    if remaining > 0 && session_new > 0 {
        let introduced = db
            .new_introduced_since(day_cutoff)
            .map_err(|e| e.to_string())?;
        let quota = (daily_new - introduced)
            .clamp(0, session_new)
            .min(remaining);
        if quota > 0 {
            cards.extend(
                db.new_cards_eligible(quota, gap_cutoff, day_cutoff, max_shows)
                    .map_err(|e| e.to_string())?,
            );
        }
    }

    Ok(cards.iter().map(to_dto).collect())
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
///
/// Early practice (design §2): a not-yet-due card rated Familiar/Speakable is
/// only logged — positive practice must not stretch its schedule. Unknown on an
/// early card applies normally (finding out you forgot is real information).
pub fn rate(db: &mut Db, card_id: i64, rating: &str) -> Result<CardDto, String> {
    let r = rating_from_str(rating).ok_or_else(|| format!("未知评分: {rating}"))?;
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let now = Utc::now();

    if card.due_at > now && r != Rating::Unknown {
        let tx = db.0.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO review_log(card_id, rating, state_before, scheduled_interval, reviewed_at)
             VALUES(?1, ?2, ?3, NULL, ?4)",
            rusqlite::params![card_id, rating_num(r), card.state, db::fmt_time(now)],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(to_dto(&card));
    }

    let out = scheduler::review(&to_sched(&card), r, now, &cfg);
    let lapsed = i64::from(r == Rating::Unknown);
    let tx = db.0.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE card SET state='review', interval_minutes=?1, due_at=?2,
         unknown_streak=?3, speak_streak=?4, needs_attention=?5,
         last_review_at=?6, reps=reps+1, lapses=lapses+?7
         WHERE id=?8",
        rusqlite::params![
            i64::from(out.interval_min),
            db::fmt_time(out.due_at),
            i64::from(out.unknown_streak),
            i64::from(out.speak_streak),
            i64::from(out.needs_attention),
            db::fmt_time(now),
            lapsed,
            card_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO review_log(card_id, rating, state_before, stability, difficulty,
         scheduled_interval, reviewed_at)
         VALUES(?1, ?2, ?3, NULL, NULL, ?4, ?5)",
        rusqlite::params![
            card_id,
            rating_num(r),
            card.state,
            out.interval_min.to_string(),
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
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let skip_delay = get_u32(db, "skip_delay_min", 30).clamp(10, 120);
    let due = scheduler::skip(Utc::now(), skip_delay);
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

/// Planned intervals per [不了解, 熟悉, 可以讲出来] in minutes.
pub fn preview_intervals(db: &Db, card_id: i64) -> Result<Vec<u32>, String> {
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    Ok(scheduler::preview(&to_sched(&card), &cfg).to_vec())
}

/// Record that a card was actually shown (display throttling, design §2).
pub fn mark_shown(db: &Db, card_id: i64) -> Result<(), String> {
    db.insert_show_log(card_id, Utc::now())
        .map_err(|e| e.to_string())
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
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert!(c.due_at <= Utc::now());
        assert_eq!(
            c.interval_minutes, None,
            "new cards have no planned interval"
        );
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
        let after = rate(&mut d, dto.id, "familiar").unwrap();
        // New + Familiar = 1 day; state flips to review.
        assert_eq!(after.state, "review");
        let (n, rating, before, interval): (i64, i64, String, Option<String>) =
            d.0.query_row(
                "SELECT COUNT(*), rating, state_before, scheduled_interval
                 FROM review_log GROUP BY id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((n, rating, before.as_str()), (1, 2, "new"));
        assert_eq!(interval.as_deref(), Some("1440"));
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert_eq!(c.interval_minutes, Some(1440));
        let due = c.due_at - Utc::now();
        assert!(
            (due.num_minutes() - 1440).abs() < 5,
            "due should be ~1 day out, got {} min",
            due.num_minutes()
        );
    }

    #[test]
    fn early_positive_practice_only_logs() {
        let mut d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        rate(&mut d, dto.id, "familiar").unwrap(); // schedule: +1d
        let due_before = d.get_card(dto.id).unwrap().unwrap().due_at;
        // Practice the card early (it is days away) with a positive rating.
        let after = rate(&mut d, dto.id, "speakable").unwrap();
        assert!(due_before == d.get_card(dto.id).unwrap().unwrap().due_at);
        assert_eq!(after.state, "review");
        let (interval, count): (Option<i64>, i64) = (
            d.get_card(dto.id).unwrap().unwrap().interval_minutes,
            d.0.query_row("SELECT COUNT(*) FROM review_log", [], |r| r.get(0))
                .unwrap(),
        );
        assert_eq!(
            interval,
            Some(1440),
            "positive practice must not extend the schedule"
        );
        assert_eq!(count, 2, "practice is still logged");
        // But finding out you forgot early applies for real.
        let after = rate(&mut d, dto.id, "unknown").unwrap();
        assert_eq!(after.state, "review");
        assert_eq!(
            d.get_card(dto.id).unwrap().unwrap().interval_minutes,
            Some(120)
        );
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
        // Both are scheduled review cards, overdue by different amounts.
        for (id, minutes_ago, interval) in [(a.id, 10, 1440), (b.id, 1, 1440)] {
            d.0.execute(
                "UPDATE card SET state='review', interval_minutes=?1, due_at=?2 WHERE id=?3",
                rusqlite::params![
                    interval,
                    db::fmt_time(Utc::now() - chrono::Duration::minutes(minutes_ago)),
                    id
                ],
            )
            .unwrap();
        }
        let q = due_queue(&d, 10).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["卡A", "卡B"]
        );
    }

    #[test]
    fn new_card_quotas_limit_introduction() {
        let d = db();
        add_card(&d, "D", "C", "新1", "x").unwrap();
        add_card(&d, "D", "C", "新2", "x").unwrap();
        add_card(&d, "D", "C", "新3", "x").unwrap();
        // Default session_new_limit = 1: only one new card per session.
        assert_eq!(due_queue(&d, 10).unwrap().len(), 1);
        // Two per session when configured.
        set_settings(&d, &[("session_new_limit".into(), "2".into())]).unwrap();
        assert_eq!(due_queue(&d, 10).unwrap().len(), 2);
        // Daily quota caps across sessions: pretend 5 were introduced today.
        set_settings(&d, &[("session_new_limit".into(), "5".into())]).unwrap();
        for _ in 0..5 {
            d.0.execute(
                "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
                 VALUES(1, 2, 'new', ?1)",
                [db::fmt_time(Utc::now() - chrono::Duration::hours(1))],
            )
            .unwrap();
        }
        assert_eq!(
            due_queue(&d, 10).unwrap().len(),
            0,
            "daily new quota exhausted"
        );
    }

    #[test]
    fn display_throttling_caps_shows_per_card() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', interval_minutes=1440, due_at=?1 WHERE id=?2",
            rusqlite::params![db::fmt_time(Utc::now() - chrono::Duration::hours(1)), a.id],
        )
        .unwrap();
        // Recently shown (within the 120-min gap): excluded.
        mark_shown(&d, a.id).unwrap();
        assert!(
            due_queue(&d, 10).unwrap().is_empty(),
            "min display gap honored"
        );
        // Shown twice long ago (outside gap, within 24h): max_daily_shows=2 reached.
        d.0.execute("DELETE FROM card_show_log", []).unwrap();
        for hours_ago in [5, 3] {
            d.0.execute(
                "INSERT INTO card_show_log(card_id, shown_at) VALUES(?1, ?2)",
                rusqlite::params![
                    a.id,
                    db::fmt_time(Utc::now() - chrono::Duration::hours(hours_ago))
                ],
            )
            .unwrap();
        }
        assert!(
            due_queue(&d, 10).unwrap().is_empty(),
            "daily show cap honored"
        );
        // Shows older than 24h do not count.
        d.0.execute("DELETE FROM card_show_log", []).unwrap();
        d.0.execute(
            "INSERT INTO card_show_log(card_id, shown_at) VALUES(?1, ?2)",
            rusqlite::params![a.id, db::fmt_time(Utc::now() - chrono::Duration::hours(25))],
        )
        .unwrap();
        assert_eq!(due_queue(&d, 10).unwrap().len(), 1, "old shows age out");
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
        assert_eq!(
            p,
            vec![120, 1440, 1440],
            "new card: unknown 2h, positives 1d"
        );
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
        rate(&mut d, dto.id, "familiar").unwrap(); // review_log row exists
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
    fn settings_drive_scheduling_config() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // Defaults: unknown 2h, positives 1d.
        assert_eq!(preview_intervals(&d, c.id).unwrap(), vec![120, 1440, 1440]);
        // Custom minimum interval flows into the preview.
        set_settings(&d, &[("min_interval_min".into(), "45".into())]).unwrap();
        assert_eq!(
            preview_intervals(&d, c.id).unwrap()[0],
            60,
            "45m rounds up to 1h"
        );
        // Multipliers apply to scheduled cards.
        rate(&mut d, c.id, "speakable").unwrap(); // 1d
        let p = preview_intervals(&d, c.id).unwrap();
        assert_eq!(p[1], 2 * 1440, "familiar: 1d × 1.5 → 2d");
        assert_eq!(p[2], 3 * 1440, "speakable: 1d × 2.5 → 3d");
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
