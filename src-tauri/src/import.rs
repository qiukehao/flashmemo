//! Idempotent markdown import per SPEC §5.3: upsert by (deck, chapter, title),
//! preserving review progress, with local-edit conflict protection.

use crate::db::{Db, NewCard};
use crate::parser::ParsedDeck;
use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: u32,
    pub updated: u32,
    pub conflicts: u32,
    pub kept_missing: u32,
}

pub fn import(
    db: &Db,
    decks: &[ParsedDeck],
    source_file: Option<&str>,
    prefer_file_on_conflict: bool,
) -> rusqlite::Result<ImportReport> {
    let now = Utc::now();
    let mut report = ImportReport::default();
    // (deck, chapter, title) keys present in this import run, for kept_missing.
    let mut imported_keys: std::collections::HashSet<(String, String, String)> =
        std::collections::HashSet::new();

    for deck in decks {
        // A heading with no cards (e.g. a stray leading H1 in the user's note)
        // must not create an empty deck.
        if deck.chapters.iter().all(|ch| ch.cards.is_empty()) {
            continue;
        }
        let deck_id = db.upsert_deck(&deck.name, now)?;
        for chapter in &deck.chapters {
            let chapter_id = db.upsert_chapter(deck_id, &chapter.name)?;
            for card in &chapter.cards {
                imported_keys.insert((deck.name.clone(), chapter.name.clone(), card.title.clone()));
                // A 题面卡's title is a projection of its 题干, so rewording the
                // question changes the title — matching by title would mint a
                // second card and lose the review progress (SPEC §5.3: 题目改字
                // 不影响匹配). A chapter holds at most ONE front card
                // (parser rule 10), so that card is the identity.
                let existing = match db.find_card_in_chapter(chapter_id, &card.title)? {
                    Some(c) => Some(c),
                    None if !card.front_md.is_empty() => {
                        db.find_front_card_in_chapter(chapter_id)?
                    }
                    None => None,
                };
                match existing {
                    None => {
                        db.insert_card(
                            &NewCard {
                                deck: deck.name.clone(),
                                chapter: chapter.name.clone(),
                                title: card.title.clone(),
                                content_md: card.content_md.clone(),
                                front_md: card.front_md.clone(),
                                source_file: source_file.map(str::to_string),
                            },
                            now,
                        )?;
                        report.added += 1;
                    }
                    Some(existing) => {
                        if existing.locally_edited && !prefer_file_on_conflict {
                            // SPEC §5.3: keep the locally annotated version.
                            report.conflicts += 1;
                        } else if existing.content_md != card.content_md
                            || existing.front_md != card.front_md
                            || existing.title != card.title
                        {
                            db.update_card_from_import(
                                existing.id,
                                &card.title,
                                &card.content_md,
                                &card.front_md,
                                source_file,
                                prefer_file_on_conflict,
                            )?;
                            report.updated += 1;
                        }
                        // Unchanged content: not counted, keeps the report honest.
                    }
                }
            }
        }
    }

    if let Some(src) = source_file {
        for card in db.list_source_cards(src)? {
            let key = (card.deck, card.chapter, card.title);
            if !imported_keys.contains(&key) {
                // SPEC §5.3: cards dropped from the source are kept by default.
                report.kept_missing += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_markdown;

    fn import_src(db: &Db, src: &str, prefer_file: bool) -> ImportReport {
        let decks = parse_markdown(src, "fallback");
        import(db, &decks, Some("notes.md"), prefer_file).unwrap()
    }

    fn find_card(db: &Db, title: &str) -> crate::db::Card {
        let id: i64 =
            db.0.query_row("SELECT id FROM card WHERE title=?1", [title], |r| r.get(0))
                .unwrap();
        db.get_card(id).unwrap().unwrap()
    }

    const V1: &str = "# MySQL\n\n## 事务\n\n### ACID\n原子性要点\n\n### 隔离级别\n要点B\n";
    const V2: &str = "# MySQL\n\n## 事务\n\n### ACID\n原子性要点-更新后\n\n### 隔离级别\n要点B\n";

    #[test]
    fn empty_h1_creates_no_empty_deck() {
        // Real user note: leading "# MySQL" with no content, then "# Mysql重点".
        let db = Db::open_in_memory().unwrap();
        let src = "# MySQL\n\n# Mysql重点\n\n## 事务\n\n### 卡\n内容\n";
        let report = import_src(&db, src, false);
        assert_eq!(report.added, 1);
        let decks: Vec<String> =
            db.0.prepare("SELECT name FROM deck ORDER BY name")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
        assert_eq!(
            decks,
            ["Mysql重点"],
            "stray empty H1 must not become a deck"
        );
    }

    #[test]
    fn import_new_cards() {
        let db = Db::open_in_memory().unwrap();
        let report = import_src(&db, V1, false);
        assert_eq!((report.added, report.updated, report.conflicts), (2, 0, 0));
        let card = find_card(&db, "ACID");
        assert_eq!(card.state, "new");
        assert_eq!(card.content_md, "原子性要点");
    }

    #[test]
    fn reimport_preserves_progress() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, V1, false);
        // Simulate progress: reviewed card with a future due date.
        db.0.execute(
            "UPDATE card SET state='review', reps=5, due_at=?1 WHERE title='ACID'",
            [crate::db::fmt_time(Utc::now() + chrono::Duration::days(3))],
        )
        .unwrap();
        let report = import_src(&db, V2, false);
        assert_eq!((report.added, report.updated), (0, 1));
        // Card is due 3 days out, so fetch it directly instead of list_due.
        let id: i64 =
            db.0.query_row("SELECT id FROM card WHERE title='ACID'", [], |r| r.get(0))
                .unwrap();
        let card = db.get_card(id).unwrap().unwrap();
        assert_eq!(card.content_md, "原子性要点-更新后");
        assert_eq!(card.state, "review");
        assert_eq!(card.reps, 5);
    }

    #[test]
    fn reimport_keeps_locally_edited_conflict() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, V1, false);
        db.0.execute("UPDATE card SET locally_edited=1 WHERE title='ACID'", [])
            .unwrap();
        let report = import_src(&db, V2, false);
        assert_eq!(report.conflicts, 1);
        assert_eq!(report.updated, 0);
        let card = find_card(&db, "ACID");
        // Local version wins: content unchanged, flag stays set.
        assert_eq!(card.content_md, "原子性要点");
        assert!(card.locally_edited);
    }

    #[test]
    fn prefer_file_overrides_local_edit() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, V1, false);
        db.0.execute("UPDATE card SET locally_edited=1 WHERE title='ACID'", [])
            .unwrap();
        let report = import_src(&db, V2, true);
        assert_eq!(report.updated, 1);
        assert_eq!(report.conflicts, 0);
        let card = find_card(&db, "ACID");
        assert_eq!(card.content_md, "原子性要点-更新后");
        assert!(!card.locally_edited);
    }

    #[test]
    fn source_deleted_cards_kept() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, V1, false);
        // V2b drops the 隔离级别 card from the source file.
        let v2b = "# MySQL\n\n## 事务\n\n### ACID\n原子性要点\n";
        let report = import_src(&db, v2b, false);
        assert_eq!(report.kept_missing, 1);
        let total: i64 =
            db.0.query_row("SELECT COUNT(*) FROM card", [], |r| r.get(0))
                .unwrap();
        assert_eq!(total, 2, "removed-in-source card must be kept");
    }

    // ---- 题面卡 (需求7, SPEC §5.2 rule 10 / §5.3) ----

    const FRONT_V1: &str = "# D\n\n## 题\n\n![图](u1.png)\n这题怎么解？\n";
    const FRONT_V2: &str = "# D\n\n## 题\n\n![图](u1.png)\n这题怎么解？（改了措辞）\n";

    #[test]
    fn front_card_imports_with_projected_title() {
        let db = Db::open_in_memory().unwrap();
        let report = import_src(&db, FRONT_V1, false);
        assert_eq!(report.added, 1);
        let card = find_card(&db, "🖼 · 这题怎么解？");
        assert_eq!(card.front_md, "![图](u1.png)\n这题怎么解？");
        assert_eq!(card.content_md, "", "背面留空");
        assert_eq!(card.state, "new");
    }

    /// SPEC §5.3: 「题目改字不影响匹配」——题面卡的 title 是题干的投影，改措辞会
    /// 改投影，所以身份**不能**靠 title 匹配（那样会铸出一张新卡、丢掉复习进度）。
    /// 一个章节最多一张题面卡（rule 10），那张卡就是身份。
    #[test]
    fn front_card_wording_edit_keeps_progress() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, FRONT_V1, false);
        let card = find_card(&db, "🖼 · 这题怎么解？");
        db.0.execute(
            "UPDATE card SET state='review', reps=5 WHERE id=?1",
            [card.id],
        )
        .unwrap();

        let report = import_src(&db, FRONT_V2, false);
        assert_eq!(
            (report.added, report.updated, report.kept_missing),
            (0, 1, 0),
            "同一张卡被更新：不新增、也不算源文件里丢卡"
        );
        let after = db.get_card(card.id).unwrap().unwrap();
        assert_eq!(after.title, "🖼 · 这题怎么解？（改了措辞）");
        assert_eq!(after.front_md, "![图](u1.png)\n这题怎么解？（改了措辞）");
        assert_eq!(after.reps, 5, "复习进度保留");
        assert_eq!(after.state, "review");
    }

    /// Characterises **why** the fallback above is required, without touching the
    /// implementation: with the pre-需求7 rule (match by title only) the same
    /// reworded 题面 would not be found at all, so the import would mint a second
    /// card and strand the old one. Anyone can run this to see the failure mode
    /// the shipped rule prevents (the red state of
    /// `front_card_wording_edit_keeps_progress`).
    #[test]
    fn title_only_matching_would_miss_a_reworded_front_card() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, FRONT_V1, false);
        let card = find_card(&db, "🖼 · 这题怎么解？");
        let chapter_id: i64 =
            db.0.query_row("SELECT chapter_id FROM card WHERE id=?1", [card.id], |r| {
                r.get(0)
            })
            .unwrap();
        let parsed = parse_markdown(FRONT_V2, "fallback");
        let incoming = &parsed[0].chapters[0].cards[0];

        assert!(
            db.find_card_in_chapter(chapter_id, &incoming.title)
                .unwrap()
                .is_none(),
            "改措辞 → 投影变了 → 按 title 找不到（旧规则会在这里铸一张新卡）"
        );
        assert_eq!(
            db.find_front_card_in_chapter(chapter_id)
                .unwrap()
                .map(|c| c.id),
            Some(card.id),
            "发货的规则按『章节内唯一题面卡』命中同一张卡"
        );
    }

    #[test]
    fn locally_edited_keeps_local_front() {
        let db = Db::open_in_memory().unwrap();
        import_src(&db, FRONT_V1, false);
        let card = find_card(&db, "🖼 · 这题怎么解？");
        db.0.execute("UPDATE card SET locally_edited=1 WHERE id=?1", [card.id])
            .unwrap();

        let report = import_src(&db, FRONT_V2, false);
        assert_eq!((report.conflicts, report.updated), (1, 0));
        let after = db.get_card(card.id).unwrap().unwrap();
        assert_eq!(after.front_md, "![图](u1.png)\n这题怎么解？", "本地版优先");
        assert!(after.locally_edited);
    }

    #[test]
    fn duplicate_title_last_wins() {
        let db = Db::open_in_memory().unwrap();
        let src = "# D\n\n## C\n\n### 重复卡\n第一版\n\n### 重复卡\n第二版\n";
        let report = import_src(&db, src, false);
        assert_eq!(report.added, 1);
        let card = find_card(&db, "重复卡");
        assert_eq!(card.content_md, "第二版");
    }
}
