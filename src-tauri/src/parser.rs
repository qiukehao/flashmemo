//! Markdown deck parser per SPEC §5.
//!
//! `#` → deck, `##` → chapter, `###` → card front, following lines → card back.
//! Only ATX headings are structural; fenced code block contents are never parsed
//! as headings; `####` and deeper stay part of the card body.

/// Normalized parsed card: `title` is the front (H3), `content_md` the back.
pub struct ParsedCard {
    pub title: String,
    pub content_md: String,
}

pub struct ParsedChapter {
    pub name: String,
    pub cards: Vec<ParsedCard>,
}

pub struct ParsedDeck {
    pub name: String,
    pub chapters: Vec<ParsedChapter>,
}

/// Chapter assigned to `###` cards that appear before any `##` (SPEC §5.2 rule 5).
const DEFAULT_CHAPTER: &str = "未分类";

/// One entry in the parser state machine: card body lines are collected raw and
/// only trimmed/joined when the card ends, so blank lines inside the body survive.
/// Chapters seen before the first `#` wait in `pending` and join the first deck
/// that appears (SPEC §5.2 rule 9: the filename is only a fallback when the file
/// has no H1 at all).
struct State {
    decks: Vec<ParsedDeck>,
    deck: Option<ParsedDeck>,
    pending: Vec<ParsedChapter>,
    chapter: Option<ParsedChapter>,
    card: Option<(String, Vec<String>)>,
}

impl State {
    fn end_card(&mut self) {
        let Some((title, lines)) = self.card.take() else {
            return;
        };
        let card = ParsedCard {
            title,
            content_md: lines.join("\n").trim().to_string(),
        };
        if let Some(ch) = &mut self.chapter {
            ch.cards.push(card);
        }
    }

    fn end_chapter(&mut self) {
        self.end_card();
        if let Some(ch) = self.chapter.take() {
            match &mut self.deck {
                Some(d) => d.chapters.push(ch),
                None => self.pending.push(ch),
            }
        }
    }

    /// Called when a new H1 starts: emit the finished deck, carry `pending`
    /// over to the upcoming deck.
    fn flush_deck(&mut self) {
        self.end_chapter();
        if let Some(d) = self.deck.take() {
            self.decks.push(d);
        }
    }

    /// End of input: emit the last deck; chapters still pending belong to a
    /// fallback deck only when no H1 ever appeared.
    fn finish(&mut self, fallback_deck: &str) {
        self.flush_deck();
        if !self.pending.is_empty() {
            self.decks.push(ParsedDeck {
                name: fallback_deck.to_string(),
                chapters: std::mem::take(&mut self.pending),
            });
        }
    }

    fn ensure_chapter(&mut self) {
        if self.chapter.is_none() {
            self.chapter = Some(ParsedChapter {
                name: DEFAULT_CHAPTER.to_string(),
                cards: Vec::new(),
            });
        }
    }

    fn push_body(&mut self, line: &str) {
        if let Some((_, lines)) = &mut self.card {
            lines.push(line.to_string());
        }
    }
}

/// ATX heading level + text, or None. Setext and `#`-runs without a following
/// space are plain text (SPEC §5.2 rules 1/2).
fn heading_level(line: &str) -> Option<(usize, String)> {
    let t = line.trim_start();
    let level = t.chars().take_while(|&c| c == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &t[level..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim_end();
    if text.is_empty() {
        return None;
    }
    Some((level, text.to_string()))
}

/// Fence run of >=3 ` or ~ at line start (CommonMark allows up to 3 spaces of
/// indent). Returns the fence char and its length.
fn fence_run(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    (n >= 3).then_some((c, n))
}

/// A line made only of fence chars (plus whitespace) closes an open fence.
fn is_closing_fence(line: &str, c: char, n: usize) -> bool {
    let t = line.trim();
    t.chars().all(|x| x == c) && t.chars().count() >= n
}

pub fn parse_markdown(src: &str, fallback_deck: &str) -> Vec<ParsedDeck> {
    // SPEC §5.2 rule 7: strip BOM, normalize CRLF/CR to LF before scanning.
    let src = src
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut st = State {
        decks: Vec::new(),
        deck: None,
        pending: Vec::new(),
        chapter: None,
        card: None,
    };
    let mut fence: Option<(char, usize)> = None;

    for line in src.lines() {
        if let Some((c, n)) = fence_run(line) {
            match fence {
                Some((oc, on)) if c == oc && n >= on && is_closing_fence(line, c, n) => {
                    fence = None;
                }
                None => fence = Some((c, n)),
                _ => {}
            }
            st.push_body(line);
            continue;
        }
        if fence.is_some() {
            st.push_body(line);
            continue;
        }
        match heading_level(line) {
            Some((1, name)) => {
                st.flush_deck();
                st.deck = Some(ParsedDeck {
                    name,
                    chapters: std::mem::take(&mut st.pending),
                });
            }
            Some((2, name)) => {
                st.end_chapter();
                st.chapter = Some(ParsedChapter {
                    name,
                    cards: Vec::new(),
                });
            }
            Some((3, title)) => {
                st.end_card();
                st.ensure_chapter();
                st.card = Some((title, Vec::new()));
            }
            // `####` and deeper are body text (SPEC §5.2 rule 4).
            _ => st.push_body(line),
        }
    }
    st.finish(fallback_deck);
    st.decks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck<'a>(decks: &'a [ParsedDeck], name: &str) -> &'a ParsedDeck {
        decks
            .iter()
            .find(|d| d.name == name)
            .unwrap_or_else(|| panic!("deck {name} not found"))
    }

    fn card_total(d: &ParsedDeck) -> usize {
        d.chapters.iter().map(|c| c.cards.len()).sum()
    }

    #[test]
    fn parses_basic_structure() {
        let src = "# MySQL\n\n## 事务\n\n### ACID 是什么？\n- **原子性**：不可分割\n- **一致性**：一致状态\n\n### 隔离级别有哪些？\n1. 读未提交\n2. 读已提交\n";
        let decks = parse_markdown(src, "fallback");
        assert_eq!(decks.len(), 1);
        let d = deck(&decks, "MySQL");
        assert_eq!(d.chapters.len(), 1);
        assert_eq!(d.chapters[0].name, "事务");
        assert_eq!(d.chapters[0].cards.len(), 2);
        assert_eq!(d.chapters[0].cards[0].title, "ACID 是什么？");
        assert!(d.chapters[0].cards[0]
            .content_md
            .contains("- **原子性**：不可分割"));
        assert_eq!(d.chapters[0].cards[1].title, "隔离级别有哪些？");
        assert!(d.chapters[0].cards[1].content_md.contains("2. 读已提交"));
    }

    #[test]
    fn parses_code_fence_hash_as_content() {
        let src = "# Deck\n\n## 章\n\n### 卡A\n```sql\nSELECT 1; -- # 注释\n### 不拆卡\n```\n后面还有正文\n\n### 卡B\n~~~\n~~~ 内的 ## 也不是标题\n~~~\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "Deck");
        assert_eq!(card_total(d), 2, "fence lines must not split cards");
        let a = &d.chapters[0].cards[0];
        assert!(a.content_md.contains("-- # 注释"));
        assert!(a.content_md.contains("### 不拆卡"));
        assert!(a.content_md.contains("后面还有正文"));
        let b = &d.chapters[0].cards[1];
        assert!(b.content_md.contains("~~~ 内的 ## 也不是标题"));
    }

    #[test]
    fn parses_setext_ignored() {
        // Setext underline lines are plain text: no new card/chapter is created.
        let src = "# D\n\n## C\n\n### 卡\n正文一\n下划线标题\n=====\n正文二\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters.len(), 1);
        assert_eq!(card_total(d), 1);
        let content = &d.chapters[0].cards[0].content_md;
        assert!(content.contains("====="));
        assert!(content.contains("正文二"));
    }

    #[test]
    fn keeps_h4_deep_headings() {
        let src = "# D\n\n## C\n\n### 卡\n#### 四级标题\n内容\n";
        let decks = parse_markdown(src, "x");
        let content = &deck(&decks, "D").chapters[0].cards[0].content_md;
        assert!(content.contains("#### 四级标题"));
        assert!(content.contains("内容"));
    }

    #[test]
    fn h3_without_h2_uses_default_chapter() {
        let src = "# D\n\n### 孤儿卡\n要点\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters.len(), 1);
        assert_eq!(d.chapters[0].name, DEFAULT_CHAPTER);
        assert_eq!(d.chapters[0].cards[0].title, "孤儿卡");
    }

    #[test]
    fn no_h1_uses_fallback_name() {
        let src = "## 章\n\n### 卡\n要点\n";
        let decks = parse_markdown(src, "文件名卡包");
        assert_eq!(decks.len(), 1);
        assert_eq!(decks[0].name, "文件名卡包");
        assert_eq!(decks[0].chapters[0].name, "章");
    }

    #[test]
    fn pre_h1_content_joins_first_deck() {
        // Content before the first H1 must NOT become a filename deck when a
        // real H1 exists later in the file.
        let src = "## C1\n\n### 卡1\nx\n\n# REAL\n\n### 卡2\ny\n";
        let decks = parse_markdown(src, "文件名卡包");
        assert_eq!(decks.len(), 1, "no filename deck when an H1 exists");
        assert_eq!(decks[0].name, "REAL");
        let names: Vec<&str> = decks[0].chapters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["C1", "未分类"]);
    }

    #[test]
    fn multiple_h1_splits_decks() {
        let src = "# A\n\n## C1\n\n### 卡1\nx\n\n# B\n\n### 卡2\ny\n";
        let decks = parse_markdown(src, "x");
        assert_eq!(decks.len(), 2);
        assert_eq!(deck(&decks, "A").chapters[0].cards[0].title, "卡1");
        assert_eq!(deck(&decks, "B").chapters[0].cards[0].title, "卡2");
    }

    #[test]
    fn parses_crlf_and_bom() {
        // Fixture is UTF-8 with BOM + CRLF (SPEC §5.2 rule 7).
        let src = include_str!("../tests/fixtures/sample-mysql.md");
        let decks = parse_markdown(src, "fallback");
        assert_eq!(decks.len(), 1);
        let d = deck(&decks, "MySQL");
        assert_eq!(d.chapters.len(), 2);
        assert_eq!(card_total(d), 3);
        let bplus = &d.chapters[1].cards[0];
        assert_eq!(bplus.title, "B+ 树和 B 树的区别？");
        assert!(bplus.content_md.contains("-- # 这是注释"));
        assert!(bplus.content_md.contains("### 这行在代码块里"));
    }
}
