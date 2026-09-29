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
    pub level: u32,
    pub lapses: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckOverview {
    pub name: String,
    pub chapter_count: i64,
    pub card_count: i64,
    pub due_count: i64,
    /// SPEC §11.1 auto-chaining switch (deck.chain_by_order).
    pub chain_by_order: bool,
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
        level: c.level.max(0) as u32,
        lapses: c.lapses,
    }
}

fn to_sched(c: &Card) -> CardSched {
    CardSched {
        level: c.level.max(0) as u32,
        next_eligible_seq: c.next_eligible_seq.max(0) as u64,
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

fn get_u64(db: &Db, key: &str, default: u64) -> u64 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Settings-driven config (SPEC §7.4). Level gaps keep the 6-entry shape and
/// stay non-decreasing.
fn cfg_from_db(db: &Db) -> ScheduleConfig {
    let mut cfg = ScheduleConfig::default();
    cfg.gap_unknown = get_u64(db, "gap_unknown", 3).max(1);
    cfg.gap_familiar = get_u64(db, "gap_familiar", 8).max(1);
    cfg.gap_speakable = get_u64(db, "gap_speakable", 20).max(1);
    cfg.attention_gap = get_u64(db, "attention_gap", 5).max(1);
    cfg.max_unknown_gap = get_u64(db, "max_unknown_gap", 10).max(cfg.attention_gap);
    if let Some(v) = db.get_setting("level_gaps").ok().flatten() {
        let gaps: Vec<u64> = v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if gaps.len() == cfg.level_gap.len() {
            let mut sorted = gaps;
            sorted.sort_unstable();
            cfg.level_gap.copy_from_slice(&sorted);
        }
    }
    cfg.floor_unknown_min = get_u32(db, "floor_unknown_min", 10);
    cfg.floor_familiar_min = get_u32(db, "floor_familiar_min", 30);
    cfg.floor_speakable_min = get_u32(db, "floor_speakable_min", 120);
    cfg.attention_threshold = get_u32(db, "attention_threshold", 3).max(2);
    cfg
}

/// New-card quotas: (每日上限, 每次会话上限).
fn new_quotas(db: &Db) -> (i64, i64) {
    let daily_new = get_u32(db, "daily_new_limit", 5) as i64;
    let session_new = get_u32(db, "session_new_limit", 1).clamp(0, 10) as i64;
    (daily_new, session_new)
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
    let mut preview = ImportPreview::default();
    for d in &decks {
        // Empty decks (stray leading H1 etc.) are not part of the import.
        if d.chapters.iter().all(|ch| ch.cards.is_empty()) {
            continue;
        }
        preview.decks += 1;
        preview.deck_names.push(d.name.clone());
        for ch in &d.chapters {
            if ch.cards.is_empty() {
                continue;
            }
            preview.chapters += 1;
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
        COALESCE(SUM(CASE WHEN c.next_eligible_seq <= (SELECT COUNT(*) FROM card_show_log)
                           AND c.due_at <= ?1
                           AND c.state NOT IN ('suspended','archived')
                          THEN 1 ELSE 0 END), 0) AS due,
        d.chain_by_order
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
                chain_by_order: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Popup queue (design §4, seq-based). Priority: at most ONE eligible
/// 重点回访卡, then 到期卡 (level 1–2), then 新卡 (session + daily quotas),
/// then 维护卡 (level ≥ 3) to fill. A card appears at most once per popup;
/// fewer candidates means a shorter session; zero means no popup at all.
pub fn due_queue(db: &Db, limit: i64) -> Result<Vec<CardDto>, String> {
    let now = Utc::now();
    let seq = db.show_count().map_err(|e| e.to_string())?;
    let (daily_new, session_new) = new_quotas(db);
    let mut cards: Vec<db::Card> = Vec::new();

    let mut remaining = limit.max(0);
    if remaining == 0 {
        return Ok(Vec::new());
    }

    // 1) 重点回访卡: one per popup (重学配额).
    cards.extend(
        db.attention_candidates(seq, now, 1)
            .map_err(|e| e.to_string())?,
    );
    remaining = limit - cards.len() as i64;

    // 2) 普通到期卡: level 1–2.
    if remaining > 0 {
        cards.extend(
            db.due_candidates(seq, now, remaining)
                .map_err(|e| e.to_string())?,
        );
        remaining = limit - cards.len() as i64;
    }

    // 3) 新卡: session + rolling-24h quotas.
    if remaining > 0 && session_new > 0 && daily_new > 0 {
        let introduced = db
            .new_introduced_since(now - Duration::hours(24))
            .map_err(|e| e.to_string())?;
        let quota = (daily_new - introduced)
            .clamp(0, session_new)
            .min(remaining);
        if quota > 0 {
            cards.extend(
                db.new_candidates(seq, now, quota)
                    .map_err(|e| e.to_string())?,
            );
            remaining = limit - cards.len() as i64;
        }
    }

    // 4) 维护卡补足.
    if remaining > 0 {
        cards.extend(
            db.normal_candidates(seq, now, remaining)
                .map_err(|e| e.to_string())?,
        );
    }

    cards.truncate(limit.max(0) as usize);
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

/// Popup annotation save (SPEC §9.3): content-only write, flagged as a local
/// edit so re-imports keep the annotated version.
pub fn update_card_content(db: &Db, card_id: i64, content_md: &str) -> Result<CardDto, String> {
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    if !db
        .update_card(card_id, &card.title, content_md)
        .map_err(|e| e.to_string())?
    {
        return Err("卡片不存在".into());
    }
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after update".into())
}

/// Dashboard statistics (SPEC §14): counters, level distribution, 7-day chart,
/// streak. Local-day based so "today" matches the user's clock.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDto {
    pub today_reviewed: i64,
    pub due_count: i64,
    pub total_cards: i64,
    pub streak_days: i64,
    pub level_distribution: Vec<i64>,
    /// Oldest → newest, exactly 7 entries.
    pub last7_days: Vec<i64>,
    pub attention_count: i64,
    pub archived_count: i64,
}

pub fn get_stats(db: &Db) -> Result<StatsDto, String> {
    use chrono::{Datelike, Duration as ChronoDuration, Local};

    let today = Local::now().date_naive();
    let cutoff = Utc::now() - ChronoDuration::days(31);
    let by_day: std::collections::HashMap<String, i64> = db
        .review_counts_by_day(cutoff)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let day_key = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

    let today_reviewed = by_day.get(&day_key(today)).copied().unwrap_or(0);
    let mut last7 = Vec::with_capacity(7);
    for back in (0..7).rev() {
        let d = today - ChronoDuration::days(back);
        last7.push(by_day.get(&day_key(d)).copied().unwrap_or(0));
    }

    // Streak: count back from today; a day with no reviews yet doesn't break
    // yesterday's run (you just haven't started today).
    let mut streak = 0i64;
    let mut cursor = today;
    if by_day.get(&day_key(cursor)).copied().unwrap_or(0) == 0 {
        cursor -= ChronoDuration::days(1);
    }
    while by_day.get(&day_key(cursor)).copied().unwrap_or(0) > 0 {
        streak += 1;
        cursor -= ChronoDuration::days(1);
        if cursor.year() < 2000 {
            break; // safety stop
        }
    }

    let seq = db.show_count().map_err(|e| e.to_string())?;
    Ok(StatsDto {
        today_reviewed,
        due_count: db
            .eligible_count(seq, Utc::now())
            .map_err(|e| e.to_string())?,
        total_cards: db.count_by_state("new").map_err(|e| e.to_string())?
            + db.count_by_state("review").map_err(|e| e.to_string())?
            + db.count_by_state("archived").map_err(|e| e.to_string())?,
        streak_days: streak,
        level_distribution: db.level_distribution().map_err(|e| e.to_string())?.to_vec(),
        last7_days: last7,
        attention_count: db.attention_cards().map_err(|e| e.to_string())?.len() as i64,
        archived_count: db.count_by_state("archived").map_err(|e| e.to_string())?,
    })
}

/// 疑难卡列表（SPEC §12.1）: flagged cards with their lapse counts.
pub fn attention_cards(db: &Db) -> Result<Vec<CardDto>, String> {
    Ok(db
        .attention_cards()
        .map_err(|e| e.to_string())?
        .iter()
        .map(to_dto)
        .collect())
}

pub fn clear_attention(db: &Db, card_id: i64) -> Result<CardDto, String> {
    if !db.clear_attention(card_id).map_err(|e| e.to_string())? {
        return Err("卡片不存在或未标记".into());
    }
    card_dto(db, card_id)
}

pub fn reset_progress(db: &Db, card_id: i64) -> Result<CardDto, String> {
    if !db
        .reset_progress(card_id, Utc::now())
        .map_err(|e| e.to_string())?
    {
        return Err("卡片不存在".into());
    }
    card_dto(db, card_id)
}

pub fn restore_card(db: &Db, card_id: i64) -> Result<CardDto, String> {
    if !db
        .restore_card(card_id, Utc::now())
        .map_err(|e| e.to_string())?
    {
        return Err("卡片不在归档状态".into());
    }
    card_dto(db, card_id)
}

fn card_dto(db: &Db, card_id: i64) -> Result<CardDto, String> {
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared".into())
}

/// Review-time linking context (SPEC §11.2): prerequisites shown as
/// "知识铺垫" and the linked follow-up card for "顺链续复习".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardContextDto {
    pub requires: Vec<CardDto>,
    pub next: Option<CardDto>,
    /// Whether the follow-up card may appear right now (seq gate + time floor).
    pub next_eligible: bool,
}

pub fn card_context(db: &Db, card_id: i64) -> Result<CardContextDto, String> {
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let chained = if db.deck_chain_enabled(card_id).map_err(|e| e.to_string())? {
        // Auto-chain: previous neighbour in the same chapter (1 level, SPEC §11.2).
        db.chapter_prev_id(card_id).map_err(|e| e.to_string())?
    } else {
        None
    };

    // Prerequisites: manual links first, then the auto neighbour; deduped.
    // The global "连贯知识铺垫" switch (SPEC §16) can suppress the panel.
    let mut requires: Vec<CardDto> = Vec::new();
    let context_enabled = get_u32(db, "chain_context", 1) != 0;
    let mut seen = std::collections::HashSet::new();
    if context_enabled {
        for id in db.manual_prev_ids(card_id).map_err(|e| e.to_string())? {
            if seen.insert(id) {
                requires.push(card_dto(db, id)?);
            }
        }
        if let Some(prev) = chained {
            if seen.insert(prev) {
                requires.push(card_dto(db, prev)?);
            }
        }
    }

    // Follow-up: first manual next, otherwise the auto neighbour.
    let manual_next = db
        .manual_next_ids(card_id)
        .map_err(|e| e.to_string())?
        .first()
        .copied();
    let next_id = match manual_next {
        Some(id) => Some(id),
        None if db.deck_chain_enabled(card_id).map_err(|e| e.to_string())? => {
            db.chapter_next_id(card_id).map_err(|e| e.to_string())?
        }
        None => None,
    };

    let mut next = None;
    let mut next_eligible = false;
    if let Some(id) = next_id {
        let candidate = db
            .get_card(id)
            .map_err(|e| e.to_string())?
            .ok_or("link target missing")?;
        if candidate.state != "suspended" {
            let seq = db.show_count().map_err(|e| e.to_string())?;
            next_eligible = db
                .is_card_eligible(id, seq, Utc::now())
                .map_err(|e| e.to_string())?;
            next = Some(to_dto(&candidate));
        }
    }

    Ok(CardContextDto {
        requires,
        next,
        next_eligible,
    })
}

/// Manual links only (the card editor in SPEC §11.1 shows these; auto-chain
/// neighbours are computed on the fly and need no editing).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardLinksDto {
    pub prev: Vec<CardDto>,
    pub next: Vec<CardDto>,
}

pub fn card_links(db: &Db, card_id: i64) -> Result<CardLinksDto, String> {
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let mut prev = Vec::new();
    for id in db.manual_prev_ids(card_id).map_err(|e| e.to_string())? {
        prev.push(card_dto(db, id)?);
    }
    let mut next = Vec::new();
    for id in db.manual_next_ids(card_id).map_err(|e| e.to_string())? {
        next.push(card_dto(db, id)?);
    }
    Ok(CardLinksDto { prev, next })
}

/// Add a manual 前置→后置 link (SPEC §11.1). Rejects self-links and any edge
/// that would create a cycle.
pub fn add_card_link(db: &Db, from_id: i64, to_id: i64) -> Result<(), String> {
    if from_id == to_id {
        return Err("不能把卡片连到它自己".into());
    }
    db.get_card(from_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    db.get_card(to_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    // A→B is a cycle when B already (transitively) points back at A.
    if db.link_reaches(to_id, from_id).map_err(|e| e.to_string())? {
        return Err("这两张卡之间已存在链条，会形成环".into());
    }
    db.add_card_link(from_id, to_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_card_link(db: &Db, from_id: i64, to_id: i64) -> Result<(), String> {
    if !db
        .remove_card_link(from_id, to_id)
        .map_err(|e| e.to_string())?
    {
        return Err("关联不存在".into());
    }
    Ok(())
}

/// Per-deck auto-chaining switch (SPEC §11.1 "卡包级开关").
pub fn set_deck_chain(db: &Db, deck: &str, enabled: bool) -> Result<(), String> {
    if !db
        .set_deck_chain(deck, enabled)
        .map_err(|e| e.to_string())?
    {
        return Err("卡包不存在".into());
    }
    Ok(())
}

/// Backup file name for a local date: `data-YYYYMMDD.db` (SPEC §14).
pub fn backup_file_name(date: chrono::NaiveDate) -> String {
    format!("data-{}.db", date.format("%Y%m%d"))
}

/// Files to delete so that only the `keep` newest backups remain.
/// Names sort chronologically (`data-YYYYMMDD.db`), so lexicographic desc wins.
pub fn backups_to_prune(mut names: Vec<String>, keep: usize) -> Vec<String> {
    names.sort();
    names.reverse();
    names.into_iter().skip(keep).collect()
}

pub fn backups_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("backups")
}

fn list_backup_names(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n.starts_with("data-") && n.ends_with(".db"))
        .collect()
}

fn prune_backups(dir: &std::path::Path) {
    for old in backups_to_prune(list_backup_names(dir), 7) {
        let _ = std::fs::remove_file(dir.join(old));
    }
}

/// SPEC §14/F18: once per day on first launch, snapshot the DB into
/// `backups/` and keep the newest 7. Returns the created path (None when a
/// backup for today already exists or backups are disabled).
pub fn daily_backup(db: &Db, data_dir: &std::path::Path) -> Result<Option<String>, String> {
    if get_u32(db, "backup_enabled", 1) == 0 {
        return Ok(None);
    }
    let dir = backups_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(backup_file_name(chrono::Local::now().date_naive()));
    if !path.exists() {
        db.backup_to(&path).map_err(|e| e.to_string())?;
    }
    prune_backups(&dir);
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Manual "立即备份": overwrite today's file and prune (SPEC §14, F18).
pub fn backup_now(db: &Db, data_dir: &std::path::Path) -> Result<String, String> {
    let dir = backups_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(backup_file_name(chrono::Local::now().date_naive()));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    db.backup_to(&path).map_err(|e| e.to_string())?;
    prune_backups(&dir);
    Ok(path.to_string_lossy().to_string())
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

/// Rate a card: scheduler decides (seq-based), then card update + review_log
/// row commit in one transaction (SPEC §17: a crash must never lose a rating).
pub fn rate(db: &mut Db, card_id: i64, rating: &str) -> Result<CardDto, String> {
    let r = rating_from_str(rating).ok_or_else(|| format!("未知评分: {rating}"))?;
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let now = Utc::now();
    let seq = db.show_count().map_err(|e| e.to_string())?;

    let out = scheduler::review(&to_sched(&card), r, seq.max(0) as u64, now, &cfg);
    let lapsed = i64::from(r == Rating::Unknown);
    // SPEC §12.2 自动归档: N consecutive "可以讲出来" retires the card from the
    // rotation (data and level kept; restorable from the deck browser).
    let archive_enabled = get_u32(db, "archive_enabled", 1) != 0;
    let archive_threshold = get_u32(db, "archive_threshold", 3).clamp(2, 5);
    let archived =
        r == Rating::Speakable && archive_enabled && out.speak_streak >= archive_threshold;
    let next_state = if archived { "archived" } else { "review" };
    let tx = db.0.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE card SET state=?11, level=?1, next_eligible_seq=?2, due_at=?3,
         unknown_streak=?4, speak_streak=?5, needs_attention=?6,
         last_review_at=?7, last_seen_seq=?8, reps=reps+1, lapses=lapses+?9
         WHERE id=?10",
        rusqlite::params![
            i64::from(out.level),
            out.next_eligible_seq as i64,
            db::fmt_time(out.earliest_at),
            i64::from(out.unknown_streak),
            i64::from(out.speak_streak),
            i64::from(out.needs_attention),
            db::fmt_time(now),
            seq,
            lapsed,
            card_id,
            next_state,
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
            out.next_eligible_seq.to_string(),
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

/// Card-gap preview per [不了解, 熟悉, 可以讲出来] in cards ("隔 N 张").
pub fn preview_intervals(db: &Db, card_id: i64) -> Result<Vec<u64>, String> {
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    Ok(scheduler::preview(&to_sched(&card), &cfg).to_vec())
}

/// Record that a card was actually shown: advances the global display counter
/// (design §1: 展示时增加) and stamps the card's last_seen_seq.
pub fn mark_shown(db: &Db, card_id: i64) -> Result<(), String> {
    db.insert_show_log(card_id, Utc::now())
        .map_err(|e| e.to_string())?;
    let seq = db.show_count().map_err(|e| e.to_string())?;
    db.mark_seen_seq(card_id, seq).map_err(|e| e.to_string())
}

/// Eligible card count (for tray tooltip, home page and engine tick).
pub fn due_count(db: &Db) -> Result<i64, String> {
    let seq = db.show_count().map_err(|e| e.to_string())?;
    db.eligible_count(seq, Utc::now())
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
        // Show the card first (display advances the global seq).
        mark_shown(&d, dto.id).unwrap();
        let after = rate(&mut d, dto.id, "familiar").unwrap();
        assert_eq!(after.state, "review");
        assert_eq!(after.level, 1, "Familiar lifts a new card to level 1");
        let (n, rating, before, gap): (i64, i64, String, Option<String>) =
            d.0.query_row(
                "SELECT COUNT(*), rating, state_before, scheduled_interval
                 FROM review_log GROUP BY id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((n, rating, before.as_str()), (1, 2, "new"));
        assert_eq!(gap.as_deref(), Some("9"), "seq 1 + familiar gap 8");
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert_eq!(c.next_eligible_seq, 9);
        let floor = c.due_at - Utc::now();
        assert!(
            (floor.num_minutes() - 30).abs() < 5,
            "familiar time floor ~30 min, got {}",
            floor.num_minutes()
        );
        assert_eq!(c.last_seen_seq, 1);
    }

    #[test]
    fn card_cannot_reappear_before_its_seq_gate() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        let b = add_card(&d, "D", "C", "卡B", "x").unwrap();
        // Both are level-1 scheduled cards, gated behind 4 shows.
        for id in [a.id, b.id] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1,
                 next_eligible_seq=4, due_at=?1 WHERE id=?2",
                rusqlite::params![db::fmt_time(Utc::now() - chrono::Duration::minutes(5)), id],
            )
            .unwrap();
        }
        assert!(
            due_queue(&d, 10).unwrap().is_empty(),
            "seq gate not reached"
        );
        // Four other displays open the gate.
        for _ in 0..4 {
            mark_shown(&d, a.id).unwrap();
        }
        let q = due_queue(&d, 10).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["卡B", "卡A"],
            "both eligible now; B has the older last_seen_seq"
        );
    }

    #[test]
    fn pool_priority_and_attention_quota() {
        let d = db();
        let flagged = add_card(&d, "D", "C", "重点卡", "x").unwrap();
        let due = add_card(&d, "D", "C", "到期卡", "x").unwrap();
        let _new = add_card(&d, "D", "C", "新卡", "x").unwrap();
        let normal = add_card(&d, "D", "C", "维护卡", "x").unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=3, needs_attention=1, due_at=?1,
             last_seen_seq=10 WHERE id=?2",
            rusqlite::params![past, flagged.id],
        )
        .unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=2, reps=3, due_at=?1, last_seen_seq=20 WHERE id=?2",
            rusqlite::params![past, due.id],
        )
        .unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=4, reps=9, due_at=?1, last_seen_seq=30 WHERE id=?2",
            rusqlite::params![past, normal.id],
        )
        .unwrap();
        let q = due_queue(&d, 4).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["重点卡", "到期卡", "新卡", "维护卡"],
            "priority: attention → due → new → maintenance"
        );
    }

    #[test]
    fn attention_cards_capped_to_one_per_popup() {
        let d = db();
        let a = add_card(&d, "D", "C", "重点1", "x").unwrap();
        let b = add_card(&d, "D", "C", "重点2", "x").unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        for id in [a.id, b.id] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=3, needs_attention=1,
                 due_at=?1 WHERE id=?2",
                rusqlite::params![past, id],
            )
            .unwrap();
        }
        let q = due_queue(&d, 5).unwrap();
        assert_eq!(q.len(), 1, "only one 重点回访卡 per popup");
    }

    #[test]
    fn time_floor_blocks_early_reappearance() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        // Seq gate open, but the 10-minute floor is still ahead.
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
             due_at=?1 WHERE id=?2",
            rusqlite::params![
                db::fmt_time(Utc::now() + chrono::Duration::minutes(5)),
                a.id
            ],
        )
        .unwrap();
        assert!(due_queue(&d, 10).unwrap().is_empty());
    }

    #[test]
    fn rate_unknown_rating_errors() {
        let mut d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        assert!(rate(&mut d, dto.id, "excellent").is_err());
    }

    #[test]
    fn due_queue_orders_oldest_seen_first() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        let b = add_card(&d, "D", "C", "卡B", "x").unwrap();
        // Both eligible level-1 cards; A was seen longer ago.
        for (id, last_seen) in [(a.id, 1), (b.id, 9)] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=2, last_seen_seq=?1,
                 due_at=?2 WHERE id=?3",
                rusqlite::params![
                    last_seen,
                    db::fmt_time(Utc::now() - chrono::Duration::minutes(5)),
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
    fn shown_cards_advance_their_last_seen_stamp() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        mark_shown(&d, a.id).unwrap();
        mark_shown(&d, a.id).unwrap();
        let c = d.get_card(a.id).unwrap().unwrap();
        assert_eq!(c.last_seen_seq, 2, "global display counter advanced");
        assert_eq!(d.show_count().unwrap(), 2);
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
            vec![3, 8, 20],
            "new card: unknown 3 cards, familiar 8, speakable 20"
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
    fn popup_annotation_save_marks_local_edit_and_survives_reimport() {
        let d = db();
        let files = vec![ImportFile {
            name: "notes.md".into(),
            content: "# D\n\n## C\n\n### 卡\n原始内容\n".into(),
        }];
        import_markdown(&d, &files, false).unwrap();
        let id =
            d.0.query_row("SELECT id FROM card WHERE title='卡'", [], |r| r.get(0))
                .unwrap();
        let after = update_card_content(&d, id, "原始内容 ==重点== %%我的批注%%").unwrap();
        assert!(after.content_md.contains("我的批注"));
        let card = d.get_card(id).unwrap().unwrap();
        assert!(
            card.locally_edited,
            "annotation save must set the local-edit flag"
        );
        // Re-importing the same file keeps the annotated version.
        let report = import_markdown(&d, &files, false).unwrap();
        assert_eq!(report.conflicts, 1);
        let card = d.get_card(id).unwrap().unwrap();
        assert!(card.content_md.contains("我的批注"));
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
        // Defaults: unknown 3, familiar 8, speakable 20.
        assert_eq!(preview_intervals(&d, c.id).unwrap(), vec![3, 8, 20]);
        // Custom card gaps and level table flow into the preview.
        set_settings(
            &d,
            &[
                ("gap_unknown".into(), "6".into()),
                ("level_gaps".into(), "1,2,4,8,16,32".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            preview_intervals(&d, c.id).unwrap(),
            vec![6, 8, 20],
            "custom unknown gap; familiar/speakable keep their minimums"
        );
        // Level-based gaps apply to scheduled cards.
        rate(&mut d, c.id, "speakable").unwrap(); // level 1
        let p = preview_intervals(&d, c.id).unwrap();
        assert_eq!(p[1], 8, "familiar from level 1: max(level_gap[1]=2, 8)");
        assert_eq!(p[2], 20, "speakable to level 2: max(level_gap[2]=4, 20)");
    }

    // ---- dashboard & leech/archive loop (M2) ----

    fn local_noon_utc(days_ago: i64) -> chrono::DateTime<Utc> {
        use chrono::{Local, TimeZone};
        let day = Local::now().date_naive() - chrono::Duration::days(days_ago);
        Local
            .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
            .unwrap()
            .with_timezone(&Utc)
    }

    fn insert_log(db: &Db, card_id: i64, rating: i64, at: chrono::DateTime<Utc>) {
        db.0.execute(
            "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
             VALUES(?1, ?2, 'review', ?3)",
            rusqlite::params![card_id, rating, db::fmt_time(at)],
        )
        .unwrap();
    }

    #[test]
    fn stats_count_today_levels_and_chart() {
        let mut d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        add_card(&d, "D", "C", "卡B", "x").unwrap();
        rate(&mut d, a.id, "familiar").unwrap(); // today's review + level 1

        let s = get_stats(&d).unwrap();
        assert_eq!(s.today_reviewed, 1);
        assert_eq!(s.last7_days.len(), 7);
        assert_eq!(s.last7_days[6], 1, "newest day is today");
        assert_eq!(s.streak_days, 1);
        assert_eq!(s.total_cards, 2);
        let dist_sum: i64 = s.level_distribution.iter().sum();
        assert_eq!(dist_sum, 2);
        assert_eq!(s.level_distribution[1], 1, "one card moved to level 1");
        assert_eq!(s.level_distribution[0], 1, "the other is still new");
    }

    #[test]
    fn streak_walks_back_consecutive_days_only() {
        let d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        for days_ago in [0, 1, 2, 5] {
            insert_log(&d, c.id, 2, local_noon_utc(days_ago));
        }
        let s = get_stats(&d).unwrap();
        assert_eq!(s.streak_days, 3, "today+yesterday+2 days ago, then a gap");
        assert_eq!(
            s.last7_days[1], 1,
            "5 days ago = index 1 of the 7-day window"
        );
    }

    #[test]
    fn archive_after_three_speakable_and_restore() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        for _ in 0..3 {
            rate(&mut d, c.id, "speakable").unwrap();
        }
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(
            card.state, "archived",
            "3 consecutive Speakable retires the card"
        );
        assert_eq!(card.level, 3, "level kept for restore");
        assert_eq!(get_stats(&d).unwrap().archived_count, 1);

        // Archived cards leave the rotation…
        assert!(due_queue(&d, 10).unwrap().is_empty());
        // …and come back unchanged.
        let restored = restore_card(&d, c.id).unwrap();
        assert_eq!(restored.state, "review");
        assert_eq!(restored.level, 3);
        assert_eq!(due_queue(&d, 10).unwrap().len(), 1);
    }

    #[test]
    fn archive_respects_threshold_and_switch() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // Disabled switch: never archives.
        set_settings(&d, &[("archive_enabled".into(), "0".into())]).unwrap();
        for _ in 0..4 {
            rate(&mut d, c.id, "speakable").unwrap();
        }
        assert_eq!(d.get_card(c.id).unwrap().unwrap().state, "review");

        // Smaller threshold (2) archives sooner.
        set_settings(
            &d,
            &[
                ("archive_enabled".into(), "1".into()),
                ("archive_threshold".into(), "2".into()),
            ],
        )
        .unwrap();
        rate(&mut d, c.id, "speakable").unwrap(); // streak 5 ≥ 2
        assert_eq!(d.get_card(c.id).unwrap().unwrap().state, "archived");
    }

    #[test]
    fn attention_list_clear_and_reset() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "难题", "x").unwrap();
        let good = add_card(&d, "D", "C", "好题", "x").unwrap();
        rate(&mut d, good.id, "familiar").unwrap();
        for _ in 0..3 {
            rate(&mut d, c.id, "unknown").unwrap();
        }
        let flagged = d.get_card(c.id).unwrap().unwrap();
        assert!(flagged.needs_attention);

        let list = attention_cards(&d).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "难题");
        assert_eq!(list[0].lapses, 3, "lapse count travels with the DTO");
        assert_eq!(get_stats(&d).unwrap().attention_count, 1);

        // Clear the flag without touching scheduling.
        let cleared = clear_attention(&d, c.id).unwrap();
        assert!(!cleared.needs_attention);
        assert!(attention_cards(&d).unwrap().is_empty());

        // Reset progress: back to level 1, streaks and lapses wiped.
        let reset = reset_progress(&d, c.id).unwrap();
        assert_eq!(reset.level, 1);
        let raw = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(
            (raw.lapses, raw.unknown_streak, raw.needs_attention),
            (0, 0, false)
        );
    }

    #[test]
    fn backup_naming_and_pruning() {
        use chrono::NaiveDate;
        assert_eq!(
            backup_file_name(NaiveDate::from_ymd_opt(2026, 9, 29).unwrap()),
            "data-20260929.db"
        );
        let names: Vec<String> = ["data-20260901.db", "data-20260910.db", "data-20260905.db"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            backups_to_prune(names, 2),
            vec!["data-20260901.db"],
            "only the oldest beyond the keep window is pruned"
        );
    }

    #[test]
    fn daily_backup_snapshots_a_restorable_db() {
        let dir =
            std::env::temp_dir().join(format!("flashmemo-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let d = Db::open(&dir.join("data.db")).unwrap();
        add_card(&d, "D", "C", "备份卡", "内容").unwrap();

        let path = daily_backup(&d, &dir).unwrap().unwrap();
        assert!(std::path::Path::new(&path).exists());
        // Same day: second call reuses today's file instead of stacking copies.
        assert_eq!(daily_backup(&d, &dir).unwrap().unwrap(), path);

        // The snapshot is a valid database containing our card.
        let snap = Db::open(std::path::Path::new(&path)).unwrap();
        let count: i64 = snap
            .0
            .query_row("SELECT COUNT(*) FROM card", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chain_context_lists_auto_neighbours() {
        let d = db();
        let a = add_card(&d, "D", "C", "第一", "x").unwrap();
        let b = add_card(&d, "D", "C", "第二", "x").unwrap();
        let c = add_card(&d, "D", "C", "第三", "x").unwrap();

        let ctx = card_context(&d, b.id).unwrap();
        assert_eq!(
            ctx.requires
                .iter()
                .map(|r| r.title.as_str())
                .collect::<Vec<_>>(),
            ["第一"],
            "auto-chain: previous card in the chapter"
        );
        assert_eq!(ctx.next.as_ref().unwrap().title, "第三");
        assert!(ctx.next_eligible, "fresh cards are eligible immediately");

        // First card has no predecessor; last has no successor.
        assert!(card_context(&d, a.id).unwrap().requires.is_empty());
        assert!(card_context(&d, c.id).unwrap().next.is_none());
    }

    #[test]
    fn manual_links_override_auto_next_and_cycle_is_rejected() {
        let d = db();
        let a = add_card(&d, "D", "C", "A", "x").unwrap();
        let b = add_card(&d, "D", "C", "B", "x").unwrap();
        let c = add_card(&d, "D", "C", "C", "x").unwrap();

        // Manual A→C overrides the auto neighbour B.
        add_card_link(&d, a.id, c.id).unwrap();
        let ctx = card_context(&d, a.id).unwrap();
        assert_eq!(ctx.next.as_ref().unwrap().title, "C");

        // Cycle guard: C→A would close the loop A→C→A.
        assert!(add_card_link(&d, c.id, a.id).is_err());
        // 3-cycle via a new edge C→…→A path.
        add_card_link(&d, c.id, b.id).unwrap();
        assert!(
            add_card_link(&d, b.id, a.id).is_err(),
            "B→A would create A→C→B→A"
        );
        // Self link rejected.
        assert!(add_card_link(&d, a.id, a.id).is_err());

        remove_card_link(&d, a.id, c.id).unwrap();
        let ctx = card_context(&d, a.id).unwrap();
        assert_eq!(ctx.next.as_ref().unwrap().title, "B", "auto next returns");
    }

    #[test]
    fn deck_chain_switch_disables_auto_neighbours() {
        let d = db();
        add_card(&d, "D", "C", "第一", "x").unwrap();
        let b = add_card(&d, "D", "C", "第二", "x").unwrap();
        set_deck_chain(&d, "D", false).unwrap();
        let ctx = card_context(&d, b.id).unwrap();
        assert!(ctx.requires.is_empty());
        assert!(ctx.next.is_none());
        set_deck_chain(&d, "D", true).unwrap();
        assert_eq!(card_context(&d, b.id).unwrap().requires.len(), 1);
    }

    #[test]
    fn context_next_eligibility_follows_seq_gate() {
        let d = db();
        add_card(&d, "D", "C", "第一", "x").unwrap();
        let b = add_card(&d, "D", "C", "第二", "x").unwrap();
        // Gate the follow-up behind 50 shown cards.
        d.0.execute(
            "UPDATE card SET next_eligible_seq = 50 WHERE id = ?1",
            [b.id],
        )
        .unwrap();
        let ctx = card_context(&d, b.id).unwrap();
        assert!(ctx.next.is_none(), "no successor for the last card");
        let a_ctx = card_context(
            &d,
            d.0.query_row("SELECT id FROM card WHERE title='第一'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        )
        .unwrap();
        assert!(!a_ctx.next_eligible, "gated card is not eligible yet");
        assert!(a_ctx.next.is_some());
    }

    #[test]
    fn context_panel_switch_hides_prerequisites_only() {
        let d = db();
        add_card(&d, "D", "C", "第一", "x").unwrap();
        let b = add_card(&d, "D", "C", "第二", "x").unwrap();
        set_settings(&d, &[("chain_context".into(), "0".into())]).unwrap();
        let ctx = card_context(&d, b.id).unwrap();
        assert!(ctx.requires.is_empty(), "panel switch hides 知识铺垫");
        // Follow-up continuation is unaffected.
        let a_ctx = card_context(
            &d,
            d.0.query_row("SELECT id FROM card WHERE title='第一'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        )
        .unwrap();
        assert!(a_ctx.next.is_some());
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
