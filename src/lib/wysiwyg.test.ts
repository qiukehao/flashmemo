// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderCard } from "./markdown";
import { htmlToMarkdown, insertNoteBlock, wrapSelection } from "./wysiwyg";

/** render → edit-free conversion must reproduce the original markdown. */
function roundTrip(md: string): string {
  return htmlToMarkdown(renderCard(md));
}

function selectContents(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("htmlToMarkdown (WYSIWYG save path)", () => {
  it("keeps paragraphs, lists and bold", () => {
    const md = "- **原子性**：不可分割\n- 一致性：一致状态";
    expect(roundTrip(md)).toBe(md);
  });

  it("keeps ==highlight==", () => {
    expect(roundTrip("这是 ==重点== 内容")).toBe("这是 ==重点== 内容");
  });

  it("keeps %%remark%% as a note block", () => {
    const out = roundTrip("正文 %%这里是我的备注%%");
    expect(out).toContain("%%这里是我的备注%%");
    expect(out).not.toContain("📝");
  });

  it("keeps fenced code with its language", () => {
    const out = roundTrip("```js\nconst a = 1;\n```");
    expect(out).toContain("```js");
    expect(out).toContain("const a = 1;");
  });

  it("keeps tables", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = roundTrip(md);
    expect(out).toContain("| a | b |");
    expect(out).toContain("| 1 | 2 |");
  });

  it("keeps inline code and headings", () => {
    expect(roundTrip("用 `EXPLAIN` 分析")).toBe("用 `EXPLAIN` 分析");
    expect(roundTrip("#### 子标题")).toBe("#### 子标题");
  });
});

describe("wrapSelection / insertNoteBlock (editor DOM)", () => {
  function buildEditor(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it("wraps and unwraps a highlight without touching the root", () => {
    const root = buildEditor("<p>这句话很重要</p>");
    const p = root.querySelector("p")!;
    selectContents(p);
    expect(wrapSelection(root, "mark")).toBe(true);
    expect(root.querySelector("mark")?.textContent).toBe("这句话很重要");
    selectContents(root.querySelector("mark")!);
    expect(wrapSelection(root, "mark")).toBe(true);
    expect(root.querySelector("mark")).toBeNull();
    expect(root.isConnected).toBe(true);
    expect(root.textContent).toBe("这句话很重要");
  });

  it("note toggle never destroys the editor root (regression)", () => {
    const root = buildEditor("<p>正文内容</p>");
    selectContents(root.querySelector("p")!);
    expect(wrapSelection(root, "div", "card-note")).toBe(true);
    expect(root.querySelector(".card-note")).toBeTruthy();

    // Selecting the note and toggling must unwrap the NOTE, not the editor.
    selectContents(root.querySelector(".card-note")!);
    expect(wrapSelection(root, "div", "card-note")).toBe(true);
    expect(root.querySelector(".card-note")).toBeNull();
    expect(root.isConnected).toBe(true);
    expect(root.textContent).toBe("正文内容");
    // The 📝 icon must not leak into the text.
    expect(root.textContent).not.toContain("📝");
  });

  it("inserts an empty note inside an empty editor (regression)", () => {
    const root = buildEditor("");
    selectContents(root);
    expect(insertNoteBlock(root)).toBe(true);
    expect(root.querySelector(".card-note")).toBeTruthy();
    expect(root.isConnected).toBe(true);
    // Empty note blocks are dropped on save rather than stored as stray %%%%.
    expect(htmlToMarkdown(root.innerHTML)).toBe("");
  });
});
