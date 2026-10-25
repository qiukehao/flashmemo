//! SQLite persistence per SPEC §14: schema, migrations and the small DAO the
//! rest of the app talks to. All timestamps are RFC3339 UTC strings, which keeps
//! lexicographic comparison in SQL correct.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

pub struct Db(pub Connection, SeqCache);

/// Cached `COUNT(card_show_log)` — the global display counter is read on every
/// 15s engine tick and every queue build; a plain `COUNT(*)` full-scans the
/// ever-growing show log. Invalidated (negative) whenever rows are removed.
#[derive(Default)]
pub struct SeqCache(AtomicI64);

impl SeqCache {
    fn load_or_compute<F: FnOnce() -> rusqlite::Result<i64>>(
        &self,
        compute: F,
    ) -> rusqlite::Result<i64> {
        let cached = self.0.load(Ordering::Relaxed);
        if cached >= 0 {
            return Ok(cached);
        }
        let n = compute()?;
        self.0.store(n, Ordering::Relaxed);
        Ok(n)
    }

    fn bump(&self) {
        // fetch_update 在新 Rust 被改名（try_update）——compare_exchange_weak 循环
        // 在新旧版本都稳定，语义一致：+1，溢出/负值保持原值。
        let mut cur = self.0.load(Ordering::Relaxed);
        while let Some(next) = cur.checked_add(1).filter(|n| *n >= 0) {
            match self
                .0
                .compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => return,
                Err(actual) => cur = actual,
            }
        }
    }

    fn invalidate(&self) {
        self.0.store(-1, Ordering::Relaxed);
    }
}

/// Highest schema version this build migrates to.
pub const LATEST_VERSION: i64 = 8;

#[derive(Debug, Clone)]
pub struct NewCard {
    pub deck: String,
    pub chapter: String,
    pub title: String,
    pub content_md: String,
    /// 题面 (SPEC §5.2 rule 10, 需求7): the question side when it is more than a
    /// one-line title (image / long stem). Empty for `###` cards.
    pub front_md: String,
    pub source_file: Option<String>,
}

/// Full card row. `state` is the raw SPEC §14 value
/// (new/learning/review/relearning/suspended/archived); the scheduler owns its
/// own typed enum and converts at the boundary.
#[derive(Debug, Clone)]
pub struct Card {
    pub id: i64,
    pub deck: String,
    pub chapter: String,
    pub title: String,
    pub content_md: String,
    /// 题面 (migration v8, 需求7). Empty = the front is just `title`.
    pub front_md: String,
    pub state: String,
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub due_at: DateTime<Utc>,
    pub last_review_at: Option<DateTime<Utc>>,
    pub reps: i64,
    pub lapses: i64,
    pub leech: bool,
    pub locally_edited: bool,
    pub learning_step: i64,
    pub source_file: Option<String>,
    /// Fixed-multiplier scheduler state (migration v2): planned interval in
    /// minutes; None = never scheduled (new card).
    pub interval_minutes: Option<i64>,
    pub unknown_streak: i64,
    pub speak_streak: i64,
    pub needs_attention: bool,
    /// Sequence-based scheduler state (migration v3): proficiency level and
    /// "reappear after N shown cards" counters.
    pub level: i64,
    pub next_eligible_seq: i64,
    pub last_seen_seq: i64,
    /// Stable cross-install identity (migration v5, deck sharing). Local row
    /// ids are autoincrement and NOT stable across exports/merges.
    pub uid: String,
    /// Study day (rolls at 04:00 local) when the level was last raised —
    /// 每天最多升 1 级 (migration v6). NULL = never leveled.
    pub level_up_day: Option<String>,
    /// Distinct study days of the current speakable streak (CSV) — archive
    /// needs 3 speakables on 3 different days (migration v6).
    pub speak_days: String,
    /// Archived spot-check weight booster: a "familiar" at a spot check raises
    /// the chance of being picked again (migration v6).
    pub spot_bias: i64,
}

pub fn fmt_time(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// One closed popup session (close-policy input, 2026-10-04).
#[derive(Debug, Clone)]
pub struct PopupSessionRow {
    pub opened_at: DateTime<Utc>,
    pub close_reason: Option<String>,
    pub rated: Option<i64>,
    pub origin: String,
}

/// 组卷抽卡策略 (2026-10-04)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExamStrategy {
    /// 最弱优先：等级低、复习次数少的卡先来（同级随机）。
    Weak,
    /// 随机。
    Random,
}

/// Study day of a timestamp: the calendar day of `local time − 4h` — the day
/// rolls at 04:00 local (Anki's convention) so a just-past-midnight session
/// still counts towards the previous day's quotas. Kept next to the DAO so
/// rate/goal/popup-cap code all share one definition.
pub fn study_day_of(t: DateTime<Utc>) -> String {
    (t.with_timezone(&chrono::Local) - chrono::Duration::hours(4))
        .format("%Y-%m-%d")
        .to_string()
}

/// Best-effort copy of `data.db` before a schema migration rewrites it
/// (2026-10-04 review: a half-failed migration must never cost user data).
/// Skips brand-new files (version 0) — there is nothing to protect yet.
fn pre_migration_backup(path: &Path) {
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    drop(file);
    let Ok(conn) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return;
    };
    let version: i64 = match conn.query_row("PRAGMA user_version", [], |r| r.get(0)) {
        Ok(v) => v,
        Err(_) => return,
    };
    drop(conn);
    if version == 0 || version >= LATEST_VERSION {
        return;
    }
    let backup = path.with_extension(format!("db.pre-migration-v{version}.bak"));
    match std::fs::copy(path, &backup) {
        Ok(_) => log::info!("[db] pre-migration backup: {}", backup.display()),
        Err(e) => log::warn!("[db] pre-migration backup failed: {e}"),
    }
}

/// Parse a stored timestamp. Stored timestamps are always RFC3339 (fmt_time);
/// a malformed value (legacy data, partial write) must degrade gracefully
/// instead of panicking — a panic while the DB mutex is held poisons the lock
/// and cascades into app-wide failures (reported as 闪退, fixed 2026-10-03).
pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    match DateTime::parse_from_rfc3339(s) {
        Ok(t) => Some(t.with_timezone(&Utc)),
        Err(_) => {
            log::warn!("malformed timestamp in database: {s:?}");
            None
        }
    }
}

/// Escapes LIKE wildcards so user input matches literally.
fn like_pattern(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

const SCHEMA_V1: &str = r#"
CREATE TABLE deck (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  chain_by_order INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE chapter (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  order_idx INTEGER NOT NULL
);

CREATE TABLE card (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL REFERENCES chapter(id),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  stability REAL,
  difficulty REAL,
  due_at TEXT NOT NULL,
  last_review_at TEXT,
  reps INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  leech INTEGER DEFAULT 0,
  locally_edited INTEGER DEFAULT 0,
  learning_step INTEGER NOT NULL DEFAULT 0,
  source_file TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(chapter_id, title)
);

CREATE TABLE card_link (
  from_card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  to_card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  PRIMARY KEY (from_card_id, to_card_id)
);

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  state_before TEXT NOT NULL,
  stability REAL, difficulty REAL,
  scheduled_interval TEXT,
  elapsed_ms INTEGER,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX idx_card_due ON card(due_at);
CREATE INDEX idx_card_state ON card(state);
CREATE INDEX idx_review_log_card ON review_log(card_id);
"#;

/// v2 (2026-09-28): fixed-multiplier scheduler state + display throttling log.
/// Existing FSRS-era cards keep their planned interval (derived from due_at and
/// last_review_at) so no card loses its place in the queue.
const SCHEMA_V2: &str = r#"
ALTER TABLE card ADD COLUMN interval_minutes INTEGER;
ALTER TABLE card ADD COLUMN unknown_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card ADD COLUMN speak_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;

CREATE TABLE card_show_log (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  shown_at TEXT NOT NULL
);
CREATE INDEX idx_show_log_card ON card_show_log(card_id, shown_at);

UPDATE card
   SET interval_minutes =
       CAST(MAX(1, ROUND((julianday(due_at) - julianday(last_review_at)) * 1440)) AS INTEGER)
 WHERE last_review_at IS NOT NULL AND interval_minutes IS NULL;

UPDATE card SET state = 'review' WHERE state IN ('learning', 'relearning');
"#;

/// v3 (2026-09-28, 2nd scheduler revision): "reappear after N shown cards".
/// `review_seq` is derived from `COUNT(card_show_log)`, so only per-card
/// counters are added here. Existing cards become immediately eligible —
/// time is no longer the primary scheduling axis.
const SCHEMA_V3: &str = r#"
ALTER TABLE card ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card ADD COLUMN next_eligible_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card ADD COLUMN last_seen_seq INTEGER NOT NULL DEFAULT 0;

-- Cards already in the rotation start at level 1 (刚接触).
UPDATE card SET level = 1 WHERE reps > 0;

-- Drop the FSRS-era time floors: eligibility is now counter-based.
UPDATE card SET due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE state NOT IN ('suspended', 'archived');
"#;

/// v4 (2026-10-01): overload protection (SPEC §7.8) — one row per popup
/// session that actually opened, so the daily popup cap survives restarts.
/// `IF NOT EXISTS` keeps the step idempotent if a previous run died between
/// the batch and the version bump.
const SCHEMA_V4: &str = r#"
CREATE TABLE IF NOT EXISTS popup_log (
  id INTEGER PRIMARY KEY,
  opened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_popup_log_opened ON popup_log(opened_at);
"#;

/// v5 (2026-10-04, external algorithm review): stable card identity for future
/// deck sharing, the speakable-streak start (archive span gate), archived
/// spot-check counter, and richer review_log rows (FSRS training data).
const SCHEMA_V5: &str = r#"
ALTER TABLE card ADD COLUMN uid TEXT NOT NULL DEFAULT '';
ALTER TABLE card ADD COLUMN speak_streak_started_at TEXT;
ALTER TABLE card ADD COLUMN spot_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_log ADD COLUMN source TEXT NOT NULL DEFAULT 'popup';
ALTER TABLE review_log ADD COLUMN level_before INTEGER;
ALTER TABLE review_log ADD COLUMN level_after INTEGER;
ALTER TABLE review_log ADD COLUMN seq_at INTEGER;
ALTER TABLE review_log ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_review_log_reviewed ON review_log(reviewed_at);
"#;

/// v6 (2026-10-04, "时间只记账，不催债" rework): per-day level-up guard,
/// distinct-day archive tracking, spot-check weight bias, and the popup
/// session table for the upcoming close-policy feature.
const SCHEMA_V6: &str = r#"
ALTER TABLE card ADD COLUMN level_up_day TEXT;
ALTER TABLE card ADD COLUMN speak_days TEXT NOT NULL DEFAULT '';
ALTER TABLE card ADD COLUMN spot_bias INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS popup_session (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  shown INTEGER,
  rated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_popup_session_opened ON popup_session(opened_at);
"#;

/// v7 (2026-10-04, close-policy & exam features): session origin so only
/// auto-popups count as dodges, and the exam preset store for 组卷.
const SCHEMA_V7: &str = r#"
ALTER TABLE popup_session ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto';
CREATE TABLE IF NOT EXISTS exam_preset (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"#;

/// v8 (2026-10-07, 需求7 题面卡): `front_md` carries the question side when it is
/// more than a one-line title (图片型/长题干卡面). Empty for every pre-existing
/// card and for every `###` card, so the old front (`title`) renders unchanged;
/// rolling back is just "stop reading the column" (SQLite's DROP COLUMN would
/// rebuild the table — worse than a harmless unused column).
const SCHEMA_V8: &str = r#"
ALTER TABLE card ADD COLUMN front_md TEXT NOT NULL DEFAULT '';
"#;

/// Does `table` already have `column`? `ALTER TABLE ... ADD COLUMN` has no
/// `IF NOT EXISTS`, so a migration that adds one must probe first: a run that
/// failed halfway must stay re-runnable (same style as the v4 migration).
fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        pre_migration_backup(path);
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Db::migrate(&conn)?;
        Ok(Db(conn, SeqCache::default()))
    }

    pub fn open_in_memory() -> rusqlite::Result<Db> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Db::migrate(&conn)?;
        Ok(Db(conn, SeqCache::default()))
    }

    fn migrate(conn: &Connection) -> rusqlite::Result<()> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(SCHEMA_V1)?;
            conn.pragma_update(None, "user_version", 1)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 2 {
            conn.execute_batch(SCHEMA_V2)?;
            conn.pragma_update(None, "user_version", 2)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 3 {
            conn.execute_batch(SCHEMA_V3)?;
            conn.pragma_update(None, "user_version", 3)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 4 {
            conn.execute_batch(SCHEMA_V4)?;
            conn.pragma_update(None, "user_version", 4)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 5 {
            conn.execute_batch(SCHEMA_V5)?;
            // Stable ids for cards created before v5 (deck sharing needs them).
            let ids: Vec<i64> = {
                let mut stmt = conn.prepare("SELECT id FROM card WHERE uid = ''")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<i64>>>()?
            };
            for id in ids {
                conn.execute(
                    "UPDATE card SET uid = ?1 WHERE id = ?2",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), id],
                )?;
            }
            // Existing speakable streaks have an unknown start — the best
            // available approximation is the last review.
            conn.execute(
                "UPDATE card SET speak_streak_started_at = last_review_at
                 WHERE speak_streak > 0 AND speak_streak_started_at IS NULL
                   AND last_review_at IS NOT NULL",
                [],
            )?;
            conn.pragma_update(None, "user_version", 5)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 6 {
            conn.execute_batch(SCHEMA_V6)?;
            // In-flight speakable streaks may already span days we cannot
            // reconstruct; seed them with today so they need threshold-1 more
            // distinct days to archive.
            conn.execute(
                "UPDATE card SET speak_days = ?1
                 WHERE speak_streak > 0 AND speak_days = ''",
                [study_day_of(Utc::now())],
            )?;
            conn.pragma_update(None, "user_version", 6)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 7 {
            conn.execute_batch(SCHEMA_V7)?;
            conn.pragma_update(None, "user_version", 7)?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 8 {
            if !has_column(conn, "card", "front_md")? {
                conn.execute_batch(SCHEMA_V8)?;
            }
            conn.pragma_update(None, "user_version", 8)?;
        }
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let mut stmt = self
            .0
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.0.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    pub fn list_settings(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = self
            .0
            .prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub(crate) fn upsert_deck(&self, name: &str, now: DateTime<Utc>) -> rusqlite::Result<i64> {
        self.0.execute(
            "INSERT INTO deck(name, created_at) VALUES(?1, ?2)
             ON CONFLICT(name) DO NOTHING",
            [name, &fmt_time(now)],
        )?;
        self.0
            .query_row("SELECT id FROM deck WHERE name = ?1", [name], |r| r.get(0))
    }

    pub(crate) fn upsert_chapter(&self, deck_id: i64, name: &str) -> rusqlite::Result<i64> {
        let existing: Option<i64> = self
            .0
            .query_row(
                "SELECT id FROM chapter WHERE deck_id = ?1 AND name = ?2",
                rusqlite::params![deck_id, name],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let next: i64 = self.0.query_row(
            "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM chapter WHERE deck_id = ?1",
            [deck_id],
            |r| r.get(0),
        )?;
        self.0.execute(
            "INSERT INTO chapter(deck_id, name, order_idx) VALUES(?1, ?2, ?3)",
            rusqlite::params![deck_id, name, next],
        )?;
        Ok(self.0.last_insert_rowid())
    }

    /// Insert a brand-new card: state `new`, due at `now` by default. Deck and
    /// chapter are looked up (and created) by name; repeated names reuse rows.
    pub fn insert_card(&self, new: &NewCard, now: DateTime<Utc>) -> rusqlite::Result<i64> {
        let deck_id = self.upsert_deck(&new.deck, now)?;
        let chapter_id = self.upsert_chapter(deck_id, &new.chapter)?;
        self.0.execute(
            "INSERT INTO card(deck_id, chapter_id, title, content_md, front_md, due_at, source_file,
             created_at, uid)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                deck_id,
                chapter_id,
                new.title,
                new.content_md,
                new.front_md,
                fmt_time(now),
                new.source_file,
                fmt_time(now),
                uuid::Uuid::new_v4().to_string(),
            ],
        )?;
        Ok(self.0.last_insert_rowid())
    }

    fn row_to_card(row: &rusqlite::Row) -> rusqlite::Result<Card> {
        Ok(Card {
            id: row.get("id")?,
            deck: row.get("deck")?,
            chapter: row.get("chapter")?,
            title: row.get("title")?,
            content_md: row.get("content_md")?,
            front_md: row.get("front_md")?,
            state: row.get("state")?,
            stability: row.get("stability")?,
            difficulty: row.get("difficulty")?,
            // A corrupted due_at degrades to "due now": the card shows up for
            // review again rather than vanishing or crashing the read.
            due_at: parse_time(&row.get::<_, String>("due_at")?).unwrap_or_else(Utc::now),
            last_review_at: row
                .get::<_, Option<String>>("last_review_at")?
                .and_then(|s| parse_time(&s)),
            reps: row.get("reps")?,
            lapses: row.get("lapses")?,
            leech: row.get::<_, i64>("leech")? != 0,
            locally_edited: row.get::<_, i64>("locally_edited")? != 0,
            learning_step: row.get("learning_step")?,
            source_file: row.get("source_file")?,
            interval_minutes: row.get("interval_minutes")?,
            unknown_streak: row.get("unknown_streak")?,
            speak_streak: row.get("speak_streak")?,
            needs_attention: row.get::<_, i64>("needs_attention")? != 0,
            level: row.get("level")?,
            next_eligible_seq: row.get("next_eligible_seq")?,
            last_seen_seq: row.get("last_seen_seq")?,
            uid: row.get("uid")?,
            level_up_day: row.get("level_up_day")?,
            speak_days: row.get("speak_days")?,
            spot_bias: row.get("spot_bias")?,
        })
    }

    const CARD_SELECT: &str =
        "SELECT c.id, d.name AS deck, ch.name AS chapter, c.title, c.content_md, c.front_md,
        c.state, c.stability, c.difficulty, c.due_at, c.last_review_at, c.reps, c.lapses,
        c.leech, c.locally_edited, c.learning_step, c.source_file,
        c.interval_minutes, c.unknown_streak, c.speak_streak, c.needs_attention,
        c.level, c.next_eligible_seq, c.last_seen_seq,
        c.uid, c.level_up_day, c.speak_days, c.spot_bias
        FROM card c JOIN deck d ON d.id = c.deck_id JOIN chapter ch ON ch.id = c.chapter_id";

    pub fn get_card(&self, id: i64) -> rusqlite::Result<Option<Card>> {
        let sql = format!("{} WHERE c.id = ?1", Self::CARD_SELECT);
        let mut stmt = self.0.prepare(&sql)?;
        let mut rows = stmt.query([id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Self::row_to_card(row)?)),
            None => Ok(None),
        }
    }

    /// **The** due predicate (SPEC §14「待复习」口径): the card's sequence gate is
    /// reached, its time floor has passed, and the card is still in rotation.
    ///
    /// Every "how many cards are due?" answer is built from this one string — the
    /// popup pools, the home page / tray / engine count, the per-deck due count
    /// and the 到期 filter. They used to carry four hand-written copies
    /// (2026-10-06 F5), and the 到期 filter had drifted far enough to include
    /// archived cards: the list opened from 「待复习」 was longer than the number.
    ///
    /// Time never forces a card out — a starved pool falls back to nearest-seq
    /// instead (SPEC §7.4 池空兜底).
    pub fn due_predicate(seq_param: usize, now_param: usize) -> String {
        format!(
            "c.state NOT IN ('suspended', 'archived')
             AND c.next_eligible_seq <= ?{seq_param} AND c.due_at <= ?{now_param}"
        )
    }

    /// Cards that can enter the popup right now — the number behind 「待复习」
    /// (home page, tray tooltip, engine tick, 今日目标).
    pub fn due_count(&self, seq: i64, now: DateTime<Utc>) -> rusqlite::Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM card c WHERE {}",
            Self::due_predicate(1, 2)
        );
        self.0
            .query_row(&sql, rusqlite::params![seq, fmt_time(now)], |r| r.get(0))
    }

    /// Reviews per local day since `cutoff` (UTC), oldest first — the source
    /// for "today" counters, the 7-day chart and the streak walk (SPEC §14).
    ///
    /// Groups by [`study_day_of`]'s 04:00 roll, **not** the calendar day: the
    /// goal panel and the engine quota already use the study day, and the two
    /// "today" numbers shown side by side must not disagree between midnight
    /// and 04:00.
    pub fn review_counts_by_day(
        &self,
        cutoff: DateTime<Utc>,
    ) -> rusqlite::Result<Vec<(String, i64)>> {
        let mut stmt = self.0.prepare(
            "SELECT date(reviewed_at, 'localtime', '-4 hours') AS day, COUNT(*)
               FROM review_log WHERE reviewed_at >= ?1
              GROUP BY day ORDER BY day",
        )?;
        let rows = stmt.query_map([fmt_time(cutoff)], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Reviews logged on one study day (`YYYY-MM-DD`, 04:00 roll) — the goal
    /// progress counter and tray tooltip number.
    pub fn review_count_on_study_day(&self, day: &str) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM review_log
             WHERE date(reviewed_at, 'localtime', '-4 hours') = ?1",
            [day],
            |r| r.get(0),
        )
    }

    /// 今天**讲出来**的卡数：今天有过至少一次「可以讲出来」评分的卡，按卡去重。
    ///
    /// 从 `review_log` 事件出发而**不是**读 `card.speak_days`：调度器在后续评「熟悉/
    /// 不了解」时会清零 `speak_days`（掌握连击回到起点），但"今天讲过这张卡"是
    /// 已经发生的事实，按评审要求【不回退】（SPEC §7.9）。
    pub fn speak_cards_on_day(&self, day: &str) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(DISTINCT card_id) FROM review_log
             WHERE rating = 3 AND date(reviewed_at, 'localtime', '-4 hours') = ?1",
            [day],
            |r| r.get(0),
        )
    }

    /// 今天**达成掌握**的卡数：`speak_days` 含今天，且不同学习日数已达归档阈值。
    /// 只看掌握本身，**不含链式门槛**——被邻居拖住的卡也算已掌握（UI 另作标注）。
    ///
    /// 这是附带成绩（不是目标），所以按卡的当前状态算：如果这张卡今天之后又被
    /// 评「熟悉」，连击确实真的回退了，这个数字跟着回退是诚实的。
    pub fn mastered_cards_on_day(&self, day: &str, threshold: i64) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM card
             WHERE ',' || speak_days || ',' LIKE '%,' || ?1 || ',%'
               AND (LENGTH(speak_days) - LENGTH(REPLACE(speak_days, ',', '')) + 1) >= ?2",
            rusqlite::params![day, threshold],
            |r| r.get(0),
        )
    }

    /// 今天**还能推进**的卡数：活的（未暂停未归档）、且今天还没讲出来过一张。
    /// 0 = 今天的卡池耗尽（对讲出型目标视为达成）。
    pub fn pushable_pool_left(&self, day: &str) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM card
             WHERE state NOT IN ('suspended', 'archived')
               AND id NOT IN (
                 SELECT DISTINCT card_id FROM review_log
                  WHERE rating = 3 AND date(reviewed_at, 'localtime', '-4 hours') = ?1
               )",
            [day],
            |r| r.get(0),
        )
    }

    /// 本学习日**从 `from_min`（当日第几分钟）起**的复习张数——讲出型目标的
    /// "复习份额"消费计量。只算目标时段内，上午的复习不会把晚上的份额先花掉。
    pub fn review_count_from(&self, day: &str, from_min: i64) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM review_log
             WHERE date(reviewed_at, 'localtime', '-4 hours') = ?1
               AND (CAST(strftime('%H', reviewed_at, 'localtime') AS INTEGER) * 60
                  + CAST(strftime('%M', reviewed_at, 'localtime') AS INTEGER)) >= ?2",
            rusqlite::params![day, from_min],
            |r| r.get(0),
        )
    }

    /// 近 14 个学习日的讲出率样本 `(有效讲出次数, 展示次数)`。
    ///
    /// 分母刻意排除"该卡今天已经讲出来过之后"的展示：那种展示本来就不该再产出
    /// 讲出，计入分母会把讲出率压低（2026-10-06 外部评审）。
    pub fn speak_rate_sample(&self) -> rusqlite::Result<(i64, i64)> {
        let cutoff = fmt_time(Utc::now() - chrono::Duration::days(14));
        self.0.query_row(
            "WITH r AS (
               SELECT rating,
                      COALESCE(SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) OVER (
                        PARTITION BY card_id, date(reviewed_at, 'localtime', '-4 hours')
                        ORDER BY reviewed_at
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                      ), 0) AS spoke_before
                 FROM review_log
                WHERE reviewed_at >= ?1
             )
             SELECT
               COALESCE(SUM(CASE WHEN rating = 3 AND spoke_before = 0 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN spoke_before = 0 THEN 1 ELSE 0 END), 0)
             FROM r",
            [cutoff],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// Live (non-suspended, non-archived) cards per proficiency level 0..=5.
    pub fn level_distribution(&self) -> rusqlite::Result<[i64; 6]> {
        let mut out = [0i64; 6];
        let mut stmt = self.0.prepare(
            "SELECT MIN(level, 5) AS lv, COUNT(*) FROM card
              WHERE state NOT IN ('suspended', 'archived') GROUP BY lv",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (lv, n) = row?;
            out[(lv.max(0) as usize).min(5)] = n;
        }
        Ok(out)
    }

    pub fn count_by_state(&self, state: &str) -> rusqlite::Result<i64> {
        self.0
            .query_row("SELECT COUNT(*) FROM card WHERE state = ?1", [state], |r| {
                r.get(0)
            })
    }

    /// Consistent single-file snapshot of the live DB (SPEC §14 backups).
    /// `VACUUM INTO` works while the connection stays open and fails if the
    /// target file already exists — callers remove/replace first.
    pub fn backup_to(&self, path: &std::path::Path) -> rusqlite::Result<()> {
        self.0
            .execute("VACUUM INTO ?1", [path.to_string_lossy().to_string()])?;
        Ok(())
    }

    // ---- linked cards (SPEC §11 连贯闪卡) ----

    /// Manual link edge: `from` 前置 → `to` 后置. Idempotent.
    pub fn add_card_link(&self, from: i64, to: i64) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "INSERT OR IGNORE INTO card_link(from_card_id, to_card_id) VALUES(?1, ?2)",
            rusqlite::params![from, to],
        )?;
        Ok(n > 0)
    }

    pub fn remove_card_link(&self, from: i64, to: i64) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "DELETE FROM card_link WHERE from_card_id = ?1 AND to_card_id = ?2",
            rusqlite::params![from, to],
        )?;
        Ok(n > 0)
    }

    /// Manual prerequisites of a card (edges pointing at it).
    pub fn manual_prev_ids(&self, card_id: i64) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.0.prepare(
            "SELECT from_card_id FROM card_link WHERE to_card_id = ?1 ORDER BY from_card_id",
        )?;
        let rows = stmt.query_map([card_id], |r| r.get(0))?;
        rows.collect()
    }

    /// Manual follow-ups of a card (edges leaving it).
    pub fn manual_next_ids(&self, card_id: i64) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.0.prepare(
            "SELECT to_card_id FROM card_link WHERE from_card_id = ?1 ORDER BY to_card_id",
        )?;
        let rows = stmt.query_map([card_id], |r| r.get(0))?;
        rows.collect()
    }

    /// Auto-chain neighbours: previous/next card by insertion order inside the
    /// same chapter (SPEC §11.1 rule 1).
    pub fn chapter_prev_id(&self, card_id: i64) -> rusqlite::Result<Option<i64>> {
        self.0.query_row(
            "SELECT MAX(c2.id) FROM card c1 JOIN card c2 ON c2.chapter_id = c1.chapter_id
                  WHERE c1.id = ?1 AND c2.id < ?1 AND c2.state != 'suspended'",
            [card_id],
            |r| r.get::<_, Option<i64>>(0),
        )
    }

    pub fn chapter_next_id(&self, card_id: i64) -> rusqlite::Result<Option<i64>> {
        self.0.query_row(
            "SELECT MIN(c2.id) FROM card c1 JOIN card c2 ON c2.chapter_id = c1.chapter_id
              WHERE c1.id = ?1 AND c2.id > ?1 AND c2.state != 'suspended'",
            [card_id],
            |r| r.get::<_, Option<i64>>(0),
        )
    }

    /// Whether the card's deck has auto-chaining enabled (deck.chain_by_order).
    pub fn deck_chain_enabled(&self, card_id: i64) -> rusqlite::Result<bool> {
        self.0.query_row(
            "SELECT d.chain_by_order FROM card c JOIN deck d ON d.id = c.deck_id WHERE c.id = ?1",
            [card_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v != 0)
    }

    pub fn set_deck_chain(&self, deck: &str, enabled: bool) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE deck SET chain_by_order = ?1 WHERE name = ?2",
            rusqlite::params![i64::from(enabled), deck],
        )?;
        Ok(n > 0)
    }

    /// BFS along link edges: does `from` reach `to`? Used to reject link cycles.
    pub fn link_reaches(&self, from: i64, to: i64) -> rusqlite::Result<bool> {
        let mut seen = std::collections::HashSet::new();
        let mut queue = vec![from];
        while let Some(cur) = queue.pop() {
            if cur == to {
                return Ok(true);
            }
            if !seen.insert(cur) {
                continue;
            }
            for next in self.manual_next_ids(cur)? {
                queue.push(next);
            }
        }
        Ok(false)
    }

    /// Is the card allowed to appear right now (same predicate as 「待复习」)?
    pub fn is_card_eligible(
        &self,
        card_id: i64,
        seq: i64,
        now: DateTime<Utc>,
    ) -> rusqlite::Result<bool> {
        let sql = format!(
            "SELECT COUNT(*) FROM card c WHERE c.id = ?1 AND {}",
            Self::due_predicate(2, 3)
        );
        self.0
            .query_row(&sql, rusqlite::params![card_id, seq, fmt_time(now)], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n > 0)
    }

    /// 疑难卡（⚠ 需专项理解）: flagged cards, most-forgotten first.
    pub fn attention_cards(&self) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE c.needs_attention = 1 AND c.state != 'suspended'
             ORDER BY c.lapses DESC, c.id ASC",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([], Self::row_to_card)?;
        rows.collect()
    }

    /// Clear the ⚠ flag without touching scheduling state (SPEC §12.1).
    pub fn clear_attention(&self, card_id: i64) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET needs_attention = 0 WHERE id = ?1 AND needs_attention = 1",
            [card_id],
        )?;
        Ok(n > 0)
    }

    /// SPEC §12.1 "重置进度重来": back to level 1, due immediately, no streaks.
    pub fn reset_progress(&self, card_id: i64, now: DateTime<Utc>) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET state='review', level=1, next_eligible_seq=0, due_at=?1,
             unknown_streak=0, speak_streak=0, needs_attention=0, lapses=0
             WHERE id=?2 AND state != 'suspended'",
            rusqlite::params![fmt_time(now), card_id],
        )?;
        Ok(n > 0)
    }

    /// SPEC §12.2: restore an archived card into the rotation, keeping level.
    pub fn restore_card(&self, card_id: i64, now: DateTime<Utc>) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET state='review', next_eligible_seq=0, due_at=?1
             WHERE id=?2 AND state = 'archived'",
            rusqlite::params![fmt_time(now), card_id],
        )?;
        Ok(n > 0)
    }

    /// Total cards ever shown — the global `review_seq` (design §1). Cached
    /// (see `SeqCache`); the counter is monotonic outside deletions, so the
    /// cache only needs invalidation when show-log rows are removed.
    pub fn show_count(&self) -> rusqlite::Result<i64> {
        self.1.load_or_compute(|| {
            self.0
                .query_row("SELECT COUNT(*) FROM card_show_log", [], |r| r.get(0))
        })
    }

    /// Pool query: eligible cards of one bucket, oldest-seen first.
    /// `order` picks the ranking: `""` keeps oldest-seen; due cards use the
    /// overdue-ratio ranking so a backlog cannot starve high-level cards
    /// (2026-10-04 review: 逾期比例 = 已逾期张数 / 应隔张数).
    fn pool(
        &self,
        extra_where: &str,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
        order: &str,
    ) -> rusqlite::Result<Vec<Card>> {
        let order = if order.is_empty() {
            "c.last_seen_seq ASC, c.id ASC".to_string()
        } else {
            order.to_string()
        };
        let sql = format!(
            "{} WHERE {} AND ({extra_where})
             ORDER BY {order} LIMIT ?3",
            Self::CARD_SELECT,
            Self::due_predicate(1, 2)
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![seq, fmt_time(now), limit],
            Self::row_to_card,
        )?;
        rows.collect()
    }

    /// 重点回访卡 (needs_attention) — capped to one per popup by the caller.
    pub fn attention_candidates(
        &self,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        self.pool("c.needs_attention = 1", seq, now, limit, "")
    }

    /// 普通到期卡: levels 1–2, excluding flagged cards, most-overdue first.
    pub fn due_candidates(
        &self,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        self.pool(
            "c.needs_attention = 0 AND c.level BETWEEN 1 AND 2",
            seq,
            now,
            limit,
            "((?1 - c.next_eligible_seq) * 1.0
                / MAX(1, c.next_eligible_seq - c.last_seen_seq)) DESC,
             c.last_seen_seq ASC, c.id ASC",
        )
    }

    /// 新卡 (never reviewed).
    pub fn new_candidates(
        &self,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        self.pool("c.reps = 0 AND c.level = 0", seq, now, limit, "")
    }

    /// 长期维护卡 (level ≥ 3), excluding flagged cards.
    pub fn normal_candidates(
        &self,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        self.pool(
            "c.needs_attention = 0 AND c.level >= 3",
            seq,
            now,
            limit,
            "",
        )
    }

    /// All archived cards — the caller runs the 15%-chance weighted spot check
    /// over them (weight = days since last review + 1 + spot_bias). Bounded by
    /// the archive size, which stays small by design.
    pub fn archived_cards(&self) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE c.state = 'archived' ORDER BY c.last_review_at ASC",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([], Self::row_to_card)?;
        rows.collect()
    }

    /// 池空兜底 (2026-10-04 "时间只记账" rework): when every eligible pool is
    /// empty, hand out the cards closest to their seq gate whose time floor
    /// has passed. Only the count gate is relaxed — the 10-minute floor still
    /// stands, so a just-rated card can never bounce straight back.
    pub fn fallback_candidates(
        &self,
        seq: i64,
        now: DateTime<Utc>,
        limit: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE c.state NOT IN ('suspended', 'archived')
                AND c.next_eligible_seq > ?1 AND c.due_at <= ?2
             ORDER BY c.next_eligible_seq ASC, c.last_seen_seq ASC LIMIT ?3",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![seq, fmt_time(now), limit],
            Self::row_to_card,
        )?;
        rows.collect()
    }

    /// Manual links touching any of `ids` — the popup diversifier needs them
    /// so linked cards never share a session (one would leak the other).
    pub fn links_among(&self, ids: &[i64]) -> rusqlite::Result<Vec<(i64, i64)>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT from_card_id, to_card_id FROM card_link
             WHERE from_card_id IN ({list}) OR to_card_id IN ({list})"
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// How many cards were introduced (first-ever rating) since `cutoff` — the
    /// daily new-card quota.
    pub fn new_introduced_since(&self, cutoff: DateTime<Utc>) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM review_log WHERE state_before = 'new' AND reviewed_at > ?1",
            [fmt_time(cutoff)],
            |r| r.get(0),
        )
    }

    pub fn insert_show_log(&self, card_id: i64, at: DateTime<Utc>) -> rusqlite::Result<()> {
        self.0.execute(
            "INSERT INTO card_show_log(card_id, shown_at) VALUES(?1, ?2)",
            rusqlite::params![card_id, fmt_time(at)],
        )?;
        self.1.bump();
        Ok(())
    }

    /// Keep the card's last-seen counter in sync with the global display seq.
    pub fn mark_seen_seq(&self, card_id: i64, seq: i64) -> rusqlite::Result<()> {
        self.0.execute(
            "UPDATE card SET last_seen_seq = ?1 WHERE id = ?2",
            rusqlite::params![seq, card_id],
        )?;
        Ok(())
    }

    // ---- overload protection (SPEC §7.8) ----

    /// One popup session that actually opened, for the daily popup cap.
    pub fn insert_popup_log(&self, at: DateTime<Utc>) -> rusqlite::Result<()> {
        self.0.execute(
            "INSERT INTO popup_log(opened_at) VALUES(?1)",
            [fmt_time(at)],
        )?;
        Ok(())
    }

    /// Popup sessions opened on one study day (`YYYY-MM-DD`). The study day
    /// rolls at 04:00 local (Anki's convention, 2026-10-04 review): a session
    /// just past midnight belongs to the previous day's quota.
    pub fn popup_count_on(&self, local_day: &str) -> rusqlite::Result<i64> {
        self.0.query_row(
            "SELECT COUNT(*) FROM popup_log
             WHERE date(opened_at, 'localtime', '-4 hours') = ?1",
            [local_day],
            |r| r.get(0),
        )
    }

    // ---- popup sessions (close policy, 2026-10-04) ----

    /// Open a popup session row (close policy): the frontend reports the
    /// outcome later; a row without a close record reads as "unknown" and
    /// never counts as a dodge (crash / power loss / shutdown).
    pub fn open_popup_session(
        &self,
        session_id: i64,
        opened_at: DateTime<Utc>,
        origin: &str,
    ) -> rusqlite::Result<()> {
        self.0.execute(
            "INSERT OR REPLACE INTO popup_session(session_id, opened_at, origin)
             VALUES(?1, ?2, ?3)",
            rusqlite::params![session_id, fmt_time(opened_at), origin],
        )?;
        Ok(())
    }

    /// Attach the frontend-reported outcome to a session.
    pub fn close_popup_session(
        &self,
        session_id: i64,
        closed_at: DateTime<Utc>,
        reason: &str,
        shown: Option<i64>,
        rated: Option<i64>,
    ) -> rusqlite::Result<usize> {
        self.0.execute(
            "UPDATE popup_session
             SET closed_at=?2, close_reason=?3, shown=?4, rated=?5
             WHERE session_id=?1",
            rusqlite::params![session_id, fmt_time(closed_at), reason, shown, rated],
        )
    }

    /// 离手逃离 (2026-10-06): 弹窗开着却长时间没人碰 → 给这个会话记一笔"逃离"，
    /// 让它进逃避链。**只标记还没结算的行**：用户后来真的回来关闭时，
    /// `close_popup_session` 会用真实结局覆盖它（比如 rated>0 的 completed），
    /// 那种情况下本来就不该算逃避。
    pub fn mark_session_escaped(&self, session_id: i64) -> rusqlite::Result<usize> {
        self.0.execute(
            "UPDATE popup_session SET close_reason='escaped', rated=0
             WHERE session_id=?1 AND close_reason IS NULL",
            [session_id],
        )
    }

    /// Today's sessions, newest first — the dodge-streak walk.
    pub fn popup_sessions_today(&self, day: &str) -> rusqlite::Result<Vec<PopupSessionRow>> {
        let mut stmt = self.0.prepare(
            "SELECT opened_at, close_reason, rated, origin FROM popup_session
             WHERE date(opened_at, 'localtime', '-4 hours') = ?1
             ORDER BY opened_at DESC",
        )?;
        let rows = stmt.query_map([day], |r| {
            Ok(PopupSessionRow {
                opened_at: parse_time(&r.get::<_, String>(0)?).unwrap_or_else(Utc::now),
                close_reason: r.get(1)?,
                rated: r.get(2)?,
                origin: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    // ---- exam presets (组卷, 2026-10-04) ----

    pub fn save_exam_preset(
        &self,
        name: &str,
        config_json: &str,
        now: DateTime<Utc>,
    ) -> rusqlite::Result<i64> {
        self.0.execute(
            "INSERT INTO exam_preset(name, config_json, created_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET config_json=?2",
            rusqlite::params![name, config_json, fmt_time(now)],
        )?;
        Ok(self.0.last_insert_rowid())
    }

    /// (id, name, config_json) of every preset, newest first.
    pub fn list_exam_presets(&self) -> rusqlite::Result<Vec<(i64, String, String)>> {
        let mut stmt = self.0.prepare(
            "SELECT id, name, config_json FROM exam_preset ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    /// 组卷候选：一个卡包内未挂起/未归档的卡，按策略排序取前 N 张。
    /// `strategy`: "weak" → 等级升序（同级复习次数少优先，尾随机），
    /// 其余 → 纯随机。
    pub fn exam_candidates(
        &self,
        deck: &str,
        count: i64,
        strategy: ExamStrategy,
    ) -> rusqlite::Result<Vec<Card>> {
        let order = match strategy {
            ExamStrategy::Weak => "c.level ASC, c.reps ASC, RANDOM()",
            ExamStrategy::Random => "RANDOM()",
        };
        let sql = format!(
            "{} WHERE d.name = ?1 AND c.state NOT IN ('suspended', 'archived')
             ORDER BY {order} LIMIT ?2",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![deck, count], Self::row_to_card)?;
        rows.collect()
    }

    pub fn delete_exam_preset(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self
            .0
            .execute("DELETE FROM exam_preset WHERE id = ?1", [id])?;
        Ok(n > 0)
    }

    pub fn find_card_in_chapter(
        &self,
        chapter_id: i64,
        title: &str,
    ) -> rusqlite::Result<Option<Card>> {
        let sql = format!(
            "{} WHERE c.chapter_id = ?1 AND c.title = ?2",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let mut rows = stmt.query(rusqlite::params![chapter_id, title])?;
        match rows.next()? {
            Some(row) => Ok(Some(Self::row_to_card(row)?)),
            None => Ok(None),
        }
    }

    /// Manual-create helper: is `title` already taken inside this (deck,
    /// chapter)? Import matches by identity (`find_card_in_chapter`); manual
    /// creation instead disambiguates, because an auto-derived title (a wordless
    /// 题面 collapses to `🖼`) would otherwise fail the `UNIQUE(chapter_id, title)`
    /// constraint with a raw SQLite error.
    pub fn card_title_exists(
        &self,
        deck: &str,
        chapter: &str,
        title: &str,
    ) -> rusqlite::Result<bool> {
        self.0.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM card c
                   JOIN deck d ON d.id = c.deck_id
                   JOIN chapter ch ON ch.id = c.chapter_id
                  WHERE d.name = ?1 AND ch.name = ?2 AND c.title = ?3)",
            rusqlite::params![deck, chapter, title],
            |row| row.get(0),
        )
    }

    /// Import update path (SPEC §5.3): replace the parsed fields, keeping the
    /// review progress. `title` is included because a 题面卡's title is a
    /// projection of its 题干 — when the wording changes, the projection (and
    /// therefore the title) changes too, while the card stays the same row.
    /// `clear_local_edit` is the "以文件为准" option; otherwise the
    /// locally_edited flag is untouched.
    pub fn update_card_from_import(
        &self,
        card_id: i64,
        title: &str,
        content_md: &str,
        front_md: &str,
        source_file: Option<&str>,
        clear_local_edit: bool,
    ) -> rusqlite::Result<()> {
        self.0.execute(
            "UPDATE card SET title = ?1, content_md = ?2, front_md = ?3, source_file = ?4,
             locally_edited = CASE WHEN ?5 THEN 0 ELSE locally_edited END
             WHERE id = ?6",
            rusqlite::params![
                title,
                content_md,
                front_md,
                source_file,
                clear_local_edit,
                card_id
            ],
        )?;
        Ok(())
    }

    /// The chapter's 题面卡 (SPEC §5.2 rule 10): a chapter holds at most one, and
    /// it is found by `front_md` being non-empty rather than by title — its
    /// title is a projection of the 题干, so matching by title would mint a new
    /// card (and lose the review progress) as soon as the user rewords it.
    pub fn find_front_card_in_chapter(&self, chapter_id: i64) -> rusqlite::Result<Option<Card>> {
        let sql = format!(
            "{} WHERE c.chapter_id = ?1 AND c.front_md != '' ORDER BY c.id ASC LIMIT 1",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let mut rows = stmt.query([chapter_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Self::row_to_card(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_source_cards(&self, source_file: &str) -> rusqlite::Result<Vec<Card>> {
        let sql = format!("{} WHERE c.source_file = ?1", Self::CARD_SELECT);
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([source_file], Self::row_to_card)?;
        rows.collect()
    }

    /// All cards of one deck in reading order (chapter order, then insertion),
    /// excluding soft-deleted ones.
    pub fn list_cards_by_deck(&self, deck: &str) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE d.name = ?1 AND c.state != 'suspended'
             ORDER BY ch.order_idx ASC, c.id ASC",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map([deck], Self::row_to_card)?;
        rows.collect()
    }

    /// SPEC §6: deleting a card is a soft delete (suspended), physical purge
    /// happens later.
    pub fn delete_card(&self, card_id: i64) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET state='suspended' WHERE id=?1 AND state != 'suspended'",
            [card_id],
        )?;
        Ok(n > 0)
    }

    /// Any UI edit (deck browser or popup annotation) counts as a local edit:
    /// re-imports must not silently overwrite it (SPEC §5.3 / §9.3).
    /// `front_md = None` leaves the 题面 alone (editing the back must not wipe
    /// it); `Some("")` explicitly clears it.
    pub fn update_card(
        &self,
        card_id: i64,
        title: &str,
        content_md: &str,
        front_md: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET title=?1, content_md=?2,
             front_md = COALESCE(?4, front_md), locally_edited=1 WHERE id=?3",
            rusqlite::params![title, content_md, card_id, front_md],
        )?;
        Ok(n > 0)
    }

    pub fn rename_deck(&self, old_name: &str, new_name: &str) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE deck SET name=?1 WHERE name=?2",
            [new_name, old_name],
        )?;
        Ok(n > 0)
    }

    /// Cards by explicit id list, preserving the requested order and skipping
    /// missing/suspended rows (manual review sessions).
    pub fn cards_by_ids(&self, ids: &[i64]) -> rusqlite::Result<Vec<Card>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "{} WHERE c.id IN ({placeholders}) AND c.state != 'suspended'",
            Self::CARD_SELECT
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), Self::row_to_card)?;
        let found: Vec<Card> = rows.collect::<rusqlite::Result<_>>()?;
        let mut by_id: std::collections::HashMap<i64, Card> =
            found.into_iter().map(|c| (c.id, c)).collect();
        Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    /// Search + filter for the deck browser. `filter` is one of
    /// all|due|new|learning|review|archived; an empty query matches everything.
    pub fn search_cards(
        &self,
        query: Option<&str>,
        deck: Option<&str>,
        filter: &str,
    ) -> rusqlite::Result<Vec<Card>> {
        let mut sql = format!("{} WHERE c.state != 'suspended'", Self::CARD_SELECT);
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut idx = 1;
        if let Some(p) = query
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(like_pattern)
        {
            // 题面卡的内容在 `front_md` 里（需求7）：按题干内容搜得到才叫"搜索"。
            sql.push_str(&format!(
                " AND (c.title LIKE ?{idx} ESCAPE '\\' OR c.content_md LIKE ?{idx} ESCAPE '\\'
                       OR c.front_md LIKE ?{idx} ESCAPE '\\')"
            ));
            args.push(Box::new(p));
            idx += 1;
        }
        if let Some(name) = deck.filter(|d| !d.is_empty()) {
            sql.push_str(&format!(" AND d.name = ?{idx}"));
            args.push(Box::new(name.to_string()));
            idx += 1;
        }
        match filter {
            "due" => {
                // The same predicate as every other 待复习 number (SPEC §14) —
                // including the archived exclusion, which this branch used to
                // miss while its own inline copy drifted.
                sql.push_str(&format!(" AND {}", Self::due_predicate(idx, idx + 1)));
                args.push(Box::new(self.show_count()?));
                args.push(Box::new(fmt_time(Utc::now())));
            }
            "new" => sql.push_str(" AND c.reps = 0 AND c.level = 0"),
            "review" => sql.push_str(" AND c.reps > 0 AND c.state != 'archived'"),
            "archived" => sql.push_str(" AND c.state = 'archived'"),
            _ => {}
        }
        sql.push_str(" ORDER BY d.name, ch.order_idx, c.id");
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), Self::row_to_card)?;
        rows.collect()
    }

    /// Delete a deck with its cards and chapters in one transaction. Cards go
    /// first (no FK cascade on card→chapter), then the deck row cascades its
    /// chapters; review_log / card_link rows cascade via their own FKs.
    pub fn delete_deck(&mut self, deck: &str) -> rusqlite::Result<bool> {
        let tx = self.0.transaction()?;
        let deck_id: Option<i64> = tx
            .query_row("SELECT id FROM deck WHERE name=?1", [deck], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some(id) = deck_id else {
            tx.commit()?;
            return Ok(false);
        };
        tx.execute(
            "DELETE FROM card WHERE chapter_id IN (SELECT id FROM chapter WHERE deck_id=?1)",
            [id],
        )?;
        tx.execute("DELETE FROM deck WHERE id=?1", [id])?;
        tx.commit()?;
        // Cascade removed this deck's card_show_log rows — drop the stale count.
        self.1.invalidate();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    #[test]
    fn parse_time_rejects_garbage_instead_of_panicking() {
        assert!(parse_time("2026-10-03T09:00:00Z").is_some());
        assert!(parse_time("not-a-timestamp").is_none());
        assert!(parse_time("").is_none());
    }

    /// Regression (2026-10-03): a malformed stored timestamp used to panic
    /// inside `row_to_card` while the DB mutex was held — poisoning the lock
    /// and cascading into app-wide failures (reported as 闪退). It must
    /// degrade to "due now" instead.
    #[test]
    fn corrupted_timestamp_degrades_to_due_now() {
        let d = db();
        let id = d
            .insert_card(
                &NewCard {
                    deck: "D".into(),
                    chapter: "C".into(),
                    title: "t".into(),
                    content_md: "m".into(),
                    front_md: String::new(),
                    source_file: None,
                },
                Utc::now(),
            )
            .unwrap();
        d.0.execute("UPDATE card SET due_at = 'garbage' WHERE id = ?1", [id])
            .unwrap();
        let cards = d.cards_by_ids(&[id]).unwrap();
        assert_eq!(cards.len(), 1);
        assert!(Utc::now() - cards[0].due_at < chrono::Duration::seconds(5));
    }

    #[test]
    fn migration_creates_all_tables_and_columns() {
        let d = db();
        let tables: Vec<String> =
            d.0.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
        for expected in [
            "card",
            "card_link",
            "chapter",
            "deck",
            "popup_log",
            "review_log",
            "settings",
        ] {
            assert!(
                tables.iter().any(|t| t == expected),
                "missing table {expected}"
            );
        }
        let cols: Vec<String> =
            d.0.prepare("PRAGMA table_info(card)")
                .unwrap()
                .query_map([], |r| r.get(1))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
        assert!(cols.iter().any(|c| c == "learning_step"));
    }

    #[test]
    fn settings_roundtrip() {
        let d = db();
        assert_eq!(d.get_setting("popup_interval_min").unwrap(), None);
        d.set_setting("popup_interval_min", "10").unwrap();
        d.set_setting("popup_interval_min", "15").unwrap();
        assert_eq!(
            d.get_setting("popup_interval_min").unwrap().as_deref(),
            Some("15")
        );
    }

    #[test]
    fn study_day_rolls_at_four_am_local() {
        use chrono::TimeZone;
        let pre_dawn = chrono::Local
            .with_ymd_and_hms(2026, 10, 5, 3, 59, 0)
            .unwrap()
            .with_timezone(&Utc);
        let morning = chrono::Local
            .with_ymd_and_hms(2026, 10, 5, 4, 1, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            study_day_of(pre_dawn),
            "2026-10-04",
            "03:59 belongs to yesterday"
        );
        assert_eq!(study_day_of(morning), "2026-10-05");
    }

    #[test]
    fn popup_log_counts_per_study_day() {
        let d = db();
        // Study day = calendar day of (local time − 4h), matching the SQL.
        let study_day = |t: chrono::DateTime<chrono::Local>, offset: i64| {
            (t - chrono::Duration::hours(4) - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string()
        };
        let now_local = chrono::Local::now();
        assert_eq!(d.popup_count_on(&study_day(now_local, 0)).unwrap(), 0);
        d.insert_popup_log(Utc::now()).unwrap();
        d.insert_popup_log(Utc::now()).unwrap();
        // A popup from 24h ago must not count towards the current study day.
        let yesterday = Utc::now() - chrono::Duration::hours(24);
        d.insert_popup_log(yesterday).unwrap();
        assert_eq!(d.popup_count_on(&study_day(now_local, 0)).unwrap(), 2);
        assert_eq!(d.popup_count_on(&study_day(now_local, 1)).unwrap(), 1);
    }

    #[test]
    fn show_count_cache_tracks_inserts_and_deletions() {
        let mut d = db();
        let a = d
            .insert_card(
                &NewCard {
                    deck: "D".into(),
                    chapter: "C".into(),
                    title: "t".into(),
                    content_md: "m".into(),
                    front_md: String::new(),
                    source_file: None,
                },
                Utc::now(),
            )
            .unwrap();
        assert_eq!(d.show_count().unwrap(), 0);
        d.insert_show_log(a, Utc::now()).unwrap();
        d.insert_show_log(a, Utc::now()).unwrap();
        assert_eq!(d.show_count().unwrap(), 2, "bumped on insert");
        // Direct SQL removals bypass the cache; deletion paths invalidate it.
        d.delete_deck("D").unwrap();
        assert_eq!(d.show_count().unwrap(), 0, "cache invalidated on delete");
    }

    #[test]
    fn every_card_gets_a_stable_uid() {
        let d = db();
        let a = d
            .insert_card(
                &NewCard {
                    deck: "D".into(),
                    chapter: "C".into(),
                    title: "t".into(),
                    content_md: "m".into(),
                    front_md: String::new(),
                    source_file: None,
                },
                Utc::now(),
            )
            .unwrap();
        let card = d.get_card(a).unwrap().unwrap();
        assert_eq!(card.uid.len(), 36, "UUID format");
        let again = d.get_card(a).unwrap().unwrap();
        assert_eq!(card.uid, again.uid, "stable across reads");
    }

    /// SPEC §14 (v8 note): the migration probes `PRAGMA table_info(card)` before
    /// the ALTER, because `ADD COLUMN` has no `IF NOT EXISTS` — a run that died
    /// between the ALTER and the `user_version` bump must stay re-runnable.
    /// Here the version is rolled back to 7 while `front_md` already exists:
    /// opening must skip the ALTER (a blind one errors with "duplicate column")
    /// and still land on `LATEST_VERSION`, without touching the data.
    #[test]
    fn v8_migration_is_rerunnable_after_a_half_failed_run() {
        let dir = std::env::temp_dir().join(format!("flashmemo-v8-rerun-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("half.db");
        let _ = std::fs::remove_file(&path);
        {
            let d = Db::open(&path).unwrap();
            d.0.execute_batch(
                "INSERT INTO deck(name, created_at) VALUES('D', '2026-01-01T00:00:00Z');
                 INSERT INTO chapter(deck_id, name, order_idx) VALUES(1, 'C', 0);
                 INSERT INTO card(deck_id, chapter_id, title, content_md, front_md, due_at, created_at)
                 VALUES(1, 1, '🖼 · 题干', '', '题干正文', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
            )
            .unwrap();
            // The half-failed shape: the ALTER landed, the bump did not.
            d.0.pragma_update(None, "user_version", 7).unwrap();
        }
        let d = Db::open(&path).unwrap();
        assert_eq!(
            d.0.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            LATEST_VERSION,
            "re-running the v8 step still ends at the current version"
        );
        assert_eq!(
            d.get_card(1).unwrap().unwrap().front_md,
            "题干正文",
            "题面数据在半途失败的迁移里不丢"
        );
        drop(d);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_migration_backup_and_uid_backfill_for_a_v4_file() {
        let dir = std::env::temp_dir().join(format!("flashmemo-mig-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mig.db");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db.pre-migration-v4.bak"));
        // Simulate a v4-era file with one card.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE deck(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, chain_by_order INTEGER DEFAULT 1, created_at TEXT NOT NULL);
                 CREATE TABLE chapter(id INTEGER PRIMARY KEY, deck_id INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE, name TEXT NOT NULL, order_idx INTEGER NOT NULL);
                 CREATE TABLE card(id INTEGER PRIMARY KEY, deck_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL REFERENCES chapter(id), title TEXT NOT NULL, content_md TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'new', stability REAL, difficulty REAL, due_at TEXT NOT NULL, last_review_at TEXT, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, leech INTEGER DEFAULT 0, locally_edited INTEGER DEFAULT 0, learning_step INTEGER NOT NULL DEFAULT 0, source_file TEXT, created_at TEXT NOT NULL, interval_minutes INTEGER, unknown_streak INTEGER NOT NULL DEFAULT 0, speak_streak INTEGER NOT NULL DEFAULT 0, needs_attention INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, next_eligible_seq INTEGER NOT NULL DEFAULT 0, last_seen_seq INTEGER NOT NULL DEFAULT 0, UNIQUE(chapter_id, title));
                 INSERT INTO deck(name, created_at) VALUES('D', '2026-01-01T00:00:00Z');
                 INSERT INTO chapter(deck_id, name, order_idx) VALUES(1, 'C', 0);
                 INSERT INTO card(deck_id, chapter_id, title, content_md, due_at, created_at) VALUES(1, 1, 't', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 CREATE TABLE review_log(id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE, rating INTEGER NOT NULL, state_before TEXT NOT NULL, stability REAL, difficulty REAL, scheduled_interval TEXT, elapsed_ms INTEGER, reviewed_at TEXT NOT NULL);
                 PRAGMA user_version = 4;",
            )
            .unwrap();
        }
        let d = Db::open(&path).unwrap();
        assert!(
            path.with_extension("db.pre-migration-v4.bak").exists(),
            "pre-migration backup written"
        );
        assert_eq!(
            d.0.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            LATEST_VERSION,
            "a v4 file is migrated all the way up"
        );
        let card = d.get_card(1).unwrap().unwrap();
        assert_eq!(card.uid.len(), 36, "legacy card backfilled with a uid");
        assert_eq!(card.spot_bias, 0);
        assert_eq!(card.speak_days, "", "no streak on a fresh card");
        assert_eq!(
            card.front_md, "",
            "v8 adds front_md with an empty default: a pre-需求7 card keeps its old front (title)"
        );
        drop(d);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_database_creates_no_backup() {
        let dir = std::env::temp_dir().join(format!("flashmemo-fresh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fresh.db");
        let _ = std::fs::remove_file(&path);
        Db::open(&path).unwrap();
        assert!(!path.with_extension("db.pre-migration-v5.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn insert_and_read_back() {
        let d = db();
        let now = Utc::now();
        let past = now - chrono::Duration::minutes(5);

        let a = d
            .insert_card(
                &NewCard {
                    deck: "MySQL".into(),
                    chapter: "事务".into(),
                    title: "卡A".into(),
                    content_md: "内容".into(),
                    front_md: String::new(),
                    source_file: Some("m.md".into()),
                },
                past,
            )
            .unwrap();
        let b = d
            .insert_card(
                &NewCard {
                    deck: "MySQL".into(),
                    chapter: "事务".into(),
                    title: "卡B".into(),
                    content_md: "".into(),
                    front_md: String::new(),
                    source_file: None,
                },
                past,
            )
            .unwrap();
        assert_ne!(a, b);

        // Same deck+chapter name is reused, not duplicated.
        let chapters: i64 =
            d.0.query_row("SELECT COUNT(*) FROM chapter", [], |r| r.get(0))
                .unwrap();
        assert_eq!(chapters, 1);

        let card = d.get_card(a).unwrap().unwrap();
        assert_eq!(card.state, "new");
        assert_eq!(card.learning_step, 0);
        assert_eq!(card.deck, "MySQL");
        assert_eq!(card.chapter, "事务");
        assert!(!card.locally_edited);
        assert_eq!(card.interval_minutes, None);

        // Scheduled (non-new) cards: eligible ones come back oldest-seen first.
        for (id, last_seen) in [(a, 1), (b, 9)] {
            d.0.execute(
                "UPDATE card SET state='review', level=1, reps=2, last_seen_seq=?1,
                 next_eligible_seq=0, due_at=?2 WHERE id=?3",
                rusqlite::params![last_seen, fmt_time(now - chrono::Duration::minutes(5)), id],
            )
            .unwrap();
        }
        let due = d.due_candidates(0, now, 10).unwrap();
        assert_eq!(due.len(), 2);
        assert_eq!(due[0].title, "卡A", "oldest last_seen first");

        // Archived cards never re-enter the queue.
        d.0.execute("UPDATE card SET state='archived' WHERE id=?1", [a])
            .unwrap();
        let due = d.due_candidates(0, now, 10).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].title, "卡B");

        // The sequence gate blocks reappearance independently of due_at.
        d.0.execute("UPDATE card SET next_eligible_seq=99 WHERE id=?1", [b])
            .unwrap();
        assert!(d.due_candidates(0, now, 10).unwrap().is_empty());
        assert!(d.due_candidates(99, now, 10).unwrap().len() == 1);
    }
}
