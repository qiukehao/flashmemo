import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

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

  return td;
}

const turndown = makeTurndown();

/** Convert the edited card DOM back into card markdown. */
export function htmlToMarkdown(html: string): string {
  return (
    turndown
      .turndown(html)
      // Turndown pads list markers for alignment; collapse it so repeated
      // saves don't churn the stored markdown.
      .replace(/^(\s*)([-*+]) {2,}/gm, "$1$2 ")
      .replace(/^(\s*\d+\.) {2,}/gm, "$1 ")
      .trim()
  );
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
  const containerParent =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : (range.commonAncestorContainer.parentElement as HTMLElement | null);
  const existing = containerParent?.closest(tag);
  if (existing && root.contains(existing)) {
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
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;

  const note = document.createElement("div");
  note.className = "card-note";
  const icon = document.createElement("span");
  icon.className = "card-note-icon";
  icon.textContent = "📝";
  note.appendChild(icon);
  const textNode = document.createTextNode("");
  note.appendChild(textNode);

  // Place it right after the block the caret is in (top-level child of root).
  let block: Node = range.startContainer;
  while (block.parentNode && block.parentNode !== root) block = block.parentNode;
  block.parentNode?.insertBefore(note, block.nextSibling);

  const caret = document.createRange();
  caret.setStart(textNode, 0);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  return true;
}
