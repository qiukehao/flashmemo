//! Markdown deck parser per SPEC §5.
//!
//! `#` → deck, `##` → chapter, `###` → card front, following lines → card back.
//! Only ATX headings are structural; fenced code block contents are never parsed
//! as headings; `####` and deeper stay part of the card body.

/// Normalized parsed card: `title` is the front (H3), `content_md` the back.
///
/// Two shapes carry a 题面 in `front_md` instead:
/// - SPEC §5.2 rule 10 (需求7): a chapter with no `###` at all puts its whole
///   body in `front_md` and leaves the back empty; `title` is then the
///   single-line projection of that 题面.
/// - SPEC §5.2 rule 13 (2026-10-07): a `###` card whose body *opens* with a
///   `> [!question]` callout puts that block in `front_md` and the rest in
///   `content_md`; `title` stays the H3 text, so the identity never moves.
pub struct ParsedCard {
    pub title: String,
    pub content_md: String,
    pub front_md: String,
}

/// Single-line projection of a 题面 (SPEC §15.1): image refs fold to 🖼, line
/// breaks fold to ` · `. Deliberately literal — it is stored as the card title,
/// so it must be a pure, stable function of `front_md`.
pub fn front_title_projection(front_md: &str) -> String {
    let folded = fold_images(front_md);
    folded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
        .trim()
        .to_string()
}

/// Replace every `![alt](target)` with 🖼 (the target is not shown in a title).
fn fold_images(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let bytes: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '!' && bytes.get(i + 1) == Some(&'[') {
            if let Some(end) = image_ref_end(&bytes, i) {
                out.push('🖼');
                i = end;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// End index (exclusive) of an `![...](...)` starting at `start`, or None.
fn image_ref_end(chars: &[char], start: usize) -> Option<usize> {
    let close_alt = chars[start..].iter().position(|&c| c == ']')? + start;
    if chars.get(close_alt + 1) != Some(&'(') {
        return None;
    }
    let close_target = chars[close_alt..].iter().position(|&c| c == ')')? + close_alt;
    Some(close_target + 1)
}

/// Callout markers that mark the *question* side of a `###` card (SPEC §5.2
/// rule 13). Obsidian renders these as a titled admonition; we only read the
/// marker, the rest of the line becomes the 题面's first line.
const QUESTION_CALLOUTS: &[&str] = &["[!question]", "[!题目]", "[!题面]"];

/// `Some(tail)` when the line is a blockquote whose first token is a question
/// callout marker; `tail` is whatever followed the marker (Obsidian's callout
/// title, often empty).
fn question_callout_tail(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('>')?.trim_start();
    let lower = rest.to_lowercase();
    QUESTION_CALLOUTS
        .iter()
        .find(|m| lower.starts_with(**m))
        .map(|m| &rest[m.len()..])
}

/// Content of a blockquote line (the `>` and one following space removed), or
/// `None` when the line does not continue the quote — which ends the block.
fn quote_content(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest).to_string())
}

/// SPEC §5.2 rule 13 (2026-10-07): split a `###` card body into 题面 / 背面 when
/// its **first block** is a `> [!question]` callout. Only the first block is
/// considered, and an empty callout returns `None` so the card keeps its legacy
/// shape (whole body on the back) instead of losing its content.
fn split_question_callout(lines: &[String]) -> Option<(String, String)> {
    let start = lines.iter().position(|l| !l.trim().is_empty())?;
    let tail = question_callout_tail(&lines[start])?.trim();
    let mut front: Vec<String> = Vec::new();
    if !tail.is_empty() {
        front.push(tail.to_string());
    }
    let mut i = start + 1;
    while let Some(content) = lines.get(i).and_then(|l| quote_content(l)) {
        front.push(content);
        i += 1;
    }
    let front_md = front.join("\n").trim().to_string();
    if front_md.is_empty() {
        return None;
    }
    let content_md = lines[i..].join("\n").trim().to_string();
    Some((front_md, content_md))
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
    /// Body lines seen in the current chapter while no `###` card is open —
    /// SPEC §5.2 rule 10 (需求7): if the chapter never opens one, this becomes
    /// the chapter's single 题面卡. Ignored for chapters that do have cards.
    chapter_body: Vec<String>,
}

impl State {
    fn end_card(&mut self) {
        let Some((title, lines)) = self.card.take() else {
            return;
        };
        // SPEC §5.2 rule 13: `> [!question]` first block → 题面, rest → 背面.
        let (front_md, content_md) = match split_question_callout(&lines) {
            Some((front, back)) => (front, back),
            None => (String::new(), lines.join("\n").trim().to_string()),
        };
        let card = ParsedCard {
            title,
            content_md,
            front_md,
        };
        if let Some(ch) = &mut self.chapter {
            ch.cards.push(card);
        }
    }

    fn end_chapter(&mut self) {
        self.end_card();
        let body = std::mem::take(&mut self.chapter_body);
        if let Some(mut ch) = self.chapter.take() {
            // 题面卡 (SPEC §5.2 rule 10): no `###` anywhere in the chapter and a
            // non-empty body → one card whose front is the whole segment. An
            // empty/whitespace-only chapter produces nothing.
            if ch.cards.is_empty() {
                let front_md = body.join("\n").trim().to_string();
                let title = front_title_projection(&front_md);
                if !front_md.is_empty() && !title.is_empty() {
                    ch.cards.push(ParsedCard {
                        title,
                        content_md: String::new(),
                        front_md,
                    });
                }
            }
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
        } else {
            self.chapter_body.push(line.to_string());
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
pub(crate) fn fence_run(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    (n >= 3).then_some((c, n))
}

/// A line made only of fence chars (plus whitespace) closes an open fence.
pub(crate) fn is_closing_fence(line: &str, c: char, n: usize) -> bool {
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
        chapter_body: Vec::new(),
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
                // Body lines that belonged to the previous chapter must not leak
                // into this one (end_chapter already consumed them).
                st.chapter_body.clear();
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

    /// SPEC §5.2 rules 10/11 (需求7): a chapter with no `###` at all becomes ONE
    /// 题面卡 — the whole body goes into `front_md`, `title` is the single-line
    /// projection, the back stays empty (复习时自己写答案).
    #[test]
    fn chapter_without_h3_becomes_front_card() {
        let src = "# D\n\n## 题面章\n\n![架构图](attachment:abc.png)\n下面这句话是什么？\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters.len(), 1);
        assert_eq!(d.chapters[0].cards.len(), 1, "整段只产一张题面卡");
        let c = &d.chapters[0].cards[0];
        assert_eq!(
            c.front_md,
            "![架构图](attachment:abc.png)\n下面这句话是什么？"
        );
        assert_eq!(c.content_md, "", "背面留空");
        assert_eq!(c.title, "🖼 · 下面这句话是什么？", "title = 单行投影");
    }

    #[test]
    fn empty_chapter_makes_no_card() {
        let src = "# D\n\n## 空章\n\n   \n\n## 有卡\n\n### 卡\n背\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters.len(), 2);
        assert!(d.chapters[0].cards.is_empty(), "空章节不产卡");
        assert_eq!(d.chapters[1].cards[0].title, "卡");
    }

    /// SPEC §5.2 rule 13 (2026-10-07): a `###` card opening with `> [!question]`
    /// splits into 题面 (front) + 结构化答案 (back) — the way to write a
    /// long/image question *and* an answer on the same card.
    #[test]
    fn question_callout_splits_front_and_back() {
        let src = "# D\n\n## C\n\n### LC146 LRU 缓存\n> [!question]\n> 设计一个满足 LRU 约束的数据结构……\n> ![题面](lc146.png)\n\n思路：哈希表 + 双向链表\n\n**复杂度** 时间 O(1)\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.title, "LC146 LRU 缓存", "身份键仍是 H3 标题");
        assert_eq!(
            c.front_md,
            "设计一个满足 LRU 约束的数据结构……\n![题面](lc146.png)"
        );
        assert!(c.content_md.starts_with("思路：哈希表 + 双向链表"));
        assert!(c.content_md.contains("**复杂度** 时间 O(1)"));
        assert!(!c.content_md.contains("[!question]"));
    }

    /// The callout's own title (text after the marker) leads the 题面.
    #[test]
    fn question_callout_title_becomes_the_first_front_line() {
        let src = "# D\n\n## C\n\n### 卡\n> [!question] 题干标题\n> 正文\n\n答案\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "题干标题\n正文");
        assert_eq!(c.content_md, "答案");
    }

    #[test]
    fn question_callout_accepts_chinese_marker() {
        let src = "# D\n\n## C\n\n### 卡\n> [!题目]\n> 一段话题目\n\n答案\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "一段话题目");
        assert_eq!(c.content_md, "答案");
    }

    /// The callout must be the card's **first** block; a quote deeper in the
    /// body is ordinary content.
    #[test]
    fn question_callout_must_open_the_card() {
        let src = "# D\n\n## C\n\n### 卡\n先说明一句\n\n> [!question]\n> 后置的引用\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "", "不是首块就不拆");
        assert!(c.content_md.contains("> [!question]"));
        assert!(c.content_md.contains("后置的引用"));
    }

    /// An empty callout must not eat the card: it falls back to the legacy
    /// shape (whole body on the back).
    #[test]
    fn empty_question_callout_keeps_legacy_shape() {
        let src = "# D\n\n## C\n\n### 卡\n> [!question]\n\n答案\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "", "空题面不拆卡");
        assert!(c.content_md.contains("答案"));
    }

    /// A card whose body starts with a fenced block is not a callout card —
    /// the fence wins, so `> [!question]` inside code stays code.
    #[test]
    fn fenced_code_before_callout_is_not_a_callout() {
        let src = "# D\n\n## C\n\n### 卡\n```md\n> [!question]\n```\n答案\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "");
        assert!(c.content_md.contains("> [!question]"));
        assert!(c.content_md.contains("答案"));
    }

    #[test]
    fn question_callout_without_answer_has_empty_back() {
        let src = "# D\n\n## C\n\n### 卡\n> [!question]\n> 只有题面\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "只有题面");
        assert_eq!(c.content_md, "");
    }

    /// The compatibility guarantee: a `###` card keeps `front_md` empty, so its
    /// parsed shape is byte-for-byte what it was before 需求7.
    #[test]
    fn h3_card_has_empty_front_md() {
        let src = "# D\n\n## C\n\n### 卡\n背\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.front_md, "");
        assert_eq!(c.title, "卡");
        assert_eq!(c.content_md, "背");
    }

    #[test]
    fn front_title_is_single_line_projection() {
        let src = "# D\n\n## C\n\n行一\n行二\n![图](u.png)\n行三\n";
        let decks = parse_markdown(src, "x");
        let c = &deck(&decks, "D").chapters[0].cards[0];
        assert_eq!(c.title, "行一 · 行二 · 🖼 · 行三");
    }

    #[test]
    fn fenced_code_inside_front_card_is_kept() {
        let src = "# D\n\n## C\n\n```sql\n### 不是标题\nSELECT 1;\n```\n说明\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters[0].cards.len(), 1, "围栏里的 ### 不拆卡");
        let c = &d.chapters[0].cards[0];
        assert!(c.front_md.contains("### 不是标题"));
        assert!(c.front_md.contains("SELECT 1;"));
        assert!(c.front_md.ends_with("说明"));
        assert_eq!(c.content_md, "");
    }

    /// SPEC §5.2 rule 12: a chapter that already has a `###` card treats its
    /// leading body as a chapter-level note — it is **not** a card, and it is
    /// **not** merged into that card's front or back either (归属没有确定语义；
    /// 想让它可复习就把它放进一个没有 `###` 的章节，rule 10 会接管)。
    #[test]
    fn chapter_with_h3_keeps_legacy_shape() {
        let src = "# D\n\n## C\n\n前导段落\n\n### 卡\n背\n";
        let decks = parse_markdown(src, "x");
        let d = deck(&decks, "D");
        assert_eq!(d.chapters[0].cards.len(), 1, "前导正文不成卡");
        let c = &d.chapters[0].cards[0];
        assert_eq!(c.title, "卡");
        assert_eq!(c.front_md, "", "不并入题面");
        assert_eq!(c.content_md, "背", "也不并入背面");
        assert!(!c.content_md.contains("前导段落"));
    }

    /// Rule 9 + rule 10 together: a 题面卡 chapter that appears *before* the first
    /// `#` still belongs to the first deck (it waits in `pending`), and a file
    /// with no `#` at all falls back to the filename.
    #[test]
    fn front_card_chapter_before_the_first_h1_joins_the_first_deck() {
        let src = "## 题干章\n\n![图](u.png)\n问题\n\n# REAL\n\n### 卡\ny\n";
        let decks = parse_markdown(src, "文件名");
        assert_eq!(decks.len(), 1, "前置章节不单独成包");
        assert_eq!(decks[0].name, "REAL");
        let names: Vec<&str> = decks[0].chapters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["题干章", "未分类"]);
        let front = &decks[0].chapters[0].cards[0];
        assert_eq!(front.front_md, "![图](u.png)\n问题");
        assert_eq!(front.title, "🖼 · 问题");
    }

    #[test]
    fn front_card_only_file_uses_the_fallback_deck() {
        let src = "## 题干章\n\n问题\n";
        let decks = parse_markdown(src, "文件名");
        assert_eq!(decks.len(), 1);
        assert_eq!(decks[0].name, "文件名");
        assert_eq!(decks[0].chapters[0].cards[0].front_md, "问题");
        assert_eq!(decks[0].chapters[0].cards[0].title, "问题");
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
