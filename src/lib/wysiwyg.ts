import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { imageMarkdown } from "./attachments";
import { logFrontend } from "./logger";
import { renderCard } from "./markdown";

/**
 * WYSIWYG editing keeps markdown as the source of truth (SPEC §9): the popup
 * edits the *rendered* card (contenteditable) and converts the DOM back to
 * markdown on save. Because we only ever convert HTML produced by our own
 * `renderCard`, the round-trip subset is fully under our control — the custom
 * rules below cover the annotation trio plus fenced code blocks.
 */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  td.use(gfm);

  // ==高亮==
  td.addRule("mark", {
    filter: ["mark"],
    replacement: (content) => `==${content}==`,
  });

  // %%备注%% — the note block, with the 📝 icon stripped back out.
  td.addRule("cardNote", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).classList?.contains("card-note"),
    replacement: (_content, node) => {
      const clone = (node as HTMLElement).cloneNode(true) as HTMLElement;
      clone.querySelector(".card-note-icon")?.remove();
      const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      return text ? `\n\n%%${text}%%\n\n` : "";
    },
  });

  // Obsidian callouts: div.callout wraps a title <p> + the body blockquote.
  // The title must not leak into the body markdown…
  td.addRule("calloutTitle", {
    filter: (node) =>
      node.nodeName === "P" &&
      (node as HTMLElement).classList?.contains("callout-title"),
    replacement: () => "",
  });
  // …and the block itself goes back to `> [!type] title` + quoted body lines.
  td.addRule("callout", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).classList?.contains("callout"),
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const type =
        [...el.classList].find((c) => c.startsWith("callout-"))?.slice(8) ?? "note";
      const title =
        el.querySelector(".callout-title-text")?.textContent?.trim() ?? "";
      // `content` is the already-converted child blockquote ("&gt; line" form).
      const body = content.trim();
      const marker = `> [!${type}]${title ? ` ${title}` : ""}`;
      return `\n\n${marker}\n${body}\n\n`;
    },
  });

  // Images (SPEC §5.4): the live DOM carries an asset URL in `src`, while the
  // markdown source of truth sits in `data-md-raw`. Writing that back verbatim
  // keeps an autosave from rewriting image references.
  td.addRule("cardImage", {
    filter: (node) => node.nodeName === "IMG",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const raw = el.getAttribute("data-md-raw");
      if (raw) return raw;
      const src = el.getAttribute("data-md-src") || el.getAttribute("src") || "";
      return imageMarkdown(
        el.getAttribute("alt") ?? "",
        src,
        el.getAttribute("title"),
      );
    },
  });
  // A card image that could not be loaded (missing file / remote URL) renders
  // as a placeholder span; without this rule an edit would silently drop it.
  td.addRule("missingImage", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).classList?.contains("card-image-missing"),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const raw = el.getAttribute("data-md-raw");
      if (raw) return raw;
      return imageMarkdown(
        el.getAttribute("data-md-alt") ?? "",
        el.getAttribute("data-md-src") ?? "",
      );
    },
  });

  // Fenced code blocks with their language (```js ... ```).
  td.addRule("fencedCode", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector("code");
      const lang =
        code?.className.match(/language-([\w+-]+)/)?.[1] ?? "";
      const text = (code?.textContent ?? "").replace(/\n$/, "");
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  });

  // Footnotes (markdown-it-footnote): the superscript ref goes back to `[^n]`
  // and the definitions section to `[^n]: text` lines, so a WYSIWYG edit of a
  // card containing footnotes round-trips instead of dropping them.
  td.addRule("footnoteRef", {
    filter: (node) =>
      node.nodeName === "SUP" &&
      (node as HTMLElement).classList?.contains("footnote-ref"),
    replacement: (_content, node) => {
      const label = (node as HTMLElement).textContent ?? "";
      const n = label.replace(/[[\]]/g, "").trim();
      return `[^${n}]`;
    },
  });
  td.addRule("footnoteSection", {
    filter: (node) =>
      node.nodeName === "SECTION" &&
      (node as HTMLElement).classList?.contains("footnotes"),
    replacement: (_content, node) => {
      const items = Array.from(
        (node as HTMLElement).querySelectorAll("li.footnote-item"),
      );
      const lines = items.map((li) => {
        const m = /fn(\d+)/.exec(li.id);
        const n = m ? m[1] : "";
        const clone = li.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("a.footnote-backref").forEach((a) => a.remove());
        const body = turndown
          .turndown(clone.innerHTML)
          .replace(/\n+/g, "\n")
          .trim();
        return `[^${n}]: ${body}`;
      });
      return `\n\n${lines.join("\n")}\n`;
    },
  });

  return td;
}

const turndown = makeTurndown();

/**
 * A `<table>` with no rows has no markdown meaning, but turndown's gfm table
 * rule reads `node.rows[0]` and throws a TypeError on one
 * (`isHeadingRow(undefined)` → `undefined.parentNode`). An editing command can
 * leave such a table behind, and the throw used to escape `htmlToMarkdown`,
 * rejecting the autosave promise: the edit was never saved and the app only
 * logged `unhandled rejection`. Dropping row-less tables first is lossless —
 * their `<caption>` (if any) is real text, so it is kept as a paragraph.
 */
function dropRowlessTables(html: string): string {
  if (!html.includes("<table")) return html;
  const holder = document.implementation.createHTMLDocument("").createElement("div");
  holder.innerHTML = html;
  let dropped = 0;
  holder.querySelectorAll("table").forEach((table) => {
    if (table.rows.length > 0) return;
    const caption = (table.caption?.textContent ?? "").trim();
    if (caption) {
      const p = holder.ownerDocument.createElement("p");
      p.textContent = caption;
      table.replaceWith(p);
    } else {
      table.remove();
    }
    dropped += 1;
  });
  if (dropped === 0) return html;
  void logFrontend("warn", `wysiwyg: dropped ${dropped} row-less <table> before saving`);
  return holder.innerHTML;
}

/** `> ` / `> > ` / `  > ` — the quote prefix turndown puts on quoted lines. */
const QUOTE_PREFIX = /^ {0,3}(?:> ?)+/;

/** A quoted line that carries no text at all (`>`, `> >`, `>   `). */
function isEmptyQuoteLine(line: string): boolean {
  return /^ {0,3}(?:> ?)+[ \t]*$/.test(line);
}

/**
 * One converter output line: normalize the list marker *after* stripping the
 * quote prefix (turndown pads markers to `-   a`, and the quoted form escaped
 * the old top-level regexes — `> - a` was stored back as `> -   a`, a silent
 * rewrite of the user's card), and canonicalize empty lines (`>   ` → `>`, a
 * whitespace-only line → nothing).
 */
function normalizeLine(line: string): string {
  const prefix = QUOTE_PREFIX.exec(line)?.[0] ?? "";
  const body = line.slice(prefix.length);
  // An empty quoted line keeps the user's own spelling (`>` stays `>`, `> `
  // stays `> `) — only the padding turndown added is dropped. A whitespace-only
  // line outside a quote carries no meaning and goes away.
  if (!body.trim()) return prefix;
  const fixed = body
    .replace(/^(\s*)([-*+]) {2,}/, "$1$2 ")
    .replace(/^(\s*- \[[ x]\]) {2,}/, "$1 ")
    .replace(/^(\s*\d+\.) {2,}/, "$1 ");
  return prefix + fixed;
}

/**
 * An empty quoted line at the END of a quote run means nothing: it is what a
 * trailing `<p><br></p>` inside a `<blockquote>` serializes to (i.e. "press
 * Enter on the last quoted line, then navigate away"), and it saved a `>` line
 * that renders back as an invisible empty block. Empty quoted lines *between*
 * two quoted lines are kept — that is the `> a\n> \n> b` spelling.
 */
function dropTrailingEmptyQuoteLines(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    let end = run.length;
    while (end > 0 && isEmptyQuoteLine(run[end - 1])) end--;
    out.push(...run.slice(0, end));
    run = [];
  };
  for (const line of lines) {
    if (QUOTE_PREFIX.test(line)) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

/**
 * Collapse runs of blank lines to a single blank line, so DOM→MD is a fixed
 * point: the "quote + empty paragraph + quote" DOM that `handleQuoteExit`
 * leaves behind first saved as `> 上\n\n\n\n> 下` and only converged on the
 * second save (card spacing jumped on every edit). Fenced code is skipped —
 * blank lines there are content.
 */
function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      blanks = 0;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out;
}

/** Convert the edited card DOM back into card markdown. */
export function htmlToMarkdown(html: string): string {
  const raw = turndown.turndown(dropRowlessTables(html));
  const lines = raw.split("\n").map(normalizeLine);
  return collapseBlankLines(dropTrailingEmptyQuoteLines(lines)).join("\n").trim();
}

// ---------------------------------------------------------------- 撤销/重做
// The card editors are UNCONTROLLED contenteditable (the DOM is written once
// per card so autosaves never reset the caret), and every annotation action
// below is raw DOM surgery through the Range API — which clears or bypasses
// the browser's native undo stack (user report 2026-10-07: Ctrl+Z did
// nothing). So the editors own the undo history: a plain innerHTML snapshot
// stack, wired by the components (reset on card load, push on the autosave
// debounce, intercept Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).

export interface UndoStack {
  /**
   * Snapshot the editor's current HTML (deduped). `kind` controls granularity:
   * "typing" coalesces bursts (one undo step per burst), "action" (toolbar /
   * context-menu surgery) always becomes its own step — call it right after
   * the mutation, or an immediate Ctrl+Z would have nothing to revert to.
   */
  push(kind?: "typing" | "action"): void;
  /** Drop history: the current DOM is the new baseline. */
  reset(): void;
  /** Restore the previous snapshot. Returns true when the DOM changed. */
  undo(): boolean;
  /** Restore the next snapshot (after an undo). Returns true when changed. */
  redo(): boolean;
}

const UNDO_LIMIT = 100;
/** Typing bursts inside this window collapse into one undo step. */
const COALESCE_MS = 600;

export function createUndoStack(getEl: () => HTMLElement | null): UndoStack {
  let entries: string[] = [];
  let index = -1;
  let lastPushAt = 0;
  let lastWriteAt = 0;
  const write = (html: string): boolean => {
    const el = getEl();
    if (!el) return false;
    if (el.innerHTML === html) return false;
    el.innerHTML = html;
    // The snapshot boundary loses the caret; park it at the end so typing
    // continues instead of erroring on a detached selection.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  };
  return {
    push(kind = "action") {
      const el = getEl();
      if (!el) return;
      const html = el.innerHTML;
      if (entries[index] === html) return;
      const now = Date.now();
      // 打字连击合并成一步撤销；刚做过 undo/redo 时不合并——恢复出来的
      // 状态不能被下一个字覆盖掉，否则它就从历史里消失了。
      const coalesce =
        kind === "typing" &&
        entries.length > 0 &&
        index === entries.length - 1 &&
        now - lastPushAt <= COALESCE_MS &&
        now - lastWriteAt > COALESCE_MS;
      if (coalesce) {
        entries[index] = html;
      } else {
        entries = entries.slice(0, index + 1);
        entries.push(html);
        if (entries.length > UNDO_LIMIT) entries.splice(0, entries.length - UNDO_LIMIT);
        index = entries.length - 1;
      }
      lastPushAt = now;
    },
    reset() {
      const el = getEl();
      entries = el ? [el.innerHTML] : [];
      index = entries.length - 1;
      lastPushAt = 0;
      lastWriteAt = 0;
    },
    undo() {
      if (index <= 0) return false;
      index -= 1;
      const changed = write(entries[index]!);
      if (changed) lastWriteAt = Date.now();
      return changed;
    },
    redo() {
      if (index >= entries.length - 1) return false;
      index += 1;
      const changed = write(entries[index]!);
      if (changed) lastWriteAt = Date.now();
      return changed;
    },
  };
}

// ------------------------------------------------------------------- 粘贴
// Ctrl+V used to fall through to the browser's native paste, which dumped the
// source page's HTML (fonts, colors, spans) straight into the card DOM; the
// save-side conversion then stripped it, so what the user saw while editing
// never matched the card. Pastes are now normalized to card markup at the
// caret: rich HTML → markdown → renderCard, plain text → <br> lines.

/** Escape plain text for insertHTML, keeping line breaks visible. */
function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.split("\n").map((line) => (line ? line : "<br>")).join("<br>");
}

/**
 * Insert HTML at the caret inside `editor` (Range API — execCommand is
 * deprecated and missing in jsdom). Falls back to appending at the end when
 * there is no usable caret in the editor.
 */
function insertHtmlAtCaret(editor: HTMLElement, html: string): void {
  const sel = window.getSelection();
  const range =
    sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)
      ? sel.getRangeAt(0)
      : null;
  if (!range) {
    editor.insertAdjacentHTML("beforeend", html);
    return;
  }
  range.deleteContents();
  const frag = range.createContextualFragment(html);
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last && sel) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

/**
 * Normalize a clipboard paste into card markup at the caret. Call this from
 * the paste handler SYNCHRONOUSLY — preventDefault only works during event
 * dispatch. Returns true when the default paste was replaced.
 */
export function pasteStructured(editor: HTMLElement, e: ClipboardEvent): boolean {
  const data = e.clipboardData;
  if (!data) return false;
  const html = data.getData("text/html");
  const text = data.getData("text/plain");
  if (!html && !text) return false;
  e.preventDefault();
  if (html) {
    let cardHtml: string;
    try {
      cardHtml = renderCard(htmlToMarkdown(html));
    } catch (err) {
      // 外部剪贴板内容千奇百怪：转换失败就退回纯文本，绝不把异常抛进事件处理。
      void logFrontend("warn", `paste normalize failed: ${String(err)}`);
      cardHtml = plainTextToHtml(text || html);
    }
    insertHtmlAtCaret(editor, cardHtml);
    return true;
  }
  insertHtmlAtCaret(editor, plainTextToHtml(text));
  return true;
}

/**
 * Wrap the current selection inside `root` with a tag (used by the B / 🖍 / 📝
 * toolbar). When the selection is already wrapped, the wrapper is removed
 * again (toggle behaviour). Pure DOM helper so the toolbar stays tiny.
 */
export function wrapSelection(
  root: HTMLElement,
  tag: string,
  className?: string,
): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;

  // Toggle off when the whole selection already lives inside the wrapper.
  // Match tag + class exactly (a bare `closest("div")` would match the editor
  // root itself and tear it out of the DOM).
  const containerParent =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : (range.commonAncestorContainer.parentElement as HTMLElement | null);
  const selector = className ? `${tag}.${className}` : tag;
  const existing = containerParent?.closest(selector);
  if (existing && existing !== root && root.contains(existing)) {
    // Drop the note icon so it cannot leak into the text.
    existing.querySelector(":scope > .card-note-icon")?.remove();
    const frag = document.createDocumentFragment();
    while (existing.firstChild) frag.appendChild(existing.firstChild);
    existing.replaceWith(frag);
    return true;
  }

  if (range.collapsed) return false;
  const wrapper = document.createElement(tag);
  if (className) wrapper.className = className;

  // Note blocks are block-level: use the annotation icon inside.
  if (className === "card-note") {
    const icon = document.createElement("span");
    icon.className = "card-note-icon";
    icon.textContent = "📝";
    wrapper.appendChild(icon);
  }
  try {
    range.surroundContents(wrapper);
  } catch {
    // Selection crosses element boundaries: rebuild it manually.
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  }
  sel.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(wrapper);
  sel.addRange(after);
  return true;
}

/** Insert an empty 📝 note block after the caret's block (toolbar 📝 with no
 *  selection): the user just types into it. */
export function insertNoteBlock(root: HTMLElement): boolean {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const inRoot = Boolean(range && root.contains(range.commonAncestorContainer));

  const note = document.createElement("div");
  note.className = "card-note";
  const icon = document.createElement("span");
  icon.className = "card-note-icon";
  icon.textContent = "📝";
  note.appendChild(icon);
  const textNode = document.createTextNode("");
  note.appendChild(textNode);

  // 光标不在卡面里时（刚点过右键菜单 / 打开了 AI 侧栏，选区被按钮或原生 WebView
  // 拿走，rangeCount 甚至为 0）不能静默 return false —— 那会让「📝 备注」点了没
  // 反应，用户只看到"什么也没发生"。退化成挂在卡面末尾，并把光标放进新块里。
  if (!range || !inRoot) {
    root.appendChild(note);
    caretTo(textNode, false);
    return true;
  }

  // Place it right after the block the caret is in (top-level child of root);
  // in an empty editor the caret sits on the root itself, so append inside.
  let block: Node = range.startContainer;
  if (block !== root) {
    while (block.parentNode && block.parentNode !== root) block = block.parentNode;
  }
  if (block === root) {
    root.appendChild(note);
  } else {
    block.parentNode?.insertBefore(note, block.nextSibling);
  }

  caretTo(textNode, false);
  return true;
}

// --------------------------------------------------------------- 引用块退出
// WebView2 only ever adds another line *inside* a <blockquote>, so plain Enter
// can never leave it (user report 2026-10-05: 引用后无法回到普通段落). Every
// Markdown editor exits on Enter from an EMPTY quoted line — that is what this
// handler implements, plus the matching Backspace.

/** Caret's block inside `quote` (its direct child), or null when outside. */
function quotedBlock(root: HTMLElement, quote: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : (node.parentElement as HTMLElement | null);
  if (!el || !root.contains(el) || !quote.contains(el)) return null;
  let block: HTMLElement = el;
  while (block.parentElement && block.parentElement !== quote) block = block.parentElement;
  return block.parentElement === quote ? block : null;
}

/** Block-level content that makes an otherwise text-less element non-empty. */
const BLOCK_CONTENT = "img, hr, pre, table, ul, ol, blockquote, .card-note, input";

/** A line the user has not written anything into yet (`<p><br></p>` counts). */
function isBlankLine(el: HTMLElement): boolean {
  if ((el.textContent ?? "").trim() !== "") return false;
  // `matches` also covers the element ITSELF: `querySelector` never matches the
  // node it is called on, so a text-less `<table>`/`<img>`/nested quote sitting
  // directly inside a quote used to look like an empty line — and the quote
  // handlers delete empty lines (a whole table could be removed by one Enter).
  return !el.matches(BLOCK_CONTENT) && !el.querySelector(BLOCK_CONTENT);
}

function caretTo(node: Node, atEnd: boolean): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** An empty paragraph the caret can land in (a bare <p> has no line box). */
function emptyParagraph(): HTMLElement {
  const p = document.createElement("p");
  p.appendChild(document.createElement("br"));
  return p;
}

/** Quote (and callout) the caret currently sits in, if any. */
function quoteAtCaret(root: HTMLElement): { quote: HTMLElement; block: HTMLElement } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : (node.parentElement as HTMLElement | null);
  if (!el || !root.contains(el)) return null;
  const quote = el.closest("blockquote");
  if (!quote || !root.contains(quote)) return null;
  const block = quotedBlock(root, quote as HTMLElement);
  return block ? { quote: quote as HTMLElement, block } : null;
}

/** 光标所在的最上层块（root 的直接子元素），且它是个空块。 */
function emptyTopLevelBlock(root: HTMLElement): HTMLElement | null {
  const block = topLevelBlock(root);
  return block && isBlankLine(block) ? block : null;
}

/**
 * Enter / Backspace handling at quote boundaries (SPEC §9.2). Returns true when
 * the key was consumed — the caller then autosaves.
 *
 * - Enter on an empty quoted line leaves the quote (a callout is left as a
 *   whole, since its title and body are one markdown unit). Content below the
 *   empty line keeps its quote as a second block, so nothing is re-flowed.
 * - Backspace on an empty quoted line removes that line; on the quote's FIRST
 *   line it removes the line and steps out of the quote (an empty quote is
 *   dropped entirely).
 * - Backspace in the empty paragraph that sits right after a quote (the shape
 *   the Enter-exit above leaves behind) deletes that paragraph.
 *
 * Every branch that used to fall through to the browser is handled here on
 * purpose: WebView2 merges across the quote boundary into markup `renderCard`
 * never emits, which is what users see as "回车再删除后错乱".
 */
export function handleQuoteExit(root: HTMLElement, e: KeyboardEvent): boolean {
  // Never interfere with IME candidates (Chinese input) or shortcuts.
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;

  if (e.key === "Backspace") {
    // 退出引用后光标停在这个空段落里；交给浏览器做原生合并 = 把段落并进引用
    // （等于把引用行又拖出来），产出 renderCard 产不出的 DOM。删掉空段落是无损的，
    // 光标回到引用末尾，用户接着退格就是正常的"删字"。
    const empty = emptyTopLevelBlock(root);
    const before = empty?.previousElementSibling as HTMLElement | null;
    if (empty && before?.tagName === "BLOCKQUOTE") {
      empty.remove();
      caretTo(before, true);
      e.preventDefault();
      return true;
    }
  }

  const hit = quoteAtCaret(root);
  if (!hit) return false;
  const { quote, block } = hit;
  if (!isBlankLine(block)) return false;

  if (e.key === "Backspace") {
    const prev = block.previousElementSibling as HTMLElement | null;
    if (prev) {
      block.remove();
      caretTo(prev, true);
      e.preventDefault();
      return true;
    }
    // 引用的第一行（空行）：同样不交给浏览器。删掉这行；引用因此空了就整块移除，
    // 光标回到引用前的块尾 —— "退到引用边界时正确脱出引用"。
    const beforeQuote = quote.previousElementSibling as HTMLElement | null;
    const callout = quote.closest(".callout");
    const inCallout = Boolean(callout && root.contains(callout));
    block.remove();
    if (inCallout) {
      // callout 的标题 + 正文是一个 markdown 单位，正文必须保持 blockquote：
      // 空行放回去，这次退格当作"没有可删的东西"。
      quote.insertBefore(block, quote.firstChild);
      caretTo(block, false);
    } else if (quote.children.length === 0) {
      const paragraph = emptyParagraph();
      quote.replaceWith(paragraph);
      caretTo(paragraph, false);
    } else if (beforeQuote) {
      caretTo(beforeQuote, true);
    } else {
      caretTo(quote, false);
    }
    e.preventDefault();
    return true;
  }

  if (e.key !== "Enter" || e.shiftKey) return false; // Shift+Enter = 软换行，留在引用内

  const callout = quote.closest(".callout");
  const after = [...quote.children].slice(
    [...quote.children].indexOf(block) + 1,
  ) as HTMLElement[];
  block.remove();

  if (callout && root.contains(callout)) {
    // The whole callout is one markdown unit: only an empty *last* line can
    // leave it, otherwise keep writing inside the callout.
    if (after.length > 0) {
      quote.appendChild(block);
      return false;
    }
    const paragraph = emptyParagraph();
    callout.after(paragraph);
    caretTo(paragraph, false);
  } else {
    const paragraph = emptyParagraph();
    quote.after(paragraph);
    if (after.length > 0) {
      const rest = document.createElement("blockquote");
      after.forEach((node) => rest.appendChild(node));
      paragraph.after(rest);
    }
    caretTo(paragraph, false);
  }
  e.preventDefault();
  return true;
}

// ------------------------------------------------------- 右键菜单的块级操作
// The context menu (2026-10-06) offers markdown block structures — quotes,
// lists, headings, hr/table/code-block inserts. All of them operate on the
// ROOT-LEVEL child the caret sits in: predictable scope, and callouts (whose
// title + body are one markdown unit) are never taken apart by accident.

const BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "table", "div", "hr"];

/** The root-level child element that contains the caret, or null. */
function topLevelBlock(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  if (!root.contains(sel.getRangeAt(0).startContainer)) return null;
  let node: Node | null = sel.getRangeAt(0).startContainer;
  if (node === root) return null;
  while (node && node.parentElement !== root) node = node.parentElement;
  return node instanceof HTMLElement ? node : null;
}

/** All root-level children intersecting the current selection (≥1 entry). */
function topLevelBlocksInRange(root: HTMLElement): HTMLElement[] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) && !root.contains(range.startContainer)) return [];
  const blocks = Array.from(root.children).filter((child) => range.intersectsNode(child)) as HTMLElement[];
  if (blocks.length > 0) return blocks;
  const one = topLevelBlock(root);
  return one ? [one] : [];
}

/** Rename the caret's root-level block (标题 submenu / 段落). Plain blocks only —
 *  callouts, quotes, lists and tables keep their markdown semantics. */
export function setBlockTag(root: HTMLElement, tagName: string): boolean {
  const block = topLevelBlock(root);
  if (!block) return false;
  const tag = block.tagName.toLowerCase();
  if (!["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) return false;
  if (tag === tagName.toLowerCase()) return false;
  const next = document.createElement(tagName);
  while (block.firstChild) next.appendChild(block.firstChild);
  block.replaceWith(next);
  caretTo(next, false);
  return true;
}

/** Toggle a blockquote around the caret's root-level block(s). Unwrapping only
 *  applies to quotes that sit directly under the root — the blockquote inside a
 *  callout is the callout's body and must survive. */
export function toggleBlockquote(root: HTMLElement): boolean {
  const blocks = topLevelBlocksInRange(root);
  if (blocks.length === 0) return false;
  if (blocks.length === 1 && blocks[0].tagName === "BLOCKQUOTE") {
    const quote = blocks[0];
    const frag = document.createDocumentFragment();
    while (quote.firstChild) frag.appendChild(quote.firstChild);
    quote.replaceWith(frag);
    return true;
  }
  const quote = document.createElement("blockquote");
  blocks[0].parentNode?.insertBefore(quote, blocks[0]);
  for (const b of blocks) quote.appendChild(b);
  caretTo(quote, false);
  return true;
}

/** Toggle / convert / unwrap the caret's root-level list (无序 / 有序 / 任务). */
export function toggleList(root: HTMLElement, kind: "ul" | "ol" | "task"): boolean {
  const blocks = topLevelBlocksInRange(root);
  if (blocks.length === 0) return false;
  const first = blocks[0];
  const tag = first.tagName.toLowerCase();

  if (tag === "ul" || tag === "ol") {
    const boxes = first.querySelectorAll("li input[type=checkbox]");
    const isTask = boxes.length > 0;
    const wantsTask = kind === "task";
    const sameContainer = kind === "ol" ? tag === "ol" : tag === "ul";
    if (!wantsTask && sameContainer && !isTask) {
      // Toggle off: lift every li's content out as plain blocks.
      const frag = document.createDocumentFragment();
      for (const li of Array.from(first.children)) {
        if (!(li instanceof HTMLLIElement)) continue;
        const hasBlockChild = Array.from(li.children).some((c) =>
          BLOCK_TAGS.includes(c.tagName.toLowerCase()),
        );
        if (hasBlockChild) {
          while (li.firstChild) frag.appendChild(li.firstChild);
        } else {
          const p = document.createElement("p");
          while (li.firstChild) p.appendChild(li.firstChild);
          frag.appendChild(p);
        }
      }
      first.replaceWith(frag);
      return true;
    }
    if (wantsTask && isTask) {
      // 任务开关关：去掉勾选框，容器类型保留（ol 仍是 1. 2. 3.）。
      boxes.forEach((box) => box.remove());
      first
        .querySelectorAll("li.task-list-item")
        .forEach((li) => li.classList.remove("task-list-item"));
      return true;
    }
    if (wantsTask) {
      // 任务化：checkbox 加进现有容器（有序列表保留 1. 2. 3. 的编号）。
      first.querySelectorAll("li").forEach((li) => {
        li.classList.add("task-list-item");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.disabled = true;
        li.prepend(box);
      });
      return true;
    }
    // Different list kind: rename the container (checkboxes survive 1. [ ] x).
    const renamed = document.createElement(kind === "ol" ? "ol" : "ul");
    while (first.firstChild) renamed.appendChild(first.firstChild);
    first.replaceWith(renamed);
    return true;
  }

  // Wrap the selected root-level blocks as one list. The list goes in BEFORE
  // the blocks are emptied/removed — blocks[0] is the insertion anchor and a
  // detached anchor makes insertBefore a silent no-op.
  const list = document.createElement(kind === "ol" ? "ol" : "ul");
  blocks[0].parentNode?.insertBefore(list, blocks[0]);
  for (const b of blocks) {
    const li = document.createElement("li");
    if (kind === "task") {
      li.className = "task-list-item";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = true;
      li.appendChild(box);
    }
    while (b.firstChild) li.appendChild(b.firstChild);
    list.appendChild(li);
    b.remove();
  }
  caretTo(list, false);
  return true;
}

/** Put the caret into a typable spot right after `el` (next block, or a new
 *  empty paragraph when the insert lands at the very end). */
function caretAfterInsert(el: HTMLElement, focus?: HTMLElement): void {
  if (focus) {
    caretTo(focus, false);
    return;
  }
  const next = el.nextElementSibling;
  if (next && BLOCK_TAGS.includes(next.tagName.toLowerCase()) && next.tagName !== "HR") {
    caretTo(next, false);
    return;
  }
  const p = emptyParagraph();
  el.after(p);
  caretTo(p, false);
}

/** ⌗ 水平分割线：`---` after the caret's block. */
export function insertHr(root: HTMLElement): boolean {
  const block = topLevelBlock(root);
  if (!block) return false;
  const hr = document.createElement("hr");
  block.after(hr);
  caretAfterInsert(hr);
  return true;
}

/** ⊞ 表格：3 列 × 2 行的 GFM 起始模板（turndown-plugin-gfm 负责存回）。 */
export function insertTable(root: HTMLElement): boolean {
  const block = topLevelBlock(root);
  if (!block) return false;
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of ["列 1", "列 2", "列 3"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  }
  const body = table.createTBody();
  const row = body.insertRow();
  for (let i = 0; i < 3; i++) row.insertCell();
  block.after(table);
  const firstCell = table.querySelector("td");
  caretAfterInsert(table, firstCell ?? undefined);
  return true;
}

/** `<>` 代码块：空 fenced block，光标落在代码里。先放一个 <br> 占位——
 *  turndown 把「完全空白的节点」直接丢给 blank 规则，空 pre 会在保存时消失。 */
export function insertCodeBlock(root: HTMLElement): boolean {
  const block = topLevelBlock(root);
  if (!block) return false;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.appendChild(document.createElement("br"));
  pre.appendChild(code);
  block.after(pre);
  caretAfterInsert(pre, code);
  return true;
}
