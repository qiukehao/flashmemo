/**
 * TypeScript mirror of `src-tauri/src/parser.rs` (SPEC §5) used ONLY by the
 * browser mock backend (`mockBackend.ts`), so import flows can be exercised in
 * a plain browser. The Rust parser stays the single source of truth for the
 * real app — keep the two in sync when §5 rules change.
 */

export interface ParsedCard {
  title: string;
  contentMd: string;
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

export function parseMarkdown(src: string, fallbackDeck: string): ParsedDeck[] {
  const text = src.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const decks: ParsedDeck[] = [];
  let deck: ParsedDeck | null = null;
  const pending: ParsedChapter[] = [];
  let chapter: ParsedChapter | null = null;
  let card: { title: string; lines: string[] } | null = null;
  let fence: [string, number] | null = null;

  const endCard = () => {
    if (!card) return;
    if (chapter) chapter.cards.push({ title: card.title, contentMd: card.lines.join("\n").trim() });
    card = null;
  };
  const endChapter = () => {
    endCard();
    if (chapter) (deck ? deck.chapters : pending).push(chapter);
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
      card?.lines.push(line);
      continue;
    }
    if (fence) {
      card?.lines.push(line);
      continue;
    }
    const h = headingLevel(line);
    if (h && h[0] === 1) {
      flushDeck();
      deck = { name: h[1], chapters: pending.splice(0) };
    } else if (h && h[0] === 2) {
      endChapter();
      chapter = { name: h[1], cards: [] };
    } else if (h && h[0] === 3) {
      endCard();
      if (!chapter) chapter = { name: DEFAULT_CHAPTER, cards: [] };
      card = { title: h[1], lines: [] };
    } else {
      card?.lines.push(line);
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
