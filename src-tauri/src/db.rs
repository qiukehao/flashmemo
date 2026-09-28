//! SQLite persistence per SPEC §14: schema, migrations and the small DAO the
//! rest of the app talks to. All timestamps are RFC3339 UTC strings, which keeps
//! lexicographic comparison in SQL correct.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use std::path::Path;

pub struct Db(pub Connection);

#[derive(Debug, Clone)]
pub struct NewCard {
    pub deck: String,
    pub chapter: String,
    pub title: String,
    pub content_md: String,
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
}

pub fn fmt_time(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .expect("stored timestamps are RFC3339")
        .with_timezone(&Utc)
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

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Db::migrate(&conn)?;
        Ok(Db(conn))
    }

    pub fn open_in_memory() -> rusqlite::Result<Db> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Db::migrate(&conn)?;
        Ok(Db(conn))
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
            "INSERT INTO card(deck_id, chapter_id, title, content_md, due_at, source_file, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                deck_id,
                chapter_id,
                new.title,
                new.content_md,
                fmt_time(now),
                new.source_file,
                fmt_time(now),
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
            state: row.get("state")?,
            stability: row.get("stability")?,
            difficulty: row.get("difficulty")?,
            due_at: parse_time(&row.get::<_, String>("due_at")?),
            last_review_at: row
                .get::<_, Option<String>>("last_review_at")?
                .map(|s| parse_time(&s)),
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
        })
    }

    const CARD_SELECT: &str =
        "SELECT c.id, d.name AS deck, ch.name AS chapter, c.title, c.content_md,
        c.state, c.stability, c.difficulty, c.due_at, c.last_review_at, c.reps, c.lapses,
        c.leech, c.locally_edited, c.learning_step, c.source_file,
        c.interval_minutes, c.unknown_streak, c.speak_streak, c.needs_attention
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

    /// Display-throttling filter shared by the popup queue queries: not shown
    /// within `gap_cutoff` and fewer than `max_shows` shows in the window since
    /// `day_cutoff` (SPEC §7 展示限流). `gap_param`/`day_param`/`max_param` are
    /// the positional parameter indexes of the three bindings.
    fn eligible_shows(gap_param: usize, day_param: usize, max_param: usize) -> String {
        format!(
            "NOT EXISTS (SELECT 1 FROM card_show_log s
                          WHERE s.card_id = c.id AND s.shown_at > ?{gap_param})
             AND (SELECT COUNT(*) FROM card_show_log s2
                   WHERE s2.card_id = c.id AND s2.shown_at > ?{day_param}) < ?{max_param}"
        )
    }

    /// Due, already-scheduled cards for a popup session: oldest due first,
    /// display-capped, newest-introduced excluded (those go through
    /// `new_cards_eligible`).
    pub fn due_review_cards(
        &self,
        now: DateTime<Utc>,
        limit: i64,
        gap_cutoff: DateTime<Utc>,
        day_cutoff: DateTime<Utc>,
        max_shows: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE c.state NOT IN ('new', 'suspended', 'archived')
             AND c.due_at <= ?1 AND {}
             ORDER BY c.due_at ASC LIMIT ?5",
            Self::CARD_SELECT,
            Self::eligible_shows(2, 3, 4)
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                fmt_time(now),
                fmt_time(gap_cutoff),
                fmt_time(day_cutoff),
                max_shows,
                limit
            ],
            Self::row_to_card,
        )?;
        rows.collect()
    }

    /// Brand-new cards for a popup session, oldest id first, display-capped.
    pub fn new_cards_eligible(
        &self,
        limit: i64,
        gap_cutoff: DateTime<Utc>,
        day_cutoff: DateTime<Utc>,
        max_shows: i64,
    ) -> rusqlite::Result<Vec<Card>> {
        let sql = format!(
            "{} WHERE c.state = 'new' AND {}
             ORDER BY c.id ASC LIMIT ?4",
            Self::CARD_SELECT,
            Self::eligible_shows(1, 2, 3)
        );
        let mut stmt = self.0.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![fmt_time(gap_cutoff), fmt_time(day_cutoff), max_shows, limit],
            Self::row_to_card,
        )?;
        rows.collect()
    }

    /// How many cards were introduced (first-ever rating) since `cutoff` — the
    /// daily new-card quota (SPEC §7 队列规则).
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
        Ok(())
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

    /// Replace body content (import path). `clear_local_edit` is the SPEC §5.3
    /// "以文件为准" option; otherwise the locally_edited flag is untouched.
    pub fn update_card_content(
        &self,
        card_id: i64,
        content_md: &str,
        source_file: Option<&str>,
        clear_local_edit: bool,
    ) -> rusqlite::Result<()> {
        self.0.execute(
            "UPDATE card SET content_md = ?1, source_file = ?2,
             locally_edited = CASE WHEN ?3 THEN 0 ELSE locally_edited END
             WHERE id = ?4",
            rusqlite::params![content_md, source_file, clear_local_edit, card_id],
        )?;
        Ok(())
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

    pub fn update_card(
        &self,
        card_id: i64,
        title: &str,
        content_md: &str,
    ) -> rusqlite::Result<bool> {
        let n = self.0.execute(
            "UPDATE card SET title=?1, content_md=?2 WHERE id=?3",
            rusqlite::params![title, content_md, card_id],
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
            sql.push_str(&format!(
                " AND (c.title LIKE ?{idx} ESCAPE '\\' OR c.content_md LIKE ?{idx} ESCAPE '\\')"
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
                sql.push_str(&format!(" AND c.due_at <= ?{idx}"));
                args.push(Box::new(fmt_time(Utc::now())));
            }
            "new" => sql.push_str(" AND c.state = 'new'"),
            "learning" => sql.push_str(" AND c.state IN ('learning','relearning')"),
            "review" => sql.push_str(" AND c.state = 'review'"),
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

        // Scheduled (non-new) cards: overdue ones come back oldest first.
        for (id, minutes_ago) in [(a, 10), (b, 1)] {
            d.0.execute(
                "UPDATE card SET state='review', interval_minutes=1440, due_at=?1 WHERE id=?2",
                rusqlite::params![fmt_time(now - chrono::Duration::minutes(minutes_ago)), id],
            )
            .unwrap();
        }
        let due = d
            .due_review_cards(
                now,
                10,
                now - chrono::Duration::hours(2),
                now - chrono::Duration::hours(24),
                2,
            )
            .unwrap();
        assert_eq!(due.len(), 2);
        assert_eq!(due[0].title, "卡A");

        // Archived cards never re-enter the queue.
        d.0.execute("UPDATE card SET state='archived' WHERE id=?1", [a])
            .unwrap();
        let due = d
            .due_review_cards(
                now,
                10,
                now - chrono::Duration::hours(2),
                now - chrono::Duration::hours(24),
                2,
            )
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].title, "卡B");
    }
}
