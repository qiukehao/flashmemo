/**
 * TypeScript mirror of `src-tauri/src/parser.rs` (SPEC §5) used ONLY by the
 * browser mock backend (`mockBackend.ts`), so import flows can be exercised in
 * a plain browser. The Rust parser stays the single source of truth for the
 * real app — keep the two in sync when §5 rules change.
 */

export interface ParsedCard {
  title: string;
  contentMd: string;
  /** 题面（正面）Markdown —— 题面卡专用（SPEC §5.2 rule 10，需求7）。
   *  普通 `###` 卡恒为 `""`（正面就是 `title`），与 Rust `ParsedCard.front_md` 对齐。 */
  frontMd: string;
}

export interface ParsedChapter {
  name: string;
  cards: ParsedCard[];
}

export interface ParsedDeck {
  name: string;
  chapters: ParsedChapter[];
}

export const DEFAULT_CHAPTER = "未分类";

/**
 * 单行投影（镜像 `parser::front_title_projection`，SPEC §15.1）：图片引用折成
 * 🖼、按行 trim 后**跳过空行**、用 ` · ` 连接。它是卡片的身份键（存在 `title` 里），
 * 所以必须是 `frontMd` 的纯函数、逐字稳定。
 */
export function frontTitleProjection(frontMd: string): string {
  return foldImages(frontMd)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" · ")
    .trim();
}

/** 把每个 `![alt](target)` 折成 🖼（镜像 `parser::fold_images`，逐码点扫描）。 */
function foldImages(src: string): string {
  const chars = Array.from(src);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "!" && chars[i + 1] === "[") {
      const end = imageRefEnd(chars, i);
      if (end !== null) {
        out += "🖼";
        i = end;
        continue;
      }
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

/** `![...](...)` 的结束下标（不含），从 `start`（指向 `!`）开始；不完整返回 null。 */
function imageRefEnd(chars: string[], start: number): number | null {
  const closeAlt = chars.indexOf("]", start);
  if (closeAlt < 0 || chars[closeAlt + 1] !== "(") return null;
  const closeTarget = chars.indexOf(")", closeAlt);
  if (closeTarget < 0) return null;
  return closeTarget + 1;
}

function headingLevel(line: string): [number, string] | null {
  const t = line.trimStart();
  const level = (t.match(/^#+/) ?? [""])[0].length;
  if (level === 0 || level > 6) return null;
  const rest = t.slice(level);
  if (!rest.startsWith(" ") && !rest.startsWith("\t")) return null;
  const text = rest.trim().replace(/#+$/, "").trimEnd();
  if (!text) return null;
  return [level, text];
}

function fenceRun(line: string): [string, number] | null {
  const t = line.trimStart();
  const c = t[0];
  if (c !== "`" && c !== "~") return null;
  const n = (t.match(new RegExp(`^\\${c}+`)) ?? [""])[0].length;
  return n >= 3 ? [c, n] : null;
}

/** 题面标注块的标记（镜像 Rust `QUESTION_CALLOUTS`，SPEC §5.2 rule 13）。 */
const QUESTION_CALLOUTS = ["[!question]", "[!题目]", "[!题面]"];

/** 行是「以题面标注块开头」的引用行时返回标记之后的内容，否则 null。 */
function questionCalloutTail(line: string): string | null {
  const t = line.trimStart();
  if (!t.startsWith(">")) return null;
  const rest = t.slice(1).trimStart();
  const lower = rest.toLowerCase();
  const marker = QUESTION_CALLOUTS.find((m) => lower.startsWith(m));
  return marker ? rest.slice(marker.length) : null;
}

/** 引用行的内容（去掉 `>` 与紧随的一个空格）；不是引用行返回 null（即块结束）。 */
function quoteContent(line: string): string | null {
  const t = line.trimStart();
  if (!t.startsWith(">")) return null;
  const rest = t.slice(1);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * SPEC §5.2 rule 13（镜像 Rust `split_question_callout`）：`###` 卡正文**首块**是
 * `> [!question]` 标注块时，它进题面、其余进背面；空题面返回 null（保持旧形状）。
 */
function splitQuestionCallout(lines: string[]): [string, string] | null {
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start < 0) return null;
  const tail = questionCalloutTail(lines[start]);
  if (tail === null) return null;
  const front: string[] = [];
  if (tail.trim()) front.push(tail.trim());
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const content = quoteContent(lines[i]);
    if (content === null) break;
    front.push(content);
  }
  const frontMd = front.join("\n").trim();
  if (!frontMd) return null;
  return [frontMd, lines.slice(i).join("\n").trim()];
}

export function parseMarkdown(src: string, fallbackDeck: string): ParsedDeck[] {
  const text = src.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const decks: ParsedDeck[] = [];
  let deck: ParsedDeck | null = null;
  const pending: ParsedChapter[] = [];
  let chapter: ParsedChapter | null = null;
  let card: { title: string; lines: string[] } | null = null;
  let fence: [string, number] | null = null;
  /** 当前章节里"还没有 `###` 卡打开"时收到的正文行（镜像 Rust `chapter_body`）。
   *  章节最终没有 `###` 卡时，这些行变成该章节唯一的题面卡（rule 10）。 */
  const chapterBody: string[] = [];

  const pushBody = (line: string) => {
    if (card) card.lines.push(line);
    else chapterBody.push(line);
  };

  const endCard = () => {
    if (!card) return;
    if (chapter) {
      // rule 13：首块 `> [!question]` → 题面，其余 → 背面（与 Rust 对齐）。
      const split = splitQuestionCallout(card.lines);
      chapter.cards.push(
        split
          ? { title: card.title, contentMd: split[1], frontMd: split[0] }
          : { title: card.title, contentMd: card.lines.join("\n").trim(), frontMd: "" },
      );
    }
    card = null;
  };
  const endChapter = () => {
    endCard();
    const body = chapterBody.splice(0, chapterBody.length);
    if (chapter) {
      // 题面卡（SPEC §5.2 rule 10）：整章没有 `###` 卡且正文非空 → 一张卡，
      // 正面 = 整段、背面留空。空/纯空白章节不产卡。章节里有 `###` 卡时，
      // 上面的正文按 rule 12 丢弃（不成卡、也不并入任何卡）。
      if (chapter.cards.length === 0) {
        const frontMd = body.join("\n").trim();
        const title = frontTitleProjection(frontMd);
        if (frontMd && title) chapter.cards.push({ title, contentMd: "", frontMd });
      }
      (deck ? deck.chapters : pending).push(chapter);
    }
    chapter = null;
  };
  const flushDeck = () => {
    endChapter();
    if (deck) decks.push(deck);
    deck = null;
  };

  for (const line of text.split("\n")) {
    const f = fenceRun(line);
    if (f) {
      if (fence && f[0] === fence[0] && f[1] >= fence[1] && line.trim().replace(new RegExp(`^\\${f[0]}+$`), "") === "") {
        fence = null;
      } else if (!fence) {
        fence = f;
      }
      // 围栏行也是正文：没有 `###` 打开时归入题面（rule 11：围栏里的 `###` 不拆卡）。
      pushBody(line);
      continue;
    }
    if (fence) {
      pushBody(line);
      continue;
    }
    const h = headingLevel(line);
    if (h && h[0] === 1) {
      flushDeck();
      deck = { name: h[1], chapters: pending.splice(0) };
    } else if (h && h[0] === 2) {
      endChapter();
      chapter = { name: h[1], cards: [] };
      // 上一章的正文行不能被带进这一章（endChapter 已经消费掉）。
      chapterBody.length = 0;
    } else if (h && h[0] === 3) {
      endCard();
      if (!chapter) chapter = { name: DEFAULT_CHAPTER, cards: [] };
      card = { title: h[1], lines: [] };
    } else {
      pushBody(line);
    }
  }
  flushDeck();
  if (pending.length) decks.push({ name: fallbackDeck, chapters: pending.splice(0) });
  return decks;
}

/** Decks that actually contain cards (stray empty H1 headings are dropped). */
export function nonEmptyDecks(decks: ParsedDeck[]): ParsedDeck[] {
  return decks
    .map((d) => ({ name: d.name, chapters: d.chapters.filter((ch) => ch.cards.length > 0) }))
    .filter((d) => d.chapters.length > 0);
}
