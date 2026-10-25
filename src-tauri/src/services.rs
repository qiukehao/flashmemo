//! Service layer: business orchestration over db + parser + scheduler. All
//! functions here are plain Rust (no Tauri types) so they are directly testable
//! against an in-memory database. `commands.rs` is a thin invoke wrapper.

use crate::db::{self, Card, Db, NewCard};
use crate::import::{self, ImportReport};
use crate::parser::{parse_markdown, ParsedDeck};
use crate::scheduler::{self, CardSched, Rating, ScheduleConfig};
use chrono::{Duration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDto {
    pub id: i64,
    pub deck: String,
    pub chapter: String,
    pub title: String,
    pub content_md: String,
    /// 题面 (SPEC §5.2 rule 10, 需求7) → serde `frontMd`. Empty = render `title`.
    pub front_md: String,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub name: String,
    pub content: String,
    /// Absolute path of the picked `.md`, when the native dialog provided one:
    /// relative image refs resolve against its folder (SPEC §5.4). Browser-mock
    /// imports have no path and keep their refs untouched.
    #[serde(default)]
    pub path: Option<String>,
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
        front_md: c.front_md.clone(),
        state: c.state.clone(),
        due_at: db::fmt_time(c.due_at),
        needs_attention: c.needs_attention,
        level: c.level.max(0) as u32,
        lapses: c.lapses,
    }
}

fn to_sched(c: &Card, today: &str) -> CardSched {
    CardSched {
        level: c.level.max(0) as u32,
        next_eligible_seq: c.next_eligible_seq.max(0) as u64,
        unknown_streak: c.unknown_streak.max(0) as u32,
        speak_streak: c.speak_streak.max(0) as u32,
        needs_attention: c.needs_attention,
        lapses: c.lapses.max(0) as u32,
        leveled_up_today: c.level_up_day.as_deref() == Some(today),
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
    cfg.attention_lapses = get_u32(db, "attention_lapses", 4).max(2);
    cfg
}

/// New-card quotas: (每日上限, 每次会话上限). Daily default 15 (2026-10-04
/// review: 5/day means 100 days for a 500-card exam deck — too slow).
fn new_quotas(db: &Db) -> (i64, i64) {
    let daily_new = get_u32(db, "daily_new_limit", 15) as i64;
    let session_new = get_u32(db, "session_new_limit", 1).clamp(0, 10) as i64;
    (daily_new, session_new)
}

/// 每次弹窗卡片数 (SPEC §7.4/§16) — **the only** accessor. The three readers
/// (popup queue, engine cadence plan, home-page goal bar) used to hard-code
/// different fallbacks (1 / 3 / 3), so an unset key meant a 1-card popup while
/// the home page promised 3 — the user's "设了 4 张却弹 1 张" (2026-10-06 F4).
/// The value is clamped to the documented range, so a hand-edited 0 / 99 / junk
/// can never produce an empty or unbounded session.
pub const PER_POPUP_DEFAULT: i64 = 3;
pub const PER_POPUP_MIN: i64 = 1;
pub const PER_POPUP_MAX: i64 = 5;

pub fn per_popup_size(db: &Db) -> i64 {
    (get_u32(db, "per_popup", PER_POPUP_DEFAULT as u32) as i64).clamp(PER_POPUP_MIN, PER_POPUP_MAX)
}

/// Upper bound of one popup session (SPEC §7.4): the user's 每次弹窗卡片数,
/// capped by the dodge penalty (`engine::EngineShared::session_size_override`,
/// 1 while the 逃避链 is hot). The penalty is a **cap, never an override** —
/// `session_size(1, 3) == 1` — it can only make a session shorter than what the
/// user asked for, and it applies to auto popups only (manual entries serve
/// their explicit card list in full).
pub fn session_size(per_popup: i64, dodge_cap: i64) -> i64 {
    let n = per_popup.clamp(PER_POPUP_MIN, PER_POPUP_MAX);
    if dodge_cap > 0 {
        n.min(dodge_cap.clamp(PER_POPUP_MIN, PER_POPUP_MAX))
    } else {
        n
    }
}

pub fn add_card(
    db: &Db,
    deck: &str,
    chapter: &str,
    title: &str,
    content_md: &str,
) -> Result<CardDto, String> {
    add_card_with_front(db, deck, chapter, title, content_md, "")
}

/// Manual card creation with an explicit 题面 (SPEC §5.2 rules 10/13, 需求7).
///
/// `title` is optional: when blank it is derived from the 题面's single-line
/// projection (SPEC §15.1) — that is the "长/图片题面 + 结构化答案" flow, where
/// the user writes a question but no separate heading. A wordless 题面 projects
/// to `🖼`, so the resolved title is disambiguated against its chapter
/// (`unique_title`) instead of tripping `UNIQUE(chapter_id, title)`.
pub fn add_card_with_front(
    db: &Db,
    deck: &str,
    chapter: &str,
    title: &str,
    content_md: &str,
    front_md: &str,
) -> Result<CardDto, String> {
    let deck = deck.trim();
    let chapter = chapter.trim();
    let base = if title.trim().is_empty() {
        crate::parser::front_title_projection(front_md)
    } else {
        title.trim().to_string()
    };
    if base.is_empty() {
        return Err("卡片标题不能为空".into());
    }
    let title = unique_title(db, deck, chapter, &base)?;
    let id = db
        .insert_card(
            &NewCard {
                deck: deck.to_string(),
                chapter: chapter.to_string(),
                title,
                content_md: content_md.to_string(),
                front_md: front_md.to_string(),
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

/// First free `title`, then `title #2`, `title #3`… inside the chapter. Manual
/// creation only — import must keep matching the raw title for idempotency.
fn unique_title(db: &Db, deck: &str, chapter: &str, base: &str) -> Result<String, String> {
    let taken = |t: &str| {
        db.card_title_exists(deck, chapter, t)
            .map_err(|e| e.to_string())
    };
    if !taken(base)? {
        return Ok(base.to_string());
    }
    for n in 2..=99 {
        let candidate = format!("{base} #{n}");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!("同一章节内「{base}」的同名卡片过多，请换个标题"))
}

pub fn import_markdown(
    db: &Db,
    files: &[ImportFile],
    prefer_file: bool,
) -> Result<ImportReport, String> {
    // Attachment copies happen here (not in preview): a file we cannot resolve
    // is left as-is, so a missing APPDATA only degrades images, never the import.
    let store = crate::attachments::store_dir()
        .inspect_err(|e| log::warn!("[attachments] {e}; importing without image copies"))
        .ok();
    import_markdown_with_store(db, files, prefer_file, store.as_deref())
}

/// Import core with an explicit attachment folder (tests use a temp dir).
fn import_markdown_with_store(
    db: &Db,
    files: &[ImportFile],
    prefer_file: bool,
    store: Option<&std::path::Path>,
) -> Result<ImportReport, String> {
    let decks = parse_files(files, store);
    import::import(db, &decks, None, prefer_file).map_err(|e| e.to_string())
}

/// Parse without inserting: SPEC §5.3 import preview (N decks / M chapters / K
/// cards), plus how many locally-edited cards would conflict.
pub fn preview_import(db: &Db, files: &[ImportFile]) -> Result<ImportPreview, String> {
    // Preview must not write anything: parse with image refs untouched.
    let decks = parse_files(files, None);
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

/// Read picked `.md` files off disk (the native dialog returns paths, not
/// contents) so each import carries the folder its image refs resolve against.
pub fn read_markdown_files(paths: &[String]) -> Result<Vec<ImportFile>, String> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let p = std::path::Path::new(path);
        let bytes = std::fs::read(p).map_err(|e| format!("读取 {} 失败：{e}", p.display()))?;
        files.push(ImportFile {
            name: p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("未命名.md")
                .to_string(),
            content: String::from_utf8_lossy(&bytes).into_owned(),
            path: Some(path.clone()),
        });
    }
    Ok(files)
}

fn parse_files(files: &[ImportFile], store: Option<&std::path::Path>) -> Vec<ParsedDeck> {
    let mut decks = Vec::new();
    for f in files {
        let stem = std::path::Path::new(&f.name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名卡包")
            .to_string();
        let mut parsed = parse_markdown(&f.content, &stem);
        // SPEC §5.4: copy the images this note references and rewrite the card
        // markdown to `attachment:` refs. Only possible when we know the .md's
        // folder (native picker) and the attachment store is available.
        if let (Some(store), Some(path)) = (store, f.path.as_deref()) {
            let Some(base) = std::path::Path::new(path).parent() else {
                return parsed;
            };
            for deck in &mut parsed {
                for chapter in &mut deck.chapters {
                    for card in &mut chapter.cards {
                        // SPEC §5.3: a 题面卡's images follow the same rule as the
                        // back's — `front_md` is card content too, so its refs must
                        // be copied into the attachment store and rewritten.
                        card.front_md =
                            crate::attachments::rewrite_refs(&card.front_md, base, store);
                        card.title = crate::attachments::rewrite_refs(&card.title, base, store);
                        card.content_md =
                            crate::attachments::rewrite_refs(&card.content_md, base, store);
                    }
                }
            }
        }
        decks.extend(parsed);
    }
    decks
}

pub fn list_overview(db: &Db) -> Result<Vec<DeckOverview>, String> {
    // Per-deck due count = the one due predicate (SPEC §14), so the deck numbers
    // always add up to the home page's 「待复习」. This used to be a second
    // hand-written copy of the same SQL.
    let sql = format!(
        "SELECT d.name,
        COUNT(DISTINCT ch.id) AS chapters,
        COUNT(c.id) AS cards,
        COALESCE(SUM(CASE WHEN {} THEN 1 ELSE 0 END), 0) AS due,
        d.chain_by_order
        FROM deck d
        LEFT JOIN chapter ch ON ch.deck_id = d.id
        LEFT JOIN card c ON c.chapter_id = ch.id
        GROUP BY d.id ORDER BY d.name",
        Db::due_predicate(1, 2)
    );
    let mut stmt = db.0.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                db.show_count().map_err(|e| e.to_string())?,
                db::fmt_time(Utc::now())
            ],
            |r| {
                Ok(DeckOverview {
                    name: r.get(0)?,
                    chapter_count: r.get(1)?,
                    card_count: r.get(2)?,
                    due_count: r.get(3)?,
                    chain_by_order: r.get::<_, i64>(4)? != 0,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Popup queue (design §4, seq-based). Priority: at most ONE eligible
/// 重点回访卡, then 到期卡 (level 1–2), then 新卡 (session + daily quotas),
/// then 维护卡 (level ≥ 3) to fill. A card appears at most once per popup;
/// fewer candidates means a shorter session; zero means no popup at all.
///
/// The session is `min(limit, 交错规则允许的候选数)` (SPEC §7.4). To keep that
/// promise the pools are over-fetched (`pool_slots`) and truncated to `limit`
/// only *after* `diversify` — truncating first meant a priority window full of
/// same-chapter cards silently ended the session short while further eligible
/// cards existed.
///
/// `roll ∈ [0,1)` drives the randomness deterministically (tests inject it;
/// production passes nanos): `roll < 0.15` opens the 归档抽查 slot, and the
/// same roll normalized into [0,1) picks the weighted archived card.
pub fn due_queue(db: &Db, limit: i64, roll: f64) -> Result<Vec<CardDto>, String> {
    let now = Utc::now();
    let seq = db.show_count().map_err(|e| e.to_string())?;
    let (daily_new, session_new) = new_quotas(db);
    let mut cards: Vec<db::Card> = Vec::new();

    // The session the caller asked for, and the (larger) number of pool rows
    // it may look at. Only the lookahead differs between the two: the new-card
    // quota and the fallback trigger stay keyed to the session, so nothing else
    // about the pool priority changes.
    let target = limit.max(0);
    if target == 0 {
        return Ok(Vec::new());
    }
    let slots = pool_slots(target);

    // 1) 重点回访卡: one per popup (重学配额).
    cards.extend(
        db.attention_candidates(seq, now, 1)
            .map_err(|e| e.to_string())?,
    );
    let mut remaining = slots - cards.len() as i64;

    // 2) 普通到期卡: levels 1–2, most-overdue first.
    if remaining > 0 {
        cards.extend(
            db.due_candidates(seq, now, remaining)
                .map_err(|e| e.to_string())?,
        );
        remaining = slots - cards.len() as i64;
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
            remaining = slots - cards.len() as i64;
        }
    }

    // 4) 归档抽查: 15% of popups carry one archived card, picked with weight
    // proportional to how long it has been out of sight (2026-10-04 rework).
    if remaining > 0 && roll < SPOT_CHECK_CHANCE {
        let archived = db.archived_cards().map_err(|e| e.to_string())?;
        let now_ts = now;
        let weighted: Vec<(i64, f64)> = archived
            .iter()
            .map(|c| {
                let age_days = c
                    .last_review_at
                    .map(|l| (now_ts - l).num_days().max(0) as f64)
                    .unwrap_or(30.0);
                (c.id, age_days + 1.0 + c.spot_bias as f64)
            })
            .collect();
        if let Some(id) =
            pick_spotcheck((roll / SPOT_CHECK_CHANCE).clamp(0.0, 0.999_999), &weighted)
        {
            if let Some(card) = archived.iter().find(|c| c.id == id) {
                cards.push(card.clone());
            }
        }
    }

    // 5) 维护卡补足.
    if remaining > 0 {
        cards.extend(
            db.normal_candidates(seq, now, remaining)
                .map_err(|e| e.to_string())?,
        );
    }

    // 6) 池空兜底 (2026-10-04 rework): few cards + frequent reviews can leave
    // every gate closed and the counter frozen. Hand out the cards closest to
    // their seq gate (time floors still respected) so the app never stalls.
    // Still keyed to `target`: the lookahead rows are not extra candidates, so
    // the rescue must not fire just because they exist.
    if cards.len() < target as usize {
        let picked: Vec<i64> = cards.iter().map(|c| c.id).collect();
        let need = target - cards.len() as i64;
        let fallback = db
            .fallback_candidates(seq, now, need)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|c| !picked.contains(&c.id));
        cards.extend(fallback);
    }

    cards.truncate(slots as usize);
    // 交错 (2026-10-04 review): 同章节最多 2 张, 关联卡不同场 — 前一张会泄露
    // 后一张的答案. Dropped cards simply wait for the next popup.
    let ids: Vec<i64> = cards.iter().map(|c| c.id).collect();
    let links = db.links_among(&ids).map_err(|e| e.to_string())?;
    // Only now is the session cut to the requested size: everything the
    // diversifier dropped has already been replaced from the lookahead.
    let mut picked = diversify(cards, &links, 2);
    picked.truncate(target as usize);
    Ok(picked.iter().map(to_dto).collect())
}

/// Pool over-fetch for one popup: how many candidates `due_queue` reads so the
/// diversifier can replace what it drops (SPEC §7.4 caps 同章节 at 2 of any run,
/// so twice the session plus a margin covers the realistic collisions). This is
/// a read-ahead, not a scheduling rule: the session size stays `min(N, 候选)`.
fn pool_slots(target: i64) -> i64 {
    target.saturating_mul(2) + 2
}

/// 每次弹窗抽到一张归档卡的概率 (2026-10-04 rework, 大师规则 15%).
pub const SPOT_CHECK_CHANCE: f64 = 0.15;

/// Weighted pick among archived cards: `roll ∈ [0,1)` walks the cumulative
/// weights — the heavier (longer unseen / higher bias) a card, the more of the
/// roll space it owns.
fn pick_spotcheck(roll: f64, weighted: &[(i64, f64)]) -> Option<i64> {
    let total: f64 = weighted.iter().map(|(_, w)| w.max(0.0)).sum();
    if total <= 0.0 {
        return None;
    }
    let mut acc = roll.clamp(0.0, 0.999_999) * total;
    for (id, w) in weighted {
        acc -= w.max(0.0);
        if acc < 0.0 {
            return Some(*id);
        }
    }
    weighted.last().map(|(id, _)| *id)
}

/// Popup diversity: at most `max_per_chapter` cards from one (deck, chapter),
/// and never two directly-linked cards in the same session. Priority order is
/// kept; skipped cards fall out of this popup and reappear in the next one.
fn diversify(cards: Vec<Card>, links: &[(i64, i64)], max_per_chapter: usize) -> Vec<Card> {
    let neighbours = |id: i64| {
        links
            .iter()
            .filter_map(|(a, b)| {
                if *a == id {
                    Some(*b)
                } else if *b == id {
                    Some(*a)
                } else {
                    None
                }
            })
            .collect::<Vec<i64>>()
    };
    let mut picked: Vec<Card> = Vec::new();
    let mut picked_ids: HashSet<i64> = HashSet::new();
    let mut chapter_counts: HashMap<(String, String), usize> = HashMap::new();
    for card in cards {
        let key = (card.deck.clone(), card.chapter.clone());
        let count = chapter_counts.get(&key).copied().unwrap_or(0);
        if count >= max_per_chapter {
            continue;
        }
        if neighbours(card.id).iter().any(|n| picked_ids.contains(n)) {
            continue;
        }
        chapter_counts.insert(key, count + 1);
        picked_ids.insert(card.id);
        picked.push(card);
    }
    picked
}

/// "学新卡" (home page): an explicit new-card session. The per-session quota
/// does not apply — the user asked for this session outright — but the daily
/// cap (§7.4) still holds so the regular popup cadence is not over-fed.
pub fn new_cards_queue(db: &Db) -> Result<Vec<CardDto>, String> {
    let now = Utc::now();
    let (daily_new, _) = new_quotas(db);
    if daily_new == 0 {
        return Err("每日新卡上限为 0，请到设置中开启新卡引入".into());
    }
    let introduced = db
        .new_introduced_since(now - Duration::hours(24))
        .map_err(|e| e.to_string())?;
    let quota = (daily_new - introduced).max(0);
    if quota == 0 {
        return Err(format!(
            "今日新卡已学完（每日上限 {daily_new} 张），明天再来"
        ));
    }
    let seq = db.show_count().map_err(|e| e.to_string())?;
    let cards = db
        .new_candidates(seq, now, quota)
        .map_err(|e| e.to_string())?;
    if cards.is_empty() {
        return Err("没有待学习的新卡，先去添加或导入几张吧".into());
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
    update_card_with_front(db, card_id, title, content_md, None)
}

/// Full UI edit. `front_md: None` leaves the 题面 untouched — the popup's
/// back-side annotation path goes through here and must never wipe it; passing
/// `Some("")` clears it explicitly (SPEC §5.2/§9.3).
pub fn update_card_with_front(
    db: &Db,
    card_id: i64,
    title: &str,
    content_md: &str,
    front_md: Option<&str>,
) -> Result<CardDto, String> {
    if title.trim().is_empty() {
        return Err("卡片标题不能为空".into());
    }
    if !db
        .update_card(card_id, title.trim(), content_md, front_md)
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
        .update_card(card_id, &card.title, content_md, None)
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
    /// Local-day review totals for the dashboard heatmap.
    pub review_heatmap: Vec<ReviewDayDto>,
    pub attention_count: i64,
    pub archived_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDayDto {
    pub date: String,
    pub count: i64,
}

pub fn get_stats(db: &Db) -> Result<StatsDto, String> {
    use chrono::{Datelike, Duration as ChronoDuration};

    // "Today" is the study day (04:00 roll) — the same key the goal panel and
    // the engine quota use, so the two counters on one screen always agree.
    let today_key = db::study_day_of(Utc::now());
    let today =
        chrono::NaiveDate::parse_from_str(&today_key, "%Y-%m-%d").map_err(|e| e.to_string())?;
    let cutoff = Utc::now() - ChronoDuration::days(370);
    let by_day: std::collections::HashMap<String, i64> = db
        .review_counts_by_day(cutoff)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let day_key = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

    let today_reviewed = by_day.get(&today_key).copied().unwrap_or(0);
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

    Ok(StatsDto {
        today_reviewed,
        // SPEC §14: the home page's 「待复习」 is the one due count — no local
        // copy of the predicate here any more (2026-10-06 F5).
        due_count: due_count(db)?,
        total_cards: db.count_by_state("new").map_err(|e| e.to_string())?
            + db.count_by_state("review").map_err(|e| e.to_string())?
            + db.count_by_state("archived").map_err(|e| e.to_string())?,
        streak_days: streak,
        level_distribution: db.level_distribution().map_err(|e| e.to_string())?.to_vec(),
        last7_days: last7,
        review_heatmap: by_day
            .iter()
            .map(|(date, count)| ReviewDayDto {
                date: date.clone(),
                count: *count,
            })
            .collect(),
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

/// Immediate linked neighbours of a card (SPEC §11.4): manual 前置/后置 edges
/// plus, when the deck auto-chains, the chapter neighbours. One hop only;
/// suspended/archived cards are excluded.
fn linked_neighbours(db: &Db, card_id: i64) -> Result<Vec<i64>, String> {
    let mut candidates = db.manual_prev_ids(card_id).map_err(|e| e.to_string())?;
    candidates.extend(db.manual_next_ids(card_id).map_err(|e| e.to_string())?);
    if db.deck_chain_enabled(card_id).map_err(|e| e.to_string())? {
        candidates.extend(db.chapter_prev_id(card_id).map_err(|e| e.to_string())?);
        candidates.extend(db.chapter_next_id(card_id).map_err(|e| e.to_string())?);
    }
    let mut ids = Vec::new();
    for id in candidates {
        if id == card_id || ids.contains(&id) {
            continue;
        }
        if let Some(c) = db.get_card(id).map_err(|e| e.to_string())? {
            if c.state != "suspended" && c.state != "archived" {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

/// Chain archive gate (SPEC §11.4): every immediate neighbour must have
/// mastered the card too (threshold reached) or already be archived. Cards the
/// user deleted (suspended) never block.
fn neighbours_all_mastered(db: &Db, card_id: i64, threshold: u32) -> Result<bool, String> {
    let mut candidates = db.manual_prev_ids(card_id).map_err(|e| e.to_string())?;
    candidates.extend(db.manual_next_ids(card_id).map_err(|e| e.to_string())?);
    if db.deck_chain_enabled(card_id).map_err(|e| e.to_string())? {
        candidates.extend(db.chapter_prev_id(card_id).map_err(|e| e.to_string())?);
        candidates.extend(db.chapter_next_id(card_id).map_err(|e| e.to_string())?);
    }
    for id in candidates {
        if id == card_id {
            continue;
        }
        let Some(c) = db.get_card(id).map_err(|e| e.to_string())? else {
            continue;
        };
        if c.state == "suspended" || c.state == "archived" {
            continue;
        }
        if (c.speak_streak.max(0) as u32) < threshold {
            return Ok(false);
        }
    }
    Ok(true)
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

/// One card by id — the "jump to editor" path from the popup's 知识铺垫.
pub fn card(db: &Db, card_id: i64) -> Result<CardDto, String> {
    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "卡片不存在".into())
}

/// Explicit-card review session: the popup consumes the pending id list once
/// (set by "复习选中/复习该包"), otherwise falls back to the due queue.
pub type ReviewSession = std::sync::Mutex<Option<Vec<i64>>>;

pub fn set_review_session(slot: &ReviewSession, ids: Vec<i64>) {
    *slot.lock().unwrap_or_else(crate::recover_lock) = Some(ids);
}

pub fn review_queue(db: &Db, slot: &ReviewSession, due_limit: i64) -> Result<Vec<CardDto>, String> {
    let pending = slot.lock().unwrap_or_else(crate::recover_lock).take();
    if let Some(ids) = pending {
        return Ok(db
            .cards_by_ids(&ids)
            .map_err(|e| e.to_string())?
            .iter()
            .map(to_dto)
            .collect());
    }
    let roll = f64::from(Utc::now().timestamp_subsec_nanos()) / 1e9;
    due_queue(db, due_limit, roll)
}

/// Due cards of one deck — the "复习该包" button.
pub fn due_cards_of_deck(db: &Db, deck: &str) -> Result<Vec<CardDto>, String> {
    search_cards(db, None, Some(deck.to_string()), Some("due".into()))
}

/// Rate a card: scheduler decides (seq-based), then card update + review_log
/// row commit in one transaction (SPEC §17: a crash must never lose a rating).
/// `elapsed_ms` (翻开答案 → 评分) lands in review_log for future FSRS training
/// data and 虚高评分 detection.
pub fn rate(
    db: &mut Db,
    card_id: i64,
    rating: &str,
    elapsed_ms: Option<i64>,
) -> Result<CardDto, String> {
    let r = rating_from_str(rating).ok_or_else(|| format!("未知评分: {rating}"))?;
    let card = db
        .get_card(card_id)
        .map_err(|e| e.to_string())?
        .ok_or("卡片不存在")?;
    let cfg = cfg_from_db(db);
    let now = Utc::now();
    let today = db::study_day_of(now);
    let seq = db.show_count().map_err(|e| e.to_string())?;

    // Archived cards are only revisited through random spot checks (归档抽查):
    // pass → stay retired (familiar raises the re-pick weight); fail → back.
    if card.state == "archived" {
        return rate_archived(db, &card, r, seq.max(0) as u64, now);
    }

    let out = scheduler::review(&to_sched(&card, &today), r, seq.max(0) as u64, now, &cfg);
    // ±20% 间隔扰动 (2026-10-04 "时间只记账" rework): break fixed card order so
    // neighbours can't become a guessing crutch. The roll comes from the
    // sub-second nanos of the rating instant.
    let base_gap = out.next_eligible_seq - seq.max(0) as u64;
    let roll = f64::from(now.timestamp_subsec_nanos()) / 1e9;
    let next_eligible = seq.max(0) as u64 + scheduler::jitter_gap(base_gap, roll);
    let lapsed = i64::from(r == Rating::Unknown);
    // 自动归档 (2026-10-04 rework): 连击 ≥ 阈值 且 这 N 次讲出发生在 ≥ 阈值个
    // 不同学习日 — "当天连答三次" 不可信, 必须跨天. 每天最多升 1 级让等级自然
    // 跟上, 无需额外等级门槛. 链式门槛与被拖住翻倍保持不变.
    let archive_enabled = get_u32(db, "archive_enabled", 1) != 0;
    let archive_threshold = get_u32(db, "archive_threshold", 3).clamp(2, 5);
    let speak_days = if r == Rating::Speakable {
        append_day(&card.speak_days, &today)
    } else {
        String::new()
    };
    let distinct_days = speak_days.split(',').filter(|d| !d.is_empty()).count() as u32;
    let ready_to_archive = r == Rating::Speakable
        && archive_enabled
        && out.speak_streak >= archive_threshold
        && distinct_days >= archive_threshold;
    // Chain semantics (SPEC §11.4): a linked card graduates together with its
    // immediate neighbours — one weak link keeps the group in the rotation.
    let archived = ready_to_archive && neighbours_all_mastered(db, card_id, archive_threshold)?;
    // 链式被拖住: 别让这张卡在同一档空转 — 间隔翻倍 (封顶 200 张) 再来.
    let next_eligible = if ready_to_archive && !archived {
        let gap = next_eligible - seq.max(0) as u64;
        seq.max(0) as u64 + gap.saturating_mul(2).min(200).max(gap)
    } else {
        next_eligible
    };
    let next_state = if archived { "archived" } else { "review" };
    let due_at = if archived { now } else { out.earliest_at };
    let level_up_day = if out.leveled_up {
        Some(today.clone())
    } else {
        card.level_up_day.clone()
    };
    // Chain semantics: flagging a card as ⚠ also flags its immediate linked
    // neighbours (one hop, no chain-wide propagation) — but only ≤3 级:
    // already-solid cards are not dragged down by a weak neighbour.
    let newly_flagged = out.needs_attention && !card.needs_attention;
    let neighbours = if newly_flagged {
        linked_neighbours(db, card_id)?
    } else {
        Vec::new()
    };
    let tx = db.0.transaction().map_err(|e| e.to_string())?;
    for neighbour in neighbours {
        tx.execute(
            "UPDATE card SET needs_attention = 1
              WHERE id = ?1 AND state NOT IN ('suspended', 'archived') AND level <= 3",
            [neighbour],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE card SET state=?11, level=?1, next_eligible_seq=?2, due_at=?3,
         unknown_streak=?4, speak_streak=?5, needs_attention=?6,
         last_review_at=?7, last_seen_seq=?8, reps=reps+1, lapses=lapses+?9,
         level_up_day=?12, speak_days=?13
         WHERE id=?10",
        rusqlite::params![
            i64::from(out.level),
            next_eligible as i64,
            db::fmt_time(due_at),
            i64::from(out.unknown_streak),
            i64::from(out.speak_streak),
            i64::from(out.needs_attention),
            db::fmt_time(now),
            seq,
            lapsed,
            card_id,
            next_state,
            level_up_day,
            speak_days,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO review_log(card_id, rating, state_before, stability, difficulty,
         scheduled_interval, reviewed_at, elapsed_ms, source, level_before, level_after, seq_at)
         VALUES(?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, 'popup', ?7, ?8, ?9)",
        rusqlite::params![
            card_id,
            rating_num(r),
            card.state,
            next_eligible.to_string(),
            db::fmt_time(now),
            elapsed_ms,
            card.level,
            i64::from(out.level),
            seq,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    db.get_card(card_id)
        .map_err(|e| e.to_string())?
        .map(|c| to_dto(&c))
        .ok_or_else(|| "card disappeared after rating".into())
}

/// Append a study day to the CSV if it isn't already the last entry — the
/// distinct-day carrier for the archive rule.
fn append_day(csv: &str, day: &str) -> String {
    let mut days: Vec<&str> = csv.split(',').filter(|d| !d.is_empty()).collect();
    if days.last() == Some(&day) {
        return csv.to_string();
    }
    days.push(day);
    days.join(",")
}

/// Spot check of an archived card (2026-10-04 rework — 大师规则):
/// - 可以讲出来 → stay archived, everything else untouched;
/// - 熟悉 → stay archived, but `spot_bias` +7 raises the re-pick weight
///   (weight = days since last review + 1 + bias);
/// - 不了解 → unarchive to level 2 for a quick re-test, bias reset.
fn rate_archived(
    db: &mut Db,
    card: &Card,
    r: Rating,
    seq: u64,
    now: chrono::DateTime<Utc>,
) -> Result<CardDto, String> {
    // 用户自定义的间隔配置对抽查回炉同样生效（原先误用默认值，自定义
    // gap_unknown 的用户会看到抽查卡按 3 张回来）。
    let cfg = cfg_from_db(db);
    let today = db::study_day_of(now);
    let out = scheduler::review(&to_sched(card, &today), r, seq, now, &cfg);
    let (next_state, level, spot_bias, due_at) = match r {
        Rating::Unknown => ("review", 2, 0, out.earliest_at),
        Rating::Familiar => ("archived", card.level, card.spot_bias + 7, now),
        Rating::Speakable => ("archived", card.level, card.spot_bias, now),
    };
    let tx = db.0.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE card SET state=?1, level=?2, next_eligible_seq=?3, due_at=?4,
         unknown_streak=?5, speak_streak=?6, needs_attention=?7,
         last_review_at=?8, last_seen_seq=?9, reps=reps+1, lapses=lapses+?10,
         level_up_day=NULL, speak_days='', spot_bias=?11
         WHERE id=?12",
        rusqlite::params![
            next_state,
            level,
            out.next_eligible_seq as i64,
            db::fmt_time(due_at),
            i64::from(out.unknown_streak),
            i64::from(out.speak_streak),
            i64::from(out.needs_attention),
            db::fmt_time(now),
            seq as i64,
            i64::from(r == Rating::Unknown),
            spot_bias,
            card.id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO review_log(card_id, rating, state_before, stability, difficulty,
         scheduled_interval, reviewed_at, source, level_before, level_after, seq_at)
         VALUES(?1, ?2, ?3, NULL, NULL, ?4, ?5, 'spotcheck', ?6, ?7, ?8)",
        rusqlite::params![
            card.id,
            rating_num(r),
            card.state,
            out.next_eligible_seq.to_string(),
            db::fmt_time(now),
            card.level,
            level,
            seq as i64,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    db.get_card(card.id)
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
    Ok(scheduler::preview(&to_sched(&card, &db::study_day_of(Utc::now())), &cfg).to_vec())
}

/// Record that a card was actually shown: advances the global display counter
/// (design §1: 展示时增加) and stamps the card's last_seen_seq.
pub fn mark_shown(db: &Db, card_id: i64) -> Result<(), String> {
    db.insert_show_log(card_id, Utc::now())
        .map_err(|e| e.to_string())?;
    let seq = db.show_count().map_err(|e| e.to_string())?;
    db.mark_seen_seq(card_id, seq).map_err(|e| e.to_string())
}

/// **The** 待复习 count (SPEC §14): cards that can enter the popup right now.
/// Tray tooltip, home page (via [`get_stats`]), 今日目标 and the engine tick all
/// call this, and the popup draws its session from the very same predicate —
/// `due_queue`'s pools are built from `db::due_predicate`.
///
/// It counts the POOL, not one session: a popup serves `min(每次弹窗卡片数, 池)`
/// (SPEC §7.4), so this number is an upper bound on any single popup and the
/// difference has exactly the documented causes (新卡每次会话上限 / 重点卡每次 ≤1 /
/// 交错规则), never a second opinion about what "due" means.
pub fn due_count(db: &Db) -> Result<i64, String> {
    let seq = db.show_count().map_err(|e| e.to_string())?;
    db.due_count(seq, Utc::now()).map_err(|e| e.to_string())
}

/// Will the next popup actually contain a card? 「待复习」 counts the pool, but
/// the pool can hold nothing servable — the typical case is a pool of new cards
/// whose daily quota is already spent (SPEC §7.4 新卡每日上限). Opening then
/// flashes an empty window (`ReviewPopup` closes itself) and still eats one
/// `popup_log` slot plus the whole popup interval, so the engine asks first.
///
/// `roll = 1.0` skips the 15% 归档抽查 slot on purpose: that slot only ever
/// *adds* a card to a popup that already has content (SPEC §7.4 第 4 条), so a
/// session whose only candidate would be a spot-check card is not opened at all.
pub fn popup_has_content(db: &Db, per_popup: u32) -> bool {
    due_queue(db, i64::from(per_popup.max(1)), 1.0).is_ok_and(|q| !q.is_empty())
}

/// 今日目标面板数据 (2026-10-04 rework, 大师 §五; 2026-10-06 加讲出模式).
/// Positive framing: the UI shows what is done, never what is left — the goal
/// must not become new debt.
///
/// 两种模式见 [`crate::goal`]：`review` = 今天要复习 N 张（投入式）；
/// `speak` = 今天要**讲出来** N 张（产出式，按冻结的复习份额排程）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStatus {
    pub enabled: bool,
    /// "review" | "speak"。
    pub mode: String,
    pub target: i64,
    /// 模式对应的已完成数（复习型=今日复习张数；讲出型=今日讲出的卡数）。
    pub done: i64,
    pub reviewed_today: i64,
    /// 今天讲出来过的卡数（按卡去重——同一天连答三次「可以讲出来」只算 1 张）。
    pub spoken_today: i64,
    /// 附带成绩：今天达成掌握（讲出跨够了学习日）的卡数，**不当目标**。
    pub mastered_today: i64,
    pub due_count: i64,
    pub per_popup: i64,
    pub start: String,
    pub end: String,
    /// 视为达成：做到位，或（讲出型）今天能推进的卡都推进过了。
    pub met: bool,
    /// 讲出型：冻结的历史讲出率。
    pub speak_rate: f64,
    /// 讲出型：冻结的复习份额。
    pub budget: Option<i64>,
    pub budget_left: Option<i64>,
    /// 今天还能推进的卡数（0 = 卡池耗尽）。
    pub pool_left: i64,
    /// 时段内的当前弹窗间隔（分钟）；None = 该状态下没有目标节奏。
    pub interval_min: Option<i64>,
    /// 计划节奏：整个时段均匀铺开的间隔（分钟），时段开始前的预告。
    pub planned_interval_min: Option<i64>,
    /// [`crate::goal::CadenceReason`] 的字符串形式，前端据此选文案。
    pub reason: String,
    /// reason == "outsideWindow" 时：现在是否还在时段**开始之前**。
    pub before_window: bool,
}

pub fn goal_status(db: &Db) -> Result<GoalStatus, String> {
    let enabled = get_u32(db, "goal_enabled", 0) == 1;
    let mode = crate::goal::GoalMode::from_setting(
        &db.get_setting("goal_mode")
            .ok()
            .flatten()
            .unwrap_or_default(),
    );
    let target = get_u32(db, "goal_target", 0) as i64;
    let start = db
        .get_setting("goal_start")
        .ok()
        .flatten()
        .unwrap_or_else(|| "19:00".into());
    let end = db
        .get_setting("goal_end")
        .ok()
        .flatten()
        .unwrap_or_else(|| "22:00".into());
    let today = db::study_day_of(Utc::now());
    let reviewed_today = db
        .review_count_on_study_day(&today)
        .map_err(|e| e.to_string())?;
    let spoken_today = db.speak_cards_on_day(&today).map_err(|e| e.to_string())?;
    let archive_threshold = i64::from(get_u32(db, "archive_threshold", 3).clamp(2, 5));
    let mastered_today = db
        .mastered_cards_on_day(&today, archive_threshold)
        .map_err(|e| e.to_string())?;
    let pool_left = db.pushable_pool_left(&today).map_err(|e| e.to_string())?;
    // SPEC §7.4/§16: the same accessor the popup and the engine use. This used
    // to be a third hard-coded default (3), so the home-page cadence could
    // promise a session size the popup did not honour.
    let per_popup = per_popup_size(db);
    let done = match mode {
        crate::goal::GoalMode::Review => reviewed_today,
        crate::goal::GoalMode::Speak => spoken_today,
    };
    // 讲出型的份额与讲出率：首页只读，实时算一次展示用；引擎那边是冻结的
    // （同一套公式，见 crate::goal）。
    let (speaks, draws) = db.speak_rate_sample().unwrap_or((0, 0));
    let speak_rate = crate::goal::speak_rate(speaks, draws);
    let budget = (mode == crate::goal::GoalMode::Speak && target > 0)
        .then(|| crate::goal::speak_budget(target, speak_rate));
    // 卡池耗尽对讲出型也算"达成"——今天能推进的卡都推进过了。
    let met =
        target > 0 && (done >= target || (mode == crate::goal::GoalMode::Speak && pool_left <= 0));

    let now_local = Local::now();
    let now_min = i64::from(now_local.hour() * 60 + now_local.minute());
    let bounds = crate::engine::parse_hhmm(&start)
        .zip(crate::engine::parse_hhmm(&end))
        .map(|((sh, sm), (eh, em))| (i64::from(sh * 60 + sm), i64::from(eh * 60 + em)));
    let before_window = bounds.is_some_and(|(s, _)| now_min < s);
    // 份额消费的计量 = 时段内的复习张数（与引擎同一口径，只算时段内，
    // 上午的复习不会把晚上的份额先花掉）。
    let reviewed_in_window = bounds
        .map(|(start_min, _)| db.review_count_from(&today, start_min).unwrap_or(0))
        .unwrap_or(0);
    let (interval_min, planned_interval_min, reason) = match bounds {
        Some((start_min, end_min)) => {
            let planned =
                crate::goal::planned_interval(start_min, end_min, target, per_popup.max(1) as u32)
                    .map(i64::from);
            let (interval, reason) = crate::goal::goal_cadence(&crate::goal::GoalInput {
                mode,
                target: if enabled { target } else { 0 },
                done,
                reviewed_in_window,
                budget,
                speak_rate,
                pool_left,
                per_popup: per_popup.max(1) as u32,
                now_min,
                start_min,
                end_min,
                planned_interval: planned.unwrap_or(i64::from(crate::goal::INTERVAL_CEILING_MIN))
                    as u32,
            });
            (
                interval.map(i64::from),
                planned,
                reason.as_str().to_string(),
            )
        }
        None => (
            None,
            None,
            crate::goal::CadenceReason::Off.as_str().to_string(),
        ),
    };

    Ok(GoalStatus {
        enabled,
        mode: mode.as_str().to_string(),
        target,
        done,
        reviewed_today,
        spoken_today,
        mastered_today,
        due_count: due_count(db)?,
        per_popup,
        start,
        end,
        met,
        speak_rate,
        budget,
        budget_left: budget.map(|b| (b - reviewed_in_window).max(0)),
        pool_left,
        interval_min,
        planned_interval_min,
        reason,
        before_window,
    })
}

// ---- close policy (2026-10-04, 大师 §六: 惩罚不是多出几张卡) ----

/// 连续逃避阈值：达到即"下次只弹 1 张 + 间隔压到 10 分钟"（提高频率且降低门槛）。
pub const DODGE_PENALTY_STREAK: u32 = 3;
/// 连续逃避到此数：关闭前需要确认（多点一下）。
pub const DODGE_CONFIRM_STREAK: u32 = 2;
/// 逃避惩罚期的弹窗间隔下限。
pub const DODGE_INTERVAL_MIN: u32 = 10;

/// 连续逃避次数：今天的自动弹窗从最近往前走——"没评分就关闭" +1，
/// 有评分即中断，"unknown"（崩溃/断电，无关闭上报）透明跳过，手动会话不计。
pub fn dodge_streak(db: &Db) -> u32 {
    let day = db::study_day_of(Utc::now());
    let sessions = db.popup_sessions_today(&day).unwrap_or_default();
    let mut streak = 0u32;
    for s in sessions {
        if s.origin != "auto" {
            continue;
        }
        match s.close_reason.as_deref() {
            Some("closed") | Some("escaped") => {
                if s.rated.unwrap_or(0) == 0 {
                    streak += 1;
                } else {
                    break;
                }
            }
            Some("completed") => break,
            _ => continue,
        }
    }
    streak
}

/// 严格（无法关闭）模式开关。
pub fn close_policy_strict(db: &Db) -> bool {
    db.get_setting("close_policy")
        .ok()
        .flatten()
        .is_some_and(|v| v.trim() == "strict")
}

/// 弹窗打开时取的关闭策略上下文（前端据此决定 UI）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseContext {
    pub strict: bool,
    pub dodge_streak: u32,
    /// 本次会话前 N 张不显示 ✕（2026-10-07 用户需求：先把开头做完）。
    pub no_close_first_n: u32,
}

/// 「会话前 N 张禁止关闭」设置（KV，0 = 不限制；异常值回落 0，上限 10）。
pub fn no_close_first_n(db: &Db) -> u32 {
    db.get_setting("no_close_first_n")
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
        .min(10)
}

pub fn close_context(db: &Db) -> Result<CloseContext, String> {
    Ok(CloseContext {
        strict: close_policy_strict(db),
        dodge_streak: dodge_streak(db),
        no_close_first_n: no_close_first_n(db),
    })
}

/// Frontend-reported session outcome lands on the row opened by the engine.
pub fn report_popup_session(
    db: &Db,
    session_id: i64,
    reason: &str,
    shown: Option<i64>,
    rated: Option<i64>,
) -> Result<(), String> {
    db.close_popup_session(session_id, Utc::now(), reason, shown, rated)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 组卷 (2026-10-04) ----

pub use crate::db::ExamStrategy;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamPart {
    pub deck: String,
    pub count: i64,
}

/// 组卷：按卡包清单各抽 N 张（可选先并入今日到期卡），装入显式会话并打开
/// 弹窗。返回本次会话总张数。评分走普通评分流程（seq 计数器随展示推进）。
pub fn compose_exam(
    db: &Db,
    session: &ReviewSession,
    parts: &[ExamPart],
    include_due: bool,
    strategy: ExamStrategy,
) -> Result<usize, String> {
    let now = Utc::now();
    let seq = db.show_count().map_err(|e| e.to_string())?;
    let mut ids: Vec<i64> = Vec::new();

    if include_due {
        // "今天需要复习的卡" = ⚠ 插队 + 普通到期（不掺新卡/维护卡）。
        for c in db
            .attention_candidates(seq, now, 999)
            .map_err(|e| e.to_string())?
        {
            ids.push(c.id);
        }
        for c in db
            .due_candidates(seq, now, 999)
            .map_err(|e| e.to_string())?
        {
            if !ids.contains(&c.id) {
                ids.push(c.id);
            }
        }
    }
    for part in parts {
        let count = part.count.clamp(0, 500);
        if count == 0 {
            continue;
        }
        let picked = db
            .exam_candidates(&part.deck, count, strategy)
            .map_err(|e| e.to_string())?;
        for c in picked {
            if !ids.contains(&c.id) {
                ids.push(c.id);
            }
        }
    }
    if ids.is_empty() {
        return Err("组卷结果为空：所选卡包里没有可用卡片，先导入或添加几张吧".into());
    }
    let total = ids.len();
    set_review_session(session, ids);
    Ok(total)
}

/// 保存/更新组卷预设。
pub fn save_exam_preset(db: &Db, name: &str, config_json: &str) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("预设名称不能为空".into());
    }
    db.save_exam_preset(name, config_json, Utc::now())
        .map_err(|e| e.to_string())
}

pub fn list_exam_presets(db: &Db) -> Result<Vec<(i64, String, String)>, String> {
    db.list_exam_presets().map_err(|e| e.to_string())
}

pub fn delete_exam_preset(db: &Db, id: i64) -> Result<bool, String> {
    db.delete_exam_preset(id).map_err(|e| e.to_string())
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
    fn card_by_id_returns_dto_or_error() {
        let d = db();
        let dto = add_card(&d, "MySQL", "事务", "ACID?", "要点").unwrap();
        assert_eq!(card(&d, dto.id).unwrap().title, "ACID?");
        assert_eq!(card(&d, 4_096).unwrap_err(), "卡片不存在");
    }

    #[test]
    fn archived_spot_check_uses_user_configured_gaps() {
        let mut d = db();
        let dto = add_card(&d, "MySQL", "事务", "ACID?", "要点").unwrap();
        d.0
            .execute(
                "UPDATE card SET state='archived', level=5, next_eligible_seq=0,
                 due_at='2000-01-01T00:00:00+00:00'",
                [],
            )
            .unwrap();
        d.set_setting("gap_unknown", "7").unwrap();
        mark_shown(&d, dto.id).unwrap();
        let seq = d.show_count().unwrap();
        let after = rate(&mut d, dto.id, "unknown", None).unwrap();
        assert_eq!(after.state, "review", "不了解 → 出归档回炉");
        let raw = d.get_card(dto.id).unwrap().unwrap();
        assert_eq!(
            raw.next_eligible_seq,
            seq + 7,
            "抽查回炉的间距必须用用户配置，而不是默认 3"
        );
    }

    #[test]
    fn rate_persists_review_log() {
        let mut d = db();
        let dto = add_card(&d, "MySQL", "事务", "ACID?", "要点").unwrap();
        // Show the card first (display advances the global seq).
        mark_shown(&d, dto.id).unwrap();
        let after = rate(&mut d, dto.id, "familiar", None).unwrap();
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
        // `scheduled_interval` carries the absolute next_eligible seq (legacy
        // column name): base gap 8 ± 20% jitter lands at seq 1 + [6, 10].
        let next: u64 = gap.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
        assert!(
            (7..=11).contains(&next),
            "jittered familiar landing for base gap 8, got {next}"
        );
        let (source, level_before, level_after, seq_at): (String, i64, i64, i64) =
            d.0.query_row(
                "SELECT source, level_before, level_after, seq_at FROM review_log GROUP BY id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (source.as_str(), level_before, level_after, seq_at),
            ("popup", 0, 1, 1)
        );
        let c = d.get_card(dto.id).unwrap().unwrap();
        assert_eq!(
            c.next_eligible_seq as u64, next,
            "next_eligible matches the jittered landing"
        );
        let floor = c.due_at - Utc::now();
        assert!(
            (floor.num_minutes() - 30).abs() < 5,
            "familiar time floor is a flat 30 min, got {}",
            floor.num_minutes()
        );
        assert_eq!(c.last_seen_seq, 1);
        assert!(!c.uid.is_empty(), "every card gets a stable uid");
    }

    #[test]
    fn card_cannot_reappear_before_its_seq_gate() {
        let d = db();
        let a = add_card(&d, "D", "C", "卡A", "x").unwrap();
        let b = add_card(&d, "D", "C", "卡B", "x").unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        // Both are level-1 scheduled cards, gated behind 4 shows AND still
        // inside their 10-minute floor: time never breaks its own floor, not
        // even through the starvation fallback.
        for id in [a.id, b.id] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1,
                 next_eligible_seq=4, due_at=?1 WHERE id=?2",
                rusqlite::params![db::fmt_time(Utc::now() + chrono::Duration::minutes(5)), id],
            )
            .unwrap();
        }
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
        // Floor passes; with the pool starved the fallback hands them out —
        // only the count gate is relaxed, never the time floor.
        for id in [a.id, b.id] {
            d.0.execute(
                "UPDATE card SET due_at=?1 WHERE id=?2",
                rusqlite::params![past, id],
            )
            .unwrap();
        }
        assert_eq!(
            due_queue(&d, 10, 0.99).unwrap().len(),
            2,
            "starved pool falls back to the nearest seq gates"
        );
        // Whenever the pool CAN serve the request, the seq gate rules: a
        // fully-eligible card fills the popup and the gated pair waits.
        let ready = add_card(&d, "D", "C3", "已到期", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
             due_at=?1 WHERE id=?2",
            rusqlite::params![past, ready.id],
        )
        .unwrap();
        let q = due_queue(&d, 1, 0.99).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["已到期"],
            "gated cards yield to eligible ones"
        );
        // Four other displays open the gate; overdue-ratio then orders them.
        for _ in 0..4 {
            mark_shown(&d, a.id).unwrap();
        }
        let q = due_queue(&d, 10, 0.99).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["已到期", "卡B", "卡A"],
            "all eligible now; the freshest-seen card comes last"
        );
    }

    #[test]
    fn pool_priority_and_attention_quota() {
        let d = db();
        // Distinct chapters: the diversifier caps same-chapter cards at 2.
        let flagged = add_card(&d, "D", "C1", "重点卡", "x").unwrap();
        let due = add_card(&d, "D", "C2", "到期卡", "x").unwrap();
        let _new = add_card(&d, "D", "C3", "新卡", "x").unwrap();
        let normal = add_card(&d, "D", "C4", "维护卡", "x").unwrap();
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
        let q = due_queue(&d, 4, 0.99).unwrap();
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
        let q = due_queue(&d, 5, 0.99).unwrap();
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
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
    }

    #[test]
    fn rate_unknown_rating_errors() {
        let mut d = db();
        let dto = add_card(&d, "D", "C", "T", "x").unwrap();
        assert!(rate(&mut d, dto.id, "excellent", None).is_err());
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
        let q = due_queue(&d, 10, 0.99).unwrap();
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
        assert_eq!(due_queue(&d, 10, 0.99).unwrap().len(), 1);
        // Two per session when configured.
        set_settings(&d, &[("session_new_limit".into(), "2".into())]).unwrap();
        assert_eq!(due_queue(&d, 10, 0.99).unwrap().len(), 2);
        // Daily quota caps across sessions: pretend 15 were introduced today.
        set_settings(&d, &[("session_new_limit".into(), "5".into())]).unwrap();
        for _ in 0..15 {
            d.0.execute(
                "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
                 VALUES(1, 2, 'new', ?1)",
                [db::fmt_time(Utc::now() - chrono::Duration::hours(1))],
            )
            .unwrap();
        }
        assert_eq!(
            due_queue(&d, 10, 0.99).unwrap().len(),
            0,
            "daily new quota exhausted"
        );
    }

    #[test]
    fn new_cards_queue_serves_remaining_daily_quota() {
        let d = db();
        add_card(&d, "D", "C", "新1", "x").unwrap();
        add_card(&d, "D", "C", "新2", "x").unwrap();
        add_card(&d, "D", "C", "新3", "x").unwrap();
        // The explicit 学新卡 session ignores the per-session quota (the user
        // asked for it outright) and hands out every remaining new card.
        assert_eq!(new_cards_queue(&d).unwrap().len(), 3);
        // The daily cap still holds: 15 introductions in the last 24h → done.
        for _ in 0..15 {
            d.0.execute(
                "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
                 VALUES(1, 2, 'new', ?1)",
                [db::fmt_time(Utc::now())],
            )
            .unwrap();
        }
        let err = new_cards_queue(&d).unwrap_err();
        assert!(err.contains("今日新卡已学完"), "unexpected error: {err}");
    }

    #[test]
    fn new_cards_queue_errors_when_no_new_cards() {
        let d = db();
        let err = new_cards_queue(&d).unwrap_err();
        assert!(err.contains("没有待学习的新卡"), "unexpected error: {err}");
    }

    #[test]
    fn new_cards_queue_honors_zero_daily_limit() {
        let d = db();
        add_card(&d, "D", "C", "新1", "x").unwrap();
        set_settings(&d, &[("daily_new_limit".into(), "0".into())]).unwrap();
        let err = new_cards_queue(&d).unwrap_err();
        assert!(err.contains("上限为 0"), "unexpected error: {err}");
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
            path: None,
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

    /// SPEC §5.4: importing a note copies the images it references next to it,
    /// rewrites the card markdown to `attachment:` refs, and leaves refs it
    /// cannot resolve (missing file, remote URL) untouched.
    #[test]
    fn import_copies_referenced_images() {
        let d = db();
        let root = std::env::temp_dir().join(format!("fm-import-{}", uuid::Uuid::new_v4()));
        let notes = root.join("notes");
        std::fs::create_dir_all(notes.join("images")).unwrap();
        let png = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 7];
        std::fs::write(notes.join("images/a.png"), png).unwrap();
        let store = root.join("store");

        let files = vec![ImportFile {
            name: "deck.md".into(),
            content: "# 带图卡包\n\n## 章节\n\n### 有图的问题\n\n看图：\n\n\
                      ![示意图](<images/a.png>)\n\n![缺图](images/nope.png)\n\n\
                      ![远程](https://example.com/x.png)\n"
                .into(),
            path: Some(notes.join("deck.md").to_string_lossy().into_owned()),
        }];
        import_markdown_with_store(&d, &files, false, Some(&store)).unwrap();
        let card = list_cards(&d, "带图卡包").unwrap().pop().unwrap();
        assert!(
            card.content_md.contains("![示意图](attachment:"),
            "{}",
            card.content_md
        );
        assert!(
            card.content_md.contains("![缺图](images/nope.png)"),
            "{}",
            card.content_md
        );
        assert!(
            card.content_md
                .contains("![远程](https://example.com/x.png)"),
            "{}",
            card.content_md
        );
        let name = card
            .content_md
            .split("attachment:")
            .nth(1)
            .and_then(|s| s.split(')').next())
            .unwrap()
            .to_string();
        assert_eq!(std::fs::read(store.join(&name)).unwrap(), png);

        // Re-import is idempotent: same bytes -> same name -> content unchanged.
        let before = card.content_md.clone();
        let report = import_markdown_with_store(&d, &files, false, Some(&store)).unwrap();
        assert_eq!(report.updated, 0, "no churn on re-import");
        assert_eq!(
            list_cards(&d, "带图卡包")
                .unwrap()
                .pop()
                .unwrap()
                .content_md,
            before
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// SPEC §5.3 (2026-10-07): a 题面卡's images follow the same rule as the
    /// back's — `front_md` is card content, so its refs are copied into the
    /// attachment store and rewritten, while unresolvable refs stay untouched.
    #[test]
    fn import_copies_images_referenced_by_a_front_card() {
        let d = db();
        let root = std::env::temp_dir().join(format!("fm-front-{}", uuid::Uuid::new_v4()));
        let notes = root.join("notes");
        std::fs::create_dir_all(notes.join("images")).unwrap();
        let png = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 9];
        std::fs::write(notes.join("images/q.png"), png).unwrap();
        let store = root.join("store");

        let files = vec![ImportFile {
            name: "front.md".into(),
            content: "# 题面卡包\n\n## 看图回答\n\n![架构图](<images/q.png>)\n这段是什么？\n\n\
                      ![缺图](images/nope.png)\n"
                .into(),
            path: Some(notes.join("front.md").to_string_lossy().into_owned()),
        }];
        import_markdown_with_store(&d, &files, false, Some(&store)).unwrap();

        let card = list_cards(&d, "题面卡包").unwrap().pop().unwrap();
        assert!(
            card.front_md.contains("![架构图](attachment:"),
            "题面里的图必须被搬运并改写：{}",
            card.front_md
        );
        assert!(
            card.front_md.contains("![缺图](images/nope.png)"),
            "解析不到的引用原样保留：{}",
            card.front_md
        );
        let name = card
            .front_md
            .split("attachment:")
            .nth(1)
            .and_then(|s| s.split(')').next())
            .unwrap()
            .to_string();
        assert_eq!(std::fs::read(store.join(&name)).unwrap(), png);
        std::fs::remove_dir_all(&root).ok();
    }

    /// The native picker hands us paths; the service reads the file and keeps
    /// the path so image refs can be resolved later (SPEC §5.3/§5.4).
    #[test]
    fn read_markdown_files_returns_content_and_path() {
        let dir = std::env::temp_dir().join(format!("fm-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("笔记.md");
        std::fs::write(&file, "# 卡包\n\n### 问题\n答案\n").unwrap();

        let files = read_markdown_files(&[file.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "笔记.md");
        assert!(files[0].content.contains("### 问题"));
        assert_eq!(
            files[0].path.as_deref(),
            Some(file.to_string_lossy().as_ref())
        );
        assert!(
            read_markdown_files(&[dir.join("missing.md").to_string_lossy().into_owned()]).is_err()
        );
        std::fs::remove_dir_all(&dir).ok();
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
        rate(&mut d, dto.id, "familiar", None).unwrap(); // review_log row exists
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
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
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

    // ---- 题面卡 (需求7, SPEC §5.2 rule 10 / §14 / §15.1) ----

    /// The front reaches the UI through `CardDto.frontMd` (serde `frontMd`) —
    /// that is the field the popup/list rendering waits for.
    #[test]
    fn card_dto_carries_front_md() {
        let d = db();
        let dto = add_card_with_front(&d, "D", "C", "🖼 · 题干", "", "![图](u.png)\n题干").unwrap();
        assert_eq!(dto.front_md, "![图](u.png)\n题干");
        assert_eq!(dto.title, "🖼 · 题干");
        assert_eq!(card(&d, dto.id).unwrap().front_md, "![图](u.png)\n题干");
        assert_eq!(
            list_cards(&d, "D").unwrap()[0].front_md,
            "![图](u.png)\n题干"
        );
        let plain = add_card(&d, "D", "C2", "普通卡", "背").unwrap();
        assert_eq!(plain.front_md, "", "普通卡的题面为空，观感不变");
    }

    /// Manual creation without a heading: the title comes from the 题面's
    /// projection (SPEC §15.1), so a long/image front can be authored by hand.
    #[test]
    fn manual_card_derives_title_from_front() {
        let d = db();
        let dto =
            add_card_with_front(&d, "D", "C", "  ", "", "![图](u.png)\n这题怎么解？").unwrap();
        assert_eq!(dto.title, "🖼 · 这题怎么解？");
        assert_eq!(dto.front_md, "![图](u.png)\n这题怎么解？");
        assert_eq!(dto.content_md, "");
    }

    /// A wordless 题面 (pure image) projects to `🖼`; a second one in the same
    /// chapter must not blow up on `UNIQUE(chapter_id, title)`.
    #[test]
    fn manual_card_disambiguates_duplicate_titles() {
        let d = db();
        let first = add_card_with_front(&d, "D", "C", "", "", "![图](a.png)").unwrap();
        let second = add_card_with_front(&d, "D", "C", "", "", "![图](b.png)").unwrap();
        assert_eq!(first.title, "🖼");
        assert_eq!(second.title, "🖼 #2", "重名自动加后缀，不报 UNIQUE 错误");
        assert_eq!(list_cards(&d, "D").unwrap().len(), 2);
        // A different chapter keeps its own namespace.
        let other = add_card_with_front(&d, "D", "C2", "", "", "![图](c.png)").unwrap();
        assert_eq!(other.title, "🖼");
    }

    #[test]
    fn manual_card_needs_a_title_or_a_front() {
        let d = db();
        assert!(add_card_with_front(&d, "D", "C", "", "", "").is_err());
        assert!(add_card_with_front(&d, "D", "C", "   ", "", "   ").is_err());
    }

    /// Editing the back (popup annotation, SPEC §9.3) must never wipe the front:
    /// `front_md: None` means "leave it alone".
    #[test]
    fn updating_content_keeps_the_front() {
        let d = db();
        let dto = add_card_with_front(&d, "D", "C", "题", "", "题干").unwrap();
        update_card_content(&d, dto.id, "我写的答案").unwrap();
        let after = card(&d, dto.id).unwrap();
        assert_eq!(after.front_md, "题干", "背面编辑不动题面");
        assert_eq!(after.content_md, "我写的答案");

        let edited = update_card_with_front(&d, dto.id, "题", "答案", Some("新题干")).unwrap();
        assert_eq!(edited.front_md, "新题干", "显式传 front 才改它");
        assert_eq!(edited.content_md, "答案");
    }

    /// SPEC §15.2 搜索（标题/内容）：题面卡的内容在 `front_md` 里，所以搜索也要
    /// 匹配它，否则按题干搜不到题面卡。
    #[test]
    fn search_matches_front_md() {
        let d = db();
        add_card_with_front(
            &d,
            "D",
            "C",
            "🖼",
            "",
            "![图](u.png)\n这段题干里有独特词 蕉绿",
        )
        .unwrap();
        add_card(&d, "D", "C2", "普通卡", "背").unwrap();
        let hits = search_cards(&d, Some("蕉绿".into()), None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].front_md, "![图](u.png)\n这段题干里有独特词 蕉绿");
    }

    #[test]
    fn popup_annotation_save_marks_local_edit_and_survives_reimport() {
        let d = db();
        let files = vec![ImportFile {
            name: "notes.md".into(),
            content: "# D\n\n## C\n\n### 卡\n原始内容\n".into(),
            path: None,
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
        rate(&mut d, c.id, "speakable", None).unwrap(); // level 1
        let p = preview_intervals(&d, c.id).unwrap();
        assert_eq!(p[1], 8, "familiar from level 1: max(level_gap[1]=2, 8)");
        assert_eq!(p[2], 20, "speakable to level 2: max(level_gap[2]=4, 20)");
    }

    // ---- dashboard & leech/archive loop (M2) ----

    /// Noon of the study day `days_ago` back. Anchored on the app's own day
    /// (04:00 roll, §2 术语) on purpose: between 00:00 and 04:00 the calendar
    /// day's noon is still in the future and belongs to *tomorrow's* study day,
    /// so a calendar-anchored fixture silently dropped one day of the streak.
    fn study_day_noon_utc(days_ago: i64) -> chrono::DateTime<Utc> {
        use chrono::{Local, NaiveDate, TimeZone};
        let base = NaiveDate::parse_from_str(&db::study_day_of(Utc::now()), "%Y-%m-%d")
            .expect("study day is yyyy-mm-dd");
        let day = base - chrono::Duration::days(days_ago);
        Local
            .from_local_datetime(&day.and_hms_opt(12, 0, 0).unwrap())
            .unwrap()
            .with_timezone(&Utc)
    }

    fn local_hour_utc(hour: u32, days_ago: i64) -> chrono::DateTime<Utc> {
        use chrono::{Local, TimeZone};
        let day = Local::now().date_naive() - chrono::Duration::days(days_ago);
        Local
            .from_local_datetime(&day.and_hms_opt(hour, 0, 0).unwrap())
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
        rate(&mut d, a.id, "familiar", None).unwrap(); // today's review + level 1

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

    /// 评审 §5 的计数规则：讲出计数按卡去重、不被后续评分抹掉；复习计数照旧。
    #[test]
    fn speak_goal_counts_cards_and_never_rolls_back() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        let today = db::study_day_of(Utc::now());
        // 同一天连答三次「可以讲出来」→ 只算讲出 1 张（speak_days 只加一天）
        for _ in 0..3 {
            rate(&mut d, c.id, "speakable", None).unwrap();
        }
        assert_eq!(d.speak_cards_on_day(&today).unwrap(), 1);
        // 复习口径则是 3 张（每个评分都算一张）——两个口径不同，正是要分两种模式的原因
        assert_eq!(d.review_count_on_study_day(&today).unwrap(), 3);
        // 讲出来过的卡今天不再"可推进"
        assert_eq!(d.pushable_pool_left(&today).unwrap(), 0);

        // 之后再评「熟悉」会把 speak_days/连击清零，但"今天讲过这张卡"是事实，
        // 计数**不回退**（否则进度条会在用户眼皮底下倒退）。
        rate(&mut d, c.id, "familiar", None).unwrap();
        assert_eq!(d.speak_cards_on_day(&today).unwrap(), 1, "讲出计数不回退");
        assert_eq!(
            d.mastered_cards_on_day(&today, 3).unwrap(),
            0,
            "附带成绩按当前状态算：连击真的被打破了"
        );
    }

    #[test]
    fn goal_status_speak_mode_reports_speak_numbers() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        set_settings(
            &d,
            &[
                ("goal_enabled".into(), "1".into()),
                ("goal_mode".into(), "speak".into()),
                ("goal_target".into(), "1".into()),
                ("goal_start".into(), "00:00".into()),
                ("goal_end".into(), "23:59".into()),
            ],
        )
        .unwrap();
        let before = goal_status(&d).unwrap();
        assert_eq!(before.mode, "speak");
        assert_eq!(before.target, 1);
        assert_eq!(before.done, 0);
        assert_eq!(before.spoken_today, 0);
        assert!(before.budget.is_some(), "讲出型必须有冻结的复习份额");
        assert_eq!(before.budget_left, before.budget, "还没复习，份额没动");
        assert!(!before.met);

        rate(&mut d, c.id, "speakable", None).unwrap();
        let after = goal_status(&d).unwrap();
        assert_eq!(after.done, 1, "讲出 1 张即完成目标");
        assert_eq!(after.reviewed_today, 1);
        assert!(after.met);
        assert_eq!(after.reason, "reached");
        assert_eq!(after.interval_min, None, "达标后不再有目标节奏");
    }

    /// 复习型的老行为不能变：轮到多少张就按缺口摊分。
    #[test]
    fn goal_status_review_mode_still_uses_the_review_count() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        set_settings(
            &d,
            &[
                ("goal_enabled".into(), "1".into()),
                ("goal_target".into(), "3".into()),
                ("goal_start".into(), "00:00".into()),
                ("goal_end".into(), "23:59".into()),
            ],
        )
        .unwrap();
        let before = goal_status(&d).unwrap();
        assert_eq!(before.mode, "review");
        assert_eq!(before.budget, None, "复习型没有份额概念");
        rate(&mut d, c.id, "unknown", None).unwrap();
        let after = goal_status(&d).unwrap();
        assert_eq!(after.done, 1, "「不了解」也算复习一张");
        assert_eq!(after.spoken_today, 0, "「不了解」不算讲出");
    }

    #[test]
    fn speak_rate_sample_ignores_repeats_within_a_day() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // 一天内同一张卡连答三次：只有第一次算"展示机会"，后两次不该压低讲出率。
        for _ in 0..3 {
            rate(&mut d, c.id, "speakable", None).unwrap();
        }
        let (speaks, draws) = d.speak_rate_sample().unwrap();
        assert_eq!((speaks, draws), (1, 1), "同一张卡同一天的重复不计入分母");
    }

    #[test]
    fn streak_walks_back_consecutive_days_only() {
        let d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        for days_ago in [0, 1, 2, 5] {
            insert_log(&d, c.id, 2, study_day_noon_utc(days_ago));
        }
        let s = get_stats(&d).unwrap();
        assert_eq!(s.streak_days, 3, "today+yesterday+2 days ago, then a gap");
        assert_eq!(
            s.last7_days[1], 1,
            "5 days ago = index 1 of the 7-day window"
        );
    }

    /// 首页上并排的两个「今天」必须同一天：统计卡与今日目标都按 04:00 学习日
    /// 分组。修复前统计侧用自然日，凌晨 0–4 点两个数字会各说各话。
    #[test]
    fn both_day_counters_use_the_0400_study_day_roll() {
        let d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // 本地 01:00 落在 00:00–04:00 窗口里 → 属于「上一个学习日」。
        let late_night = local_hour_utc(1, 0);
        insert_log(&d, c.id, 2, late_night);
        let study_day = db::study_day_of(late_night);
        let by_day: std::collections::HashMap<String, i64> = d
            .review_counts_by_day(Utc::now() - chrono::Duration::days(2))
            .unwrap()
            .into_iter()
            .collect();

        let calendar_today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_ne!(calendar_today, study_day, "这一刻的日历日与学习日是两天");
        assert_eq!(
            d.review_count_on_study_day(&study_day).unwrap(),
            1,
            "目标侧：01:00 的复习记在上一个学习日"
        );
        assert_eq!(
            by_day.get(&study_day).copied().unwrap_or(0),
            1,
            "统计侧必须落在同一个学习日"
        );
        assert_eq!(
            by_day.get(&calendar_today).copied().unwrap_or(0),
            0,
            "统计侧不能再按自然日把它算进今天"
        );
    }

    /// Push a card to the brink of archiving: speak streak 2 across 2 distinct
    /// days. One more Speakable (a third distinct day) graduates it, unless
    /// the chain gate or the switch refuses.
    fn prime_almost_archived(d: &Db, id: i64) {
        let d1 = db::study_day_of(Utc::now() - chrono::Duration::days(2));
        let d2 = db::study_day_of(Utc::now() - chrono::Duration::days(1));
        let past = db::fmt_time(Utc::now() - chrono::Duration::days(1));
        d.0.execute(
            "UPDATE card SET state='review', level=2, reps=4, speak_streak=2,
             unknown_streak=0, needs_attention=0, next_eligible_seq=0, due_at=?1,
             last_review_at=?2, speak_days=?3
             WHERE id=?4",
            rusqlite::params![past, past, format!("{d1},{d2}"), id],
        )
        .unwrap();
    }

    #[test]
    fn same_day_speakables_never_archive_or_level_twice() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // 3 quick Speakable in ONE day: streak 3, but only one distinct day —
        // "短时记得" is not long-term mastery: no archive, and the level
        // rises exactly once (每天最多升 1 级).
        for _ in 0..3 {
            rate(&mut d, c.id, "speakable", None).unwrap();
        }
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(
            card.state, "review",
            "one afternoon of recall is not mastery"
        );
        assert_eq!(card.level, 2, "ace 0→2 counts as the day's single climb");
        assert_eq!(card.speak_streak, 3);
        assert_eq!(
            card.speak_days.split(',').filter(|d| !d.is_empty()).count(),
            1,
            "three same-day speaks = one distinct day"
        );
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
    }

    #[test]
    fn archive_needs_three_speakables_on_three_distinct_days() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        // Day 1: one speakable (ace 0 → 2).
        rate(&mut d, c.id, "speakable", None).unwrap();
        // Simulate the streak having run on two earlier distinct days (rate()
        // always stamps "today", so earlier days are stamped by hand).
        let d1 = db::study_day_of(Utc::now() - chrono::Duration::days(2));
        let d2 = db::study_day_of(Utc::now() - chrono::Duration::days(1));
        let past = db::fmt_time(Utc::now() - chrono::Duration::days(1));
        d.0.execute(
            "UPDATE card SET speak_days=?1, speak_streak=2, level_up_day=?2,
             last_review_at=?3, next_eligible_seq=0, due_at=?4 WHERE id=?5",
            rusqlite::params![format!("{d1},{d2}"), d2, past, past, c.id],
        )
        .unwrap();
        // The third speakable lands on a third distinct day → archive.
        rate(&mut d, c.id, "speakable", None).unwrap();
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(
            card.state, "archived",
            "three speakables on three distinct days"
        );
        assert_eq!(card.speak_streak, 3);
        assert_eq!(card.level, 3, "the day's single climb still applies");
        assert_eq!(
            card.speak_days,
            format!("{d1},{d2},{}", db::study_day_of(Utc::now()))
        );
        assert_eq!(get_stats(&d).unwrap().archived_count, 1);

        // Archived cards leave the rotation… and come back unchanged.
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
        let restored = restore_card(&d, c.id).unwrap();
        assert_eq!(restored.state, "review");
        assert_eq!(due_queue(&d, 10, 0.99).unwrap().len(), 1);
    }

    #[test]
    fn spot_check_pass_and_fail_paths() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        prime_almost_archived(&d, c.id);
        rate(&mut d, c.id, "speakable", None).unwrap();
        assert_eq!(d.get_card(c.id).unwrap().unwrap().state, "archived");

        // A familiar spot check raises the re-pick weight by 7…
        rate(&mut d, c.id, "familiar", None).unwrap();
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(card.state, "archived", "familiar keeps the card retired");
        assert_eq!(card.spot_bias, 7);

        // …and a speakable spot check keeps it retired untouched.
        rate(&mut d, c.id, "speakable", None).unwrap();
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(card.state, "archived");
        assert_eq!(card.spot_bias, 7, "speakable does not change the bias");

        // A failed check unarchives back to level 2 (大师明示) with bias reset.
        rate(&mut d, c.id, "unknown", None).unwrap();
        let card = d.get_card(c.id).unwrap().unwrap();
        assert_eq!(card.state, "review", "failed spot check unarchives");
        assert_eq!(card.level, 2);
        assert_eq!(card.spot_bias, 0);
    }

    #[test]
    fn spot_check_slot_is_probabilistic_and_age_weighted() {
        let d = db();
        // Two archived cards: A unseen for 20 days, B unseen for 1 day.
        let a = add_card(&d, "D", "C1", "久卡", "x").unwrap();
        let b = add_card(&d, "D", "C2", "新归档", "x").unwrap();
        for (id, days) in [(a.id, 20), (b.id, 1)] {
            d.0.execute(
                "UPDATE card SET state='archived', last_review_at=?1 WHERE id=?2",
                rusqlite::params![db::fmt_time(Utc::now() - chrono::Duration::days(days)), id],
            )
            .unwrap();
        }
        // roll = 0.0 → spot-check slot opens (0 < 0.15); normalized roll 0
        // lands on the heaviest weight = the 20-day card.
        let q = due_queue(&d, 10, 0.0).unwrap();
        assert_eq!(q.len(), 1, "spot check takes one slot");
        assert_eq!(q[0].title, "久卡", "longer unseen → picked first");
        // roll = 0.99 → no spot check at all; the pool is empty otherwise.
        assert!(due_queue(&d, 10, 0.99).unwrap().is_empty());
    }

    #[test]
    fn pool_starvation_falls_back_to_nearest_seq_gate() {
        let d = db();
        let a = add_card(&d, "D", "C", "最近卡", "x").unwrap();
        let b = add_card(&d, "D", "C2", "稍远卡", "x").unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(30));
        // Both are behind their seq gates with the time floor long passed —
        // the "all pools empty" starvation case (few cards, frequent reviews).
        for (id, seq_gate) in [(a.id, 5), (b.id, 50)] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1,
                 next_eligible_seq=?1, due_at=?2, last_review_at=?2 WHERE id=?3",
                rusqlite::params![seq_gate, past, id],
            )
            .unwrap();
        }
        // Fallback hands out nearest-gate cards without touching the gates.
        let q = due_queue(&d, 10, 0.99).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["最近卡", "稍远卡"],
            "nearest seq gate first"
        );
        // A card inside its 10-minute floor still stays out (time never
        // relapses on its floor).
        d.0.execute(
            "UPDATE card SET due_at=?1, last_review_at=?1 WHERE id=?2",
            rusqlite::params![
                db::fmt_time(Utc::now() + chrono::Duration::minutes(5)),
                a.id
            ],
        )
        .unwrap();
        let q = due_queue(&d, 10, 0.99).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["稍远卡"],
            "time floor still respected in the fallback"
        );
    }

    #[test]
    fn goal_status_reports_progress_and_settings() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        set_settings(
            &d,
            &[
                ("goal_enabled".into(), "1".into()),
                ("goal_target".into(), "10".into()),
            ],
        )
        .unwrap();
        rate(&mut d, c.id, "familiar", None).unwrap();
        let g = goal_status(&d).unwrap();
        assert!(g.enabled);
        assert_eq!(g.target, 10);
        assert_eq!(g.reviewed_today, 1);
        assert!(!g.met);
        // Met → positive completion.
        for _ in 0..9 {
            set_settings(&d, &[("daily_new_limit".into(), "0".into())]).unwrap();
            d.0.execute(
                "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
                 VALUES(?1, 2, 'review', ?2)",
                rusqlite::params![c.id, db::fmt_time(Utc::now())],
            )
            .unwrap();
        }
        let g = goal_status(&d).unwrap();
        assert!(g.met, "10/10 reached");
    }

    #[test]
    fn archive_respects_threshold_and_switch() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        prime_almost_archived(&d, c.id);
        // Disabled switch: never archives.
        set_settings(&d, &[("archive_enabled".into(), "0".into())]).unwrap();
        rate(&mut d, c.id, "speakable", None).unwrap();
        assert_eq!(d.get_card(c.id).unwrap().unwrap().state, "review");

        // Enabled: prime again and the next Speakable (3rd distinct day)
        // archives.
        set_settings(&d, &[("archive_enabled".into(), "1".into())]).unwrap();
        prime_almost_archived(&d, c.id);
        rate(&mut d, c.id, "speakable", None).unwrap();
        assert_eq!(d.get_card(c.id).unwrap().unwrap().state, "archived");
    }

    /// 离手逃离 (2026-10-06): 弹窗开着没人碰 → 记一笔逃避，堵住"拖到副屏放着
    /// 不管 = 当天静音且零代价"的路子。
    #[test]
    fn idle_escape_feeds_the_dodge_streak_but_a_real_close_overrides_it() {
        let d = db();
        let t = Utc::now();
        d.open_popup_session(1, t, "auto").unwrap();
        assert_eq!(
            dodge_streak(&d),
            0,
            "还没结算的会话不算逃避（崩溃/断电不该背锅）"
        );
        // 引擎判定离手 → 记一笔逃离
        assert_eq!(d.mark_session_escaped(1).unwrap(), 1);
        assert_eq!(dodge_streak(&d), 1, "离手逃离要进逃避链");
        // 用户后来真的回来评分并关闭 → 真实结局覆盖逃离标记
        d.close_popup_session(1, t, "completed", Some(3), Some(3))
            .unwrap();
        assert_eq!(dodge_streak(&d), 0, "回来了就不算逃避");
        // 已结算的行不会被逃离标记覆盖
        assert_eq!(
            d.mark_session_escaped(1).unwrap(),
            0,
            "close_reason 已存在时不该再改"
        );
    }

    #[test]
    fn dodge_streak_walks_unrated_auto_closes() {
        let d = db();
        let t = Utc::now();
        // Distinct opened_at stamps (ms precision would otherwise tie).
        let open = |id: i64, secs: i64, origin: &str| {
            d.open_popup_session(id, t - chrono::Duration::seconds(secs), origin)
                .unwrap();
        };
        let close = |id: i64, reason: &str, rated: i64| {
            d.close_popup_session(id, t, reason, Some(3), Some(rated))
                .unwrap();
        };
        // Two dodges, then a completed session → streak resets to 0.
        open(1, 200, "auto");
        close(1, "closed", 0);
        open(2, 150, "auto");
        close(2, "closed", 0);
        open(3, 100, "auto");
        close(3, "completed", 2);
        assert_eq!(dodge_streak(&d), 0);
        // Three fresh dodges → 3.
        open(4, 50, "auto");
        close(4, "closed", 0);
        open(5, 40, "auto");
        close(5, "closed", 0);
        open(6, 20, "auto");
        close(6, "closed", 0);
        assert_eq!(dodge_streak(&d), 3);
        // Unknown (no close record) and manual sessions are transparent.
        open(7, 12, "auto"); // crashed mid-session — never counts, never resets
        open(8, 10, "manual");
        close(8, "closed", 0);
        assert_eq!(dodge_streak(&d), 3);
        // A rated close breaks the walk.
        open(9, 5, "auto");
        close(9, "closed", 1);
        assert_eq!(dodge_streak(&d), 0);
    }

    #[test]
    fn close_context_reports_strict_flag() {
        let d = db();
        assert!(!close_context(&d).unwrap().strict, "default is normal");
        set_settings(&d, &[("close_policy".into(), "strict".into())]).unwrap();
        assert!(close_context(&d).unwrap().strict);
    }

    #[test]
    fn close_context_reports_no_close_first_n_with_sane_defaults() {
        let d = db();
        let ctx = close_context(&d).unwrap();
        assert_eq!(ctx.no_close_first_n, 0, "default: every card closable");
        set_settings(&d, &[("no_close_first_n".into(), "2".into())]).unwrap();
        assert_eq!(close_context(&d).unwrap().no_close_first_n, 2);
        // 异常值不当真：非数字回落 0，超出上限钳到 10。
        set_settings(&d, &[("no_close_first_n".into(), "abc".into())]).unwrap();
        assert_eq!(close_context(&d).unwrap().no_close_first_n, 0);
        set_settings(&d, &[("no_close_first_n".into(), "99".into())]).unwrap();
        assert_eq!(close_context(&d).unwrap().no_close_first_n, 10);
    }

    #[test]
    fn compose_exam_draws_weakest_first_and_dedups_due_cards() {
        let d = db();
        let weak = add_card(&d, "A", "C", "弱", "x").unwrap();
        let mid = add_card(&d, "A", "C", "中", "x").unwrap();
        let strong = add_card(&d, "A", "C", "强", "x").unwrap();
        add_card(&d, "B", "C", "B1", "x").unwrap();
        add_card(&d, "B", "C", "B2", "x").unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        for (id, level) in [(weak.id, 1), (mid.id, 2), (strong.id, 3)] {
            d.0.execute(
                "UPDATE card SET state='review', level=?1, reps=?1, next_eligible_seq=0,
                 due_at=?2 WHERE id=?3",
                rusqlite::params![level, past, id],
            )
            .unwrap();
        }
        // 抽 A 包 2 张（最弱优先）→ 弱、中。
        let session = ReviewSession::default();
        let n = compose_exam(
            &d,
            &session,
            &[ExamPart {
                deck: "A".into(),
                count: 2,
            }],
            false,
            ExamStrategy::Weak,
        )
        .unwrap();
        assert_eq!(n, 2);
        let ids = session.lock().unwrap().take().unwrap();
        assert_eq!(ids, vec![weak.id, mid.id], "weakest first");
        // 含到期卡：A 的 3 张全部到期（level 1-2 各只算已到期），再抽 B 1 张。
        let session = ReviewSession::default();
        let n = compose_exam(
            &d,
            &session,
            &[ExamPart {
                deck: "B".into(),
                count: 1,
            }],
            true,
            ExamStrategy::Random,
        )
        .unwrap();
        assert!(n >= 3, "due cards ride along: {n}");
        let ids = session.lock().unwrap().take().unwrap();
        assert_eq!(
            ids.len(),
            ids.iter().collect::<HashSet<_>>().len(),
            "no dups"
        );
        // 空卡包 → 报错而不是空会话。
        let err = compose_exam(
            &d,
            &ReviewSession::default(),
            &[ExamPart {
                deck: "不存在".into(),
                count: 5,
            }],
            false,
            ExamStrategy::Weak,
        )
        .unwrap_err();
        assert!(err.contains("组卷结果为空"), "unexpected: {err}");
    }

    #[test]
    fn exam_presets_roundtrip() {
        let d = db();
        let id =
            save_exam_preset(&d, "每日 100", r#"{"parts":[{"deck":"A","count":20}]}"#).unwrap();
        let list = list_exam_presets(&d).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].1, "每日 100");
        // Upsert by name.
        save_exam_preset(&d, "每日 100", r#"{"parts":[]}"#).unwrap();
        assert_eq!(list_exam_presets(&d).unwrap().len(), 1);
        assert!(delete_exam_preset(&d, id).unwrap());
        assert!(list_exam_presets(&d).unwrap().is_empty());
    }

    #[test]
    fn attention_list_clear_and_reset() {
        let mut d = db();
        let c = add_card(&d, "D", "C", "难题", "x").unwrap();
        // Different chapter: no auto-chain, so propagation cannot affect it.
        let good = add_card(&d, "D", "C2", "好题", "x").unwrap();
        rate(&mut d, good.id, "familiar", None).unwrap();
        for _ in 0..3 {
            rate(&mut d, c.id, "unknown", None).unwrap();
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
    fn leech_propagates_to_immediate_neighbours() {
        let mut d = db();
        // Same chapter → auto-chained A—B—C; a fourth card lives elsewhere.
        let _a = add_card(&d, "D", "C", "甲", "x").unwrap();
        let b = add_card(&d, "D", "C", "乙", "x").unwrap();
        let _c = add_card(&d, "D", "C", "丙", "x").unwrap();
        let other = add_card(&d, "D", "别章", "无关卡", "x").unwrap();

        for _ in 0..3 {
            rate(&mut d, b.id, "unknown", None).unwrap();
        }
        let flagged: Vec<String> = attention_cards(&d)
            .unwrap()
            .iter()
            .map(|c| c.title.clone())
            .collect();
        // The failing card plus BOTH immediate neighbours — but not the outsider.
        assert_eq!(
            flagged.len(),
            3,
            "chain neighbours join the ⚠ list: {flagged:?}"
        );
        assert!(flagged.contains(&"乙".to_string()));
        assert!(flagged.contains(&"甲".to_string()));
        assert!(flagged.contains(&"丙".to_string()));
        assert!(!flagged.contains(&"无关卡".to_string()));
        assert!(!d.get_card(other.id).unwrap().unwrap().needs_attention);
    }

    #[test]
    fn attention_propagation_spares_high_levels() {
        let mut d = db();
        // Manual links: 弱—强 (level 4) and 弱2—中 (level 2).
        let weak = add_card(&d, "D", "C1", "弱卡", "x").unwrap();
        let strong = add_card(&d, "D", "C2", "强卡", "x").unwrap();
        let weak2 = add_card(&d, "D", "C3", "弱卡二", "x").unwrap();
        let mid = add_card(&d, "D", "C4", "中卡", "x").unwrap();
        add_card_link(&d, weak.id, strong.id).unwrap();
        add_card_link(&d, weak2.id, mid.id).unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        d.0.execute(
            "UPDATE card SET state='review', level=4, reps=5, due_at=?1 WHERE id=?2",
            rusqlite::params![past, strong.id],
        )
        .unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=2, reps=3, due_at=?1 WHERE id=?2",
            rusqlite::params![past, mid.id],
        )
        .unwrap();

        rate(&mut d, weak.id, "unknown", None).unwrap();
        for _ in 0..2 {
            rate(&mut d, weak.id, "familiar", None).unwrap();
            rate(&mut d, weak.id, "unknown", None).unwrap();
            rate(&mut d, weak.id, "familiar", None).unwrap();
        }
        // Two consecutive Unknowns now flag 弱卡…
        rate(&mut d, weak.id, "unknown", None).unwrap();
        rate(&mut d, weak.id, "unknown", None).unwrap();
        assert!(d.get_card(weak.id).unwrap().unwrap().needs_attention);
        assert!(
            !d.get_card(strong.id).unwrap().unwrap().needs_attention,
            "a level-4 neighbour is not dragged down by a weak link"
        );

        // …and the same failure on 弱卡二 still pulls its level-2 neighbour in.
        for _ in 0..3 {
            rate(&mut d, weak2.id, "familiar", None).unwrap();
            rate(&mut d, weak2.id, "unknown", None).unwrap();
        }
        rate(&mut d, weak2.id, "unknown", None).unwrap();
        rate(&mut d, weak2.id, "unknown", None).unwrap();
        assert!(d.get_card(mid.id).unwrap().unwrap().needs_attention);
    }

    #[test]
    fn popup_diversifies_chapters_and_linked_cards() {
        let d = db();
        let a = add_card(&d, "D", "章一", "甲", "x").unwrap();
        let b = add_card(&d, "D", "章二", "乙", "x").unwrap();
        let c = add_card(&d, "D", "章三", "丙", "x").unwrap();
        let e = add_card(&d, "D", "章四", "丁", "x").unwrap();
        add_card_link(&d, a.id, b.id).unwrap();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        for (id, seen) in [(a.id, 10), (b.id, 20), (c.id, 30), (e.id, 40)] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=?2 WHERE id=?3",
                rusqlite::params![past, seen, id],
            )
            .unwrap();
        }
        // 甲—乙 linked: 乙 waits for the next popup instead of leaking 甲's answer.
        let q = due_queue(&d, 10, 0.99).unwrap();
        assert_eq!(
            q.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["甲", "丙", "丁"],
            "linked card excluded, order kept"
        );

        // Same-chapter cap: 4 due cards in one chapter → at most 2 per popup.
        let d2 = db();
        let mut same_chapter = Vec::new();
        for t in ["一", "二", "三", "四"] {
            same_chapter.push(add_card(&d2, "D", "同章", t, "x").unwrap());
        }
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        for (i, card) in same_chapter.iter().enumerate() {
            d2.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=?2 WHERE id=?3",
                rusqlite::params![past, i as i64 * 10, card.id],
            )
            .unwrap();
        }
        assert_eq!(
            due_queue(&d2, 10, 0.99).unwrap().len(),
            2,
            "at most 2 cards per chapter per popup"
        );
    }

    /// SPEC §7.4/§16: 「每次弹窗卡片数」has exactly one value, whichever code
    /// path asks. It used to be read with three different defaults (1 in the
    /// popup, 3 in the engine and on the home page), so a user who never opened
    /// the settings field got a 1-card popup while the home page promised 3.
    #[test]
    fn per_popup_size_uses_one_default_for_every_reader() {
        let d = db();
        assert_eq!(
            per_popup_size(&d),
            PER_POPUP_DEFAULT,
            "unset key → one documented default, never 1"
        );
        for (stored, expected) in [
            ("4", 4),
            ("1", 1),
            ("0", 1),   // a zero-card session is not a session
            ("99", 5),  // SPEC §16 range is 1~5
            ("-3", 3),  // unparsable → default
            ("abc", 3), // unparsable → default
        ] {
            set_settings(&d, &[("per_popup".into(), stored.into())]).unwrap();
            assert_eq!(
                per_popup_size(&d),
                expected,
                "per_popup={stored:?} must resolve to {expected}"
            );
        }
    }

    /// SPEC §7.4: the dodge penalty is a CAP — it can only shrink the session,
    /// never raise it above what the user asked for.
    #[test]
    fn session_size_is_capped_by_the_dodge_penalty_never_raised() {
        assert_eq!(session_size(4, 0), 4, "no penalty: the setting rules");
        assert_eq!(session_size(4, 1), 1, "penalty caps the session to 1");
        assert_eq!(
            session_size(1, 3),
            1,
            "the penalty is a cap, not an override: it never grows the session"
        );
        assert_eq!(session_size(9, 0), PER_POPUP_MAX, "clamped to 1~5");
        assert_eq!(
            session_size(0, 0),
            PER_POPUP_MIN,
            "never a zero-card session"
        );
    }

    /// SPEC §7.4: the session must reach N cards even when the top of the
    /// priority window is dropped by the diversifier (同章节 ≤ 2). The pools are
    /// therefore over-fetched and the session is truncated only afterwards.
    #[test]
    fn due_queue_backfills_what_diversity_drops() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        // Highest-priority window: three cards of ONE chapter (smallest
        // last_seen_seq wins), then three singles in other chapters.
        for (i, title) in ["同章一", "同章二", "同章三"].iter().enumerate() {
            let c = add_card(&d, "D", "同章", title, "x").unwrap();
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=?2 WHERE id=?3",
                rusqlite::params![past, i as i64, c.id],
            )
            .unwrap();
        }
        for (i, (chapter, title)) in [("章二", "乙"), ("章三", "丙"), ("章四", "丁")]
            .iter()
            .enumerate()
        {
            let c = add_card(&d, "D", chapter, title, "x").unwrap();
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=?2 WHERE id=?3",
                rusqlite::params![past, 10 + i as i64, c.id],
            )
            .unwrap();
        }
        let q = due_queue(&d, 3, 0.99).unwrap();
        assert_eq!(
            q.len(),
            3,
            "6 eligible candidates and N=3 → 3 cards (a same-chapter collision \
             in the priority window must be backfilled, not silently dropped)"
        );
        assert_eq!(
            q.iter().filter(|c| c.chapter == "同章").count(),
            2,
            "同章节 ≤ 2 still holds"
        );
    }

    /// SPEC §7.4: 候选不足 N 张则按实际数量展示 — that is the only legitimate
    /// way a session can be shorter than the setting.
    #[test]
    fn due_queue_shows_every_candidate_when_the_pool_is_short() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        for (chapter, title) in [("章一", "甲"), ("章二", "乙")] {
            let c = add_card(&d, "D", chapter, title, "x").unwrap();
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=1 WHERE id=?2",
                rusqlite::params![past, c.id],
            )
            .unwrap();
        }
        assert_eq!(
            due_queue(&d, 5, 0.99).unwrap().len(),
            2,
            "候选不足 N 张则少展示"
        );
    }

    /// SPEC §7.4/§8.2: 每次张数与逃避封顶都只作用于自动弹窗的 due 队列；
    /// 手动入口（复习选中/学新卡/组卷）走显式会话，一张不少。
    #[test]
    fn explicit_session_ignores_the_session_size_cap() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let mut ids = Vec::new();
        for (i, chapter) in ["章一", "章二", "章三", "章四"].iter().enumerate() {
            let c = add_card(&d, "D", chapter, &format!("卡{i}"), "x").unwrap();
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=1, next_eligible_seq=0,
                 due_at=?1, last_seen_seq=1 WHERE id=?2",
                rusqlite::params![past, c.id],
            )
            .unwrap();
            ids.push(c.id);
        }
        let slot: ReviewSession = std::sync::Mutex::new(None);
        set_review_session(&slot, ids);
        assert_eq!(
            review_queue(&d, &slot, session_size(4, 1)).unwrap().len(),
            4,
            "a manual selection is served in full, whatever the cap says"
        );
    }

    // ---- 「待复习」口径 (SPEC §14/§15.2, 2026-10-06 F5) ----

    /// SPEC §14: 「待复习」是一个谓词、一个数字。这条就是 F5 的起点 —— 首页说
    /// 有几张，弹窗在候选足够时就得拿得出几张；未到期的卡两边都不算。
    #[test]
    fn due_count_uses_the_popup_predicate() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let later = db::fmt_time(Utc::now() + chrono::Duration::hours(3));
        // ⚠ 重点卡：计数器门槛与时间下限都满足 → 算待复习。
        let flagged = add_card(&d, "D", "C1", "重点卡", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=3, needs_attention=1,
             next_eligible_seq=0, due_at=?1 WHERE id=?2",
            rusqlite::params![past, flagged.id],
        )
        .unwrap();
        // 未到期新卡：时间下限还没到 → 不算待复习，也不进弹窗。
        let fresh = add_card(&d, "D", "C2", "新卡", "x").unwrap();
        d.0.execute(
            "UPDATE card SET due_at=?1 WHERE id=?2",
            rusqlite::params![later, fresh.id],
        )
        .unwrap();

        assert_eq!(due_count(&d).unwrap(), 1, "池里只有那张 ⚠ 卡");
        assert_eq!(get_stats(&d).unwrap().due_count, 1, "首页数字");
        assert_eq!(list_overview(&d).unwrap()[0].due_count, 1, "卡包列表数字");
        assert_eq!(
            due_queue(&d, 3, 0.99).unwrap().len(),
            1,
            "弹窗拿到的张数 = 待复习（候选足够时）"
        );
    }

    /// SPEC §14/§15.2: 「到期」筛选必须与「待复习」同义。它以前把**归档卡**也算
    /// 进去（归档有自己的筛选项），于是从首页「待复习」点进去的列表比数字还长。
    #[test]
    fn due_filter_excludes_archived_like_every_other_due_count() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let live = add_card(&d, "D", "C1", "活卡", "x").unwrap();
        let gone = add_card(&d, "D", "C2", "归档卡", "x").unwrap();
        for id in [live.id, gone.id] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=2, next_eligible_seq=0,
                 due_at=?1 WHERE id=?2",
                rusqlite::params![past, id],
            )
            .unwrap();
        }
        d.0.execute("UPDATE card SET state='archived' WHERE id=?1", [gone.id])
            .unwrap();

        assert_eq!(due_count(&d).unwrap(), 1);
        assert_eq!(list_overview(&d).unwrap()[0].due_count, 1);
        assert_eq!(
            search_cards(&d, None, None, Some("due".into()))
                .unwrap()
                .len(),
            1,
            "「到期」列表不能比「待复习」数字长"
        );
        assert_eq!(due_cards_of_deck(&d, "D").unwrap().len(), 1, "复习该包");
        assert_eq!(
            search_cards(&d, None, None, Some("archived".into()))
                .unwrap()
                .len(),
            1,
            "归档卡仍然有自己的筛选入口"
        );
    }

    /// SPEC §6/§14: 暂停（suspended）卡不出现在任何「待复习」口径里，也不进弹窗。
    #[test]
    fn suspended_cards_are_out_of_every_due_number() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let c = add_card(&d, "D", "C", "暂停卡", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='suspended', level=1, reps=2, next_eligible_seq=0,
             due_at=?1 WHERE id=?2",
            rusqlite::params![past, c.id],
        )
        .unwrap();

        assert_eq!(due_count(&d).unwrap(), 0);
        assert_eq!(get_stats(&d).unwrap().due_count, 0);
        assert_eq!(list_overview(&d).unwrap()[0].due_count, 0);
        assert!(due_queue(&d, 3, 0.99).unwrap().is_empty());
        assert!(search_cards(&d, None, None, Some("due".into()))
            .unwrap()
            .is_empty());
    }

    /// SPEC §14/§15.2: 每包 dueCount 与首页「待复习」共用一份谓词，所以各包之和
    /// 必须等于首页那个数（归档/未到期卡在两边都不算）。
    #[test]
    fn deck_due_counts_sum_to_the_home_page_number() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let later = db::fmt_time(Utc::now() + chrono::Duration::hours(3));
        for (deck, chapter, title, state, due) in [
            ("甲包", "C1", "甲1", "review", past.as_str()),
            ("甲包", "C2", "甲2", "review", past.as_str()),
            ("甲包", "C3", "甲归档", "archived", past.as_str()),
            ("乙包", "C1", "乙1", "review", past.as_str()),
            ("乙包", "C2", "乙未到期", "review", later.as_str()),
        ] {
            let c = add_card(&d, deck, chapter, title, "x").unwrap();
            d.0.execute(
                "UPDATE card SET state=?1, level=1, reps=2, next_eligible_seq=0, due_at=?2
                 WHERE id=?3",
                rusqlite::params![state, due, c.id],
            )
            .unwrap();
        }
        let overview = list_overview(&d).unwrap();
        let per_deck: Vec<(&str, i64)> = overview
            .iter()
            .map(|o| (o.name.as_str(), o.due_count))
            .collect();
        assert_eq!(
            per_deck,
            vec![("乙包", 1), ("甲包", 2)],
            "每包各自数自己的到期卡"
        );
        assert_eq!(
            per_deck.iter().map(|(_, n)| *n).sum::<i64>(),
            get_stats(&d).unwrap().due_count,
            "各包之和 = 首页「待复习」"
        );
        assert_eq!(due_count(&d).unwrap(), 3);
    }

    /// SPEC §7.4/§14: 待复习数的是**池**；一次弹窗只从池里抽
    /// `min(每次弹窗卡片数, 池)`，新卡还要过「每次会话上限」。所以"池 5 张、
    /// 弹窗 1 张"是配额切片，不是计数错误——把上限放开就抽满。
    #[test]
    fn due_count_is_the_pool_the_popup_draws_from() {
        let d = db();
        for i in 0..5 {
            add_card(&d, "D", &format!("章{i}"), &format!("新{i}"), "x").unwrap();
        }
        assert_eq!(due_count(&d).unwrap(), 5, "5 张新卡都是待复习（池）");
        assert_eq!(
            due_queue(&d, 3, 0.99).unwrap().len(),
            1,
            "默认「每次弹窗新卡上限」=1：池里 5 张也只带 1 张"
        );
        set_settings(&d, &[("session_new_limit".into(), "3".into())]).unwrap();
        assert_eq!(due_queue(&d, 3, 0.99).unwrap().len(), 3, "上限放开就抽满");
        assert!(
            due_queue(&d, 3, 0.99).unwrap().len() as i64 <= due_count(&d).unwrap(),
            "待复习永远是单次弹窗张数的上界"
        );
    }

    /// SPEC §7.4 第 5 条：维护卡（等级 ≥ 3）同样是待复习卡，并由它补足弹窗。
    #[test]
    fn maintenance_cards_count_as_due_and_fill_the_popup() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let m = add_card(&d, "D", "C", "维护卡", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=4, reps=9, next_eligible_seq=0,
             due_at=?1 WHERE id=?2",
            rusqlite::params![past, m.id],
        )
        .unwrap();
        assert_eq!(due_count(&d).unwrap(), 1);
        assert_eq!(due_queue(&d, 3, 0.99).unwrap().len(), 1);
    }

    /// SPEC §7.4 第 1 条/§7.3: ⚠ 卡的"冷却"就是它自己的计数器门槛——门槛没开时
    /// 既不算待复习也不进弹窗；展示够别的卡、门槛开了才算。
    #[test]
    fn attention_cooldown_keeps_a_flagged_card_out_until_its_gate_opens() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let c = add_card(&d, "D", "C", "重点卡", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=3, needs_attention=1,
             next_eligible_seq=5, due_at=?1 WHERE id=?2",
            rusqlite::params![past, c.id],
        )
        .unwrap();
        assert_eq!(due_count(&d).unwrap(), 0, "回访距离没走完 → 不算待复习");
        // 引擎因此不会自动弹（due_count == 0 → Skip(NotDue)）。手动「立即复习」
        // 走的是同一条 due 门，所以也不会开；池空兜底（§7.4 第 6 条）只在
        // 弹窗已经开着、需要补位时才把它端出来。
        use chrono::TimeZone;
        let at10 = chrono::Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                    .unwrap()
                    .and_hms_opt(10, 0, 0)
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            crate::engine::decide(crate::engine::DecisionInput {
                due_count: due_count(&d).unwrap() as usize,
                now: at10,
                settings: crate::engine::EngineSettings::default(),
                popup_open: false,
                last_popup_at: None,
                today_popups: 0,
                effective_interval_min: 20,
                force: true,
            }),
            crate::engine::Decision::Skip(crate::engine::SkipReason::NotDue),
            "连手动触发也过不了 due 门"
        );

        for _ in 0..5 {
            mark_shown(&d, c.id).unwrap();
        }
        assert_eq!(due_count(&d).unwrap(), 1, "门槛开了才算");
        assert_eq!(due_queue(&d, 3, 0.99).unwrap().len(), 1);
    }

    /// SPEC §7.4/§14: 「待复习」数的是池，而池里可能一张都抽不出来——典型是
    /// 池里只剩新卡、而当日新卡配额已经用完。此时开窗就是一扇空窗（前端会立刻
    /// 自关），还白吃掉一次 popup_log 与整个弹窗间隔，所以引擎先问
    /// [`popup_has_content`]。
    #[test]
    fn popup_has_content_is_false_when_only_quota_blocked_new_cards_remain() {
        let d = db();
        for i in 0..3 {
            add_card(&d, "D", &format!("章{i}"), &format!("新{i}"), "x").unwrap();
        }
        assert_eq!(due_count(&d).unwrap(), 3, "3 张新卡都在待复习池里");
        assert!(popup_has_content(&d, 3), "配额还没用 → 弹窗有内容");

        // 假装今天已经引进 15 张新卡（每日新卡上限默认 15）→ 新卡池被关。
        for _ in 0..15 {
            d.0.execute(
                "INSERT INTO review_log(card_id, rating, state_before, reviewed_at)
                 VALUES(1, 2, 'new', ?1)",
                [db::fmt_time(Utc::now() - chrono::Duration::hours(1))],
            )
            .unwrap();
        }
        assert_eq!(
            due_count(&d).unwrap(),
            3,
            "它们仍然是待复习（只是今天不再引入）"
        );
        assert!(due_queue(&d, 3, 0.99).unwrap().is_empty(), "一张也抽不出来");
        assert!(
            !popup_has_content(&d, 3),
            "抽不出卡就不该开窗：空弹窗一闪即关，还吃掉 popup_log 与弹窗间隔"
        );
    }

    /// SPEC §14/§8.5: 待复习是"池"，与学习时段无关（时段外照样可以手动复习）；
    /// "现在弹不弹"是引擎的门（§8.2），不属于计数。
    #[test]
    fn due_count_is_independent_of_the_study_hours_gate() {
        let d = db();
        let past = db::fmt_time(Utc::now() - chrono::Duration::minutes(5));
        let c = add_card(&d, "D", "C", "T", "x").unwrap();
        d.0.execute(
            "UPDATE card SET state='review', level=1, reps=2, next_eligible_seq=0,
             due_at=?1 WHERE id=?2",
            rusqlite::params![past, c.id],
        )
        .unwrap();
        assert_eq!(due_count(&d).unwrap(), 1, "池里的卡与时刻无关");

        use chrono::TimeZone;
        let at3 = chrono::Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                    .unwrap()
                    .and_hms_opt(3, 0, 0)
                    .unwrap(),
            )
            .unwrap();
        let input = crate::engine::DecisionInput {
            due_count: due_count(&d).unwrap() as usize,
            now: at3,
            settings: crate::engine::EngineSettings::default(),
            popup_open: false,
            last_popup_at: None,
            today_popups: 0,
            effective_interval_min: 20,
            force: false,
        };
        assert_eq!(
            crate::engine::decide(input),
            crate::engine::Decision::Skip(crate::engine::SkipReason::OutsideStudyHours),
            "03:00 在默认时段 09:00–22:30 之外：不弹，但待复习数字照旧"
        );
    }

    #[test]
    fn archive_waits_for_linked_neighbours_and_doubles_the_gap() {
        let mut d = db();
        let a = add_card(&d, "D", "C", "A", "x").unwrap();
        let b = add_card(&d, "D", "C", "B", "x").unwrap();

        // A passes every personal gate, but the linked neighbour B is weak —
        // the chain gate refuses, and A's next gap doubles instead of idling
        // at the same rung. prime sets level 2 → speakable gap max(10, 20)=20,
        // ±20% jitter → [16, 24]; doubled → [32, 48].
        prime_almost_archived(&d, a.id);
        rate(&mut d, a.id, "speakable", None).unwrap();
        let card = d.get_card(a.id).unwrap().unwrap();
        assert_eq!(card.state, "review", "A waits for its linked neighbour");
        let seq = d.show_count().unwrap();
        let gap = (card.next_eligible_seq - seq) as u64;
        assert!(
            (32..=48).contains(&gap),
            "chain-denied gap doubles the jittered gap, got {gap}"
        );

        // B graduates on its own streak; A follows on its next Speakable.
        prime_almost_archived(&d, b.id);
        rate(&mut d, b.id, "speakable", None).unwrap();
        assert_eq!(d.get_card(b.id).unwrap().unwrap().state, "archived");
        prime_almost_archived(&d, a.id);
        rate(&mut d, a.id, "speakable", None).unwrap();
        assert_eq!(d.get_card(a.id).unwrap().unwrap().state, "archived");
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
