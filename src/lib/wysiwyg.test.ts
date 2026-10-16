// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { registerMockAttachment } from "./attachments";
import { renderCard } from "./markdown";
import {
  createUndoStack,
  handleQuoteExit,
  htmlToMarkdown,
  insertCodeBlock,
  insertHr,
  insertNoteBlock,
  insertTable,
  pasteStructured,
  setBlockTag,
  toggleBlockquote,
  toggleList,
  wrapSelection,
} from "./wysiwyg";

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

  it("keeps Obsidian callouts through a save round-trip", () => {
    const md = "> [!note] 傻瓜讲解\n> 可以把事务想象成一次银行转账。";
    const out = roundTrip(md);
    expect(out).toContain("> [!note] 傻瓜讲解");
    expect(out).toContain("> 可以把事务想象成一次银行转账。");
    expect(out).not.toContain("📘");
  });

  it("keeps multi-paragraph callouts (title line alone)", () => {
    const md = "> [!NOTE] ✏️ 面试回答\n>\n> **要点**：内容";
    const out = roundTrip(md);
    expect(out).toContain("> [!note] ✏️ 面试回答");
    expect(out).toContain("> **要点**：内容");
  });

  it("keeps adjacent callouts separate (user's card layout)", () => {
    const md = "> [!note] 傻瓜讲解\n> 正文一\n\n> [!NOTE] 面试回答\n>\n> **正文二**";
    const out = roundTrip(md);
    expect((out.match(/> \[!note\]/g) ?? []).length).toBe(2);
    expect(out).toContain("> [!note] 傻瓜讲解");
    expect(out).toContain("> [!note] 面试回答");
    expect(out).toContain("> **正文二**");
  });

  it("keeps GFM task lists", () => {
    const out = roundTrip("- [x] 已完成的事\n- [ ] 还没做的事");
    expect(out).toContain("- [x] 已完成的事");
    expect(out).toContain("- [ ] 还没做的事");
  });

  it("keeps footnotes: refs and definitions round-trip", () => {
    const md = "B+ 树是[^1]常见索引。\n\n[^1]: 一种平衡多路搜索树。";
    const out = roundTrip(md);
    expect(out).toContain("[^1]");
    expect(out).toContain("[^1]: 一种平衡多路搜索树。");
  });

  // SPEC §5.4: an autosave must never rewrite (or drop) an image reference.
  it("keeps an attachment image ref byte-for-byte", () => {
    registerMockAttachment("abc.png", "data:image/png;base64,AAAA");
    expect(roundTrip("![图](attachment:abc.png)")).toBe("![图](attachment:abc.png)");
  });

  it("keeps the ref of a missing image (normalizing only the brackets)", () => {
    const out = roundTrip("![缺图](<images/nope.png>)");
    expect(out).toBe("![缺图](images/nope.png)");
  });

  it("keeps a spaced path loadable (markdown-it percent-encodes it)", () => {
    // `(<images/my note.png>)` comes back as a percent-encoded destination —
    // still the same file, and the importer decodes %20 again.
    expect(roundTrip("![缺图](<images/my note.png>)")).toBe("![缺图](images/my%20note.png)");
  });

  it("keeps a blocked remote image ref", () => {
    const md = "![远程](https://example.com/a.png)";
    expect(roundTrip(md)).toBe(md);
  });

  it("keeps images inside surrounding text", () => {
    const md = "先看图：\n\n![图](attachment:abc.png)\n\n再看结论。";
    const out = roundTrip(md);
    expect(out).toContain("![图](attachment:abc.png)");
    expect(out).toContain("先看图：");
    expect(out).toContain("再看结论。");
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

describe("handleQuoteExit (引用块里按回车出不去 — 2026-10-05 用户反馈)", () => {
  function buildEditor(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }
  /** Put a collapsed caret at `offset` inside `node`. */
  function caretIn(node: Node, offset = 0) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const press = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });

  it("leaves the quote when Enter is pressed on the empty line inside it", () => {
    // Exactly the DOM WebView2 leaves behind after one Enter at the end.
    const root = buildEditor(
      "<blockquote><p>这是一段引用</p><p><br></p></blockquote>",
    );
    const empty = root.querySelectorAll("blockquote p")[1];
    caretIn(empty, 0);
    const e = press("Enter");
    expect(handleQuoteExit(root, e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);

    const quote = root.querySelector("blockquote")!;
    expect(quote.textContent).toBe("这是一段引用");
    expect(quote.querySelector("p + p")).toBeNull();
    const next = quote.nextElementSibling as HTMLElement;
    expect(next.tagName).toBe("P");
    expect(next.previousElementSibling).toBe(quote);
    // The caret sits in the new paragraph, so typing continues outside.
    expect(window.getSelection()!.anchorNode).toBe(next);
  });

  it("does not touch Enter on a line that has content", () => {
    const root = buildEditor("<blockquote><p>引用</p></blockquote>");
    caretIn(root.querySelector("blockquote p")!.firstChild!, 2);
    const e = press("Enter");
    expect(handleQuoteExit(root, e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(root.querySelector("blockquote")!.textContent).toBe("引用");
  });

  it("leaves the quote with content below the empty line intact", () => {
    const root = buildEditor(
      "<blockquote><p>上面</p><p><br></p><p>下面</p></blockquote>",
    );
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    expect(handleQuoteExit(root, press("Enter"))).toBe(true);
    const [first, paragraph, second] = [...root.children] as HTMLElement[];
    expect(first.tagName).toBe("BLOCKQUOTE");
    expect(first.textContent).toBe("上面");
    expect(paragraph.tagName).toBe("P");
    expect(second.tagName).toBe("BLOCKQUOTE");
    expect(second.textContent).toBe("下面");
  });

  it("leaves the whole callout, since title and body are one markdown unit", () => {
    const root = buildEditor(
      '<div class="callout callout-note"><p class="callout-title">笔记</p>' +
        "<blockquote><p>正文</p><p><br></p></blockquote></div>",
    );
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    expect(handleQuoteExit(root, press("Enter"))).toBe(true);
    const callout = root.querySelector(".callout")!;
    expect(callout.querySelector("blockquote")!.textContent).toBe("正文");
    expect(root.lastElementChild!.tagName).toBe("P");
    expect(root.lastElementChild!.previousElementSibling).toBe(callout);
  });

  it("keeps writing inside a callout when the empty line is not the last", () => {
    const root = buildEditor(
      '<div class="callout callout-note"><p class="callout-title">笔记</p>' +
        "<blockquote><p><br></p><p>后半</p></blockquote></div>",
    );
    caretIn(root.querySelectorAll("blockquote p")[0], 0);
    const e = press("Enter");
    expect(handleQuoteExit(root, e)).toBe(false);
    expect(root.querySelector(".callout blockquote")!.textContent).toContain("后半");
  });

  it("ignores Shift+Enter (soft break) and IME composition", () => {
    const root = buildEditor("<blockquote><p><br></p></blockquote>");
    caretIn(root.querySelector("blockquote p")!, 0);
    expect(handleQuoteExit(root, press("Enter", { shiftKey: true }))).toBe(false);
    const ime = press("Enter");
    Object.defineProperty(ime, "isComposing", { value: true });
    expect(handleQuoteExit(root, ime)).toBe(false);
    expect(root.querySelector("blockquote")).toBeTruthy();
  });

  it("removes an empty quoted line on Backspace", () => {
    const root = buildEditor("<blockquote><p>引用</p><p><br></p></blockquote>");
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    const e = press("Backspace");
    expect(handleQuoteExit(root, e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    const quote = root.querySelector("blockquote")!;
    expect(quote.children).toHaveLength(1);
    expect(quote.textContent).toBe("引用");
    // Caret sits at the end of the previous line, ready to keep deleting.
    const sel = window.getSelection()!;
    const node = sel.anchorNode!;
    const atLineEnd =
      node === quote.firstElementChild
        ? sel.anchorOffset === node.childNodes.length
        : node.nodeType === Node.TEXT_NODE &&
          sel.anchorOffset === (node.textContent ?? "").length;
    expect(atLineEnd).toBe(true);
  });

  it("saves the exit as a normal paragraph after the quote", () => {
    const root = buildEditor("<blockquote><p>引用</p><p><br></p></blockquote>");
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    handleQuoteExit(root, press("Enter"));
    // What the user types next lands outside the quote.
    const paragraph = root.querySelectorAll(":scope > p")[0];
    paragraph.textContent = "普通段落";
    const md = htmlToMarkdown(root.innerHTML);
    expect(md).toContain("> 引用");
    expect(md).toContain("普通段落");
    expect(md).not.toMatch(/>\s*\n\s*\n> *$/);
  });

  it("leaves no whitespace-only line when the new paragraph stays empty", () => {
    const root = buildEditor("<blockquote><p>引用</p><p><br></p></blockquote>");
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    handleQuoteExit(root, press("Enter"));
    const md = htmlToMarkdown(root.innerHTML);
    expect(md).toBe("> 引用");
  });
});

// ------------------------------------------------- 右键菜单的块级操作（2026-10-06）
describe("context-menu block ops", () => {
  function editorWith(md: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = renderCard(md);
    document.body.appendChild(root);
    return root;
  }

  it("renames a paragraph to a heading and back (标题/段落)", () => {
    const root = editorWith("普通段落");
    selectContents(root.querySelector("p")!);
    expect(setBlockTag(root, "h2")).toBe(true);
    expect(root.querySelector("h2")?.textContent).toBe("普通段落");
    expect(htmlToMarkdown(root.innerHTML)).toContain("## 普通段落");
    selectContents(root.querySelector("h2")!);
    expect(setBlockTag(root, "p")).toBe(true);
    expect(root.querySelector("p")).not.toBeNull();
    root.remove();
  });

  it("refuses to rename callouts, quotes and lists", () => {
    const root = editorWith("> [!note] 标题\n> 正文一行");
    selectContents(root.querySelector(".callout")!);
    expect(setBlockTag(root, "h1")).toBe(false);
    root.remove();
  });

  it("wraps and unwraps a blockquote", () => {
    const root = editorWith("被引用的句子");
    selectContents(root.querySelector("p")!);
    expect(toggleBlockquote(root)).toBe(true);
    expect(root.querySelector("blockquote")).not.toBeNull();
    expect(htmlToMarkdown(root.innerHTML)).toContain("> 被引用的句子");
    selectContents(root.querySelector("blockquote p")!);
    expect(toggleBlockquote(root)).toBe(true);
    expect(root.querySelector("blockquote")).toBeNull();
    root.remove();
  });

  it("wraps two paragraphs into one bullet list and unwraps it", () => {
    const root = editorWith("第一条\n\n第二条");
    selectContents(root);
    expect(toggleList(root, "ul")).toBe(true);
    expect(root.querySelectorAll("li").length).toBe(2);
    const md = htmlToMarkdown(root.innerHTML);
    expect(md).toContain("- 第一条");
    expect(md).toContain("- 第二条");
    selectContents(root.querySelector("ul")!);
    expect(toggleList(root, "ul")).toBe(true);
    expect(root.querySelector("ul")).toBeNull();
    expect(root.querySelectorAll("p").length).toBe(2);
    root.remove();
  });

  it("converts between list kinds and inserts a task checkbox", () => {
    const root = editorWith("复习 B 树");
    selectContents(root.querySelector("p")!);
    expect(toggleList(root, "ol")).toBe(true);
    expect(root.querySelector("ol li")).not.toBeNull();
    selectContents(root.querySelector("ol")!);
    expect(toggleList(root, "task")).toBe(true);
    expect(root.querySelector("li input[type=checkbox]")).not.toBeNull();
    expect(htmlToMarkdown(root.innerHTML)).toContain("1. [ ] 复习 B 树");
    selectContents(root.querySelector("ol")!);
    expect(toggleList(root, "task")).toBe(true);
    expect(root.querySelector("li input[type=checkbox]")).toBeNull();
    expect(root.querySelector("ol")).not.toBeNull();
    expect(htmlToMarkdown(root.innerHTML)).toContain("1. 复习 B 树");
    root.remove();
  });

  it("inserts hr, table and a fenced code block after the caret block", () => {
    const root = editorWith("开头");
    selectContents(root.querySelector("p")!);
    expect(insertHr(root)).toBe(true);
    expect(root.querySelector("hr")).not.toBeNull();
    expect(insertTable(root)).toBe(true);
    expect(root.querySelector("table")).not.toBeNull();
    expect(insertCodeBlock(root)).toBe(true);
    expect(root.querySelector("pre code")).not.toBeNull();
    const md = htmlToMarkdown(root.innerHTML);
    expect(md).toMatch(/\*\*\*|---/);
    expect(md).toContain("| 列 1 | 列 2 | 列 3 |");
    expect(md).toContain("```");
    root.remove();
  });
});

// Bug2（t12）：编辑命令可能留下零行 <table>，turndown 的 gfm 表格规则读
// `node.rows[0]` 会抛 TypeError，进而让整个自动保存 reject（改动静默丢失）。
describe("htmlToMarkdown 对零行表格的防护（Bug2 / t12）", () => {
  it("不再抛出，且其余内容照常写回", () => {
    expect(() => htmlToMarkdown("<p>x</p><table></table><p>y</p>")).not.toThrow();
    expect(htmlToMarkdown("<p>x</p><table></table><p>y</p>")).toBe("x\n\ny");
  });

  it("空 tbody、blockquote 内的零行表格同样不再抛出", () => {
    expect(htmlToMarkdown("<table><tbody></tbody></table>")).toBe("");
    expect(htmlToMarkdown("<blockquote><table></table></blockquote>")).toBe("");
  });

  it("嵌套的零行表格也覆盖（querySelectorAll 会遍历到）", () => {
    const html =
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><table></table></td></tr></tbody></table>';
    expect(() => htmlToMarkdown(html)).not.toThrow();
    expect(htmlToMarkdown(html)).toBe("| a |\n| --- |\n|  |");
  });

  it("零行表格的 caption 是真实文本：提成段落保留，不随表格一起丢", () => {
    expect(htmlToMarkdown("<table><caption>表 1 说明</caption></table>")).toBe("表 1 说明");
  });

  // 锁定断言（Coder-Editor 复审要求）：没有零行表格时，预处理必须原样放行，
  // 输出与引入防护之前逐字节一致——否则所有卡面的保存内容会静默变化。
  it("没有零行表格时输出逐字节不变", () => {
    expect(htmlToMarkdown("<p>普通段落</p><p><strong>粗</strong>与 <mark>高亮</mark></p>")).toBe(
      "普通段落\n\n**粗**与 ==高亮==",
    );
    expect(
      htmlToMarkdown(
        "<ul><li>甲</li><li>乙</li></ul><pre><code class=\"language-sql\">SELECT 1;\n</code></pre>",
      ),
    ).toBe("- 甲\n- 乙\n\n```sql\nSELECT 1;\n```");
    expect(
      htmlToMarkdown(
        "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      ),
    ).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(
      htmlToMarkdown("<blockquote><p>引用</p></blockquote><div class=\"card-note\"><span class=\"card-note-icon\">📝</span>备注</div>"),
    ).toBe("> 引用\n\n%%备注%%");
  });
});

// ---------------------------------------- Bug6（t10）：引用内回车再删除 / 往返幂等
// 用户报告"引用里回车再删除后渲染错乱"。根因有两条：
//   ① htmlToMarkdown 不是不动点：'引用 + 空段 + 引用' 首次存出 3 个空行，第二次才收敛，
//      引用末尾的 `<p><br></p>` 写出一个不可见的空引用行 `>`；
//   ② 两条退格路径完全没被拦截，交给浏览器原生合并（把引用与相邻块揉在一起）。
describe("Bug6：引用块回车再删除（t10）", () => {
  function build(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }
  function caretIn(node: Node, offset = 0) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const press = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });

  it("DOM→MD 是不动点：'引用 + 空段 + 引用' 第一次保存就收敛", () => {
    const dom =
      "<blockquote><p>上面</p></blockquote><p><br></p><blockquote><p>下面</p></blockquote>";
    const first = htmlToMarkdown(dom);
    expect(first, "第一次保存就要是收敛后的形状").toBe("> 上面\n\n> 下面");
    expect(first).not.toMatch(/\n{3,}/);
    expect(htmlToMarkdown(renderCard(first))).toBe(first);
  });

  it("尾随内容也不漂：'引用 + 空段 + 引用 + 段落' 一次收敛", () => {
    const dom =
      "<blockquote><p>上面</p></blockquote><p><br></p><blockquote><p>下面</p></blockquote><p>尾巴</p>";
    const first = htmlToMarkdown(dom);
    expect(first).toBe("> 上面\n\n> 下面\n\n尾巴");
    expect(htmlToMarkdown(renderCard(first))).toBe(first);
  });

  it("引用末尾的空行不再被写成不可见空块", () => {
    // 引用末尾按回车后浏览器留下的形状（<p><br></p> 或 <div><br></div>）。
    for (const dom of [
      "<blockquote><p>引用</p><p><br></p></blockquote>",
      "<blockquote><p>引用</p><div><br></div></blockquote>",
      "<blockquote><p>引用</p><p><br></p></blockquote><p>尾巴</p>",
    ]) {
      const md = htmlToMarkdown(dom);
      expect(md, `不该留下空引用行：${dom}`).not.toMatch(/^> *$/m);
      expect(htmlToMarkdown(renderCard(md))).toBe(md);
    }
  });

  it("引用中间的空引用行保留（它分隔两段引用）", () => {
    const md = "> a\n> \n> b";
    expect(roundTrip(md)).toBe(md);
  });

  it("嵌套引用：往返幂等，两层结构都在", () => {
    const first = roundTrip("> 外\n> > 内");
    expect(htmlToMarkdown(renderCard(first))).toBe(first);
    expect((renderCard(first).match(/<blockquote>/g) ?? []).length).toBe(2);
  });

  it("列表套引用：往返是恒等（不再把列表填充空格写回卡片）", () => {
    expect(roundTrip("> - a\n> - b")).toBe("> - a\n> - b");
    expect(roundTrip("> 1. 甲\n> 2. 乙")).toBe("> 1. 甲\n> 2. 乙");
  });

  it("引用内代码块：往返恒等，且围栏里的空行不被合并掉", () => {
    const quoted = "> ```js\n> const a = 1;\n> ```";
    expect(roundTrip(quoted)).toBe(quoted);
    // 围栏内的空行是内容，不能被"折叠空行"误伤。
    expect(roundTrip("```\na\n\nb\n```")).toBe("```\na\n\nb\n```");
  });

  it("回车退出引用后在空段落里按退格：不交给浏览器原生合并", () => {
    const root = build("<blockquote><p>上面</p><p><br></p><p>下面</p></blockquote>");
    caretIn(root.querySelectorAll("blockquote p")[1], 0);
    expect(handleQuoteExit(root, press("Enter"))).toBe(true);
    // handleQuoteExit 的产物：quote + 空段 + quote
    const empty = root.querySelectorAll(":scope > p")[0] as HTMLElement;
    expect(empty.innerHTML).toBe("<br>");

    caretIn(empty, 0);
    const e = press("Backspace");
    expect(handleQuoteExit(root, e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);

    const [q1, q2] = [...root.children] as HTMLElement[];
    expect(root.querySelectorAll(":scope > p")).toHaveLength(0);
    expect(q1.tagName).toBe("BLOCKQUOTE");
    expect(q1.textContent).toBe("上面");
    expect(q2.tagName).toBe("BLOCKQUOTE");
    expect(q2.textContent).toBe("下面");
    expect(htmlToMarkdown(root.innerHTML)).toBe("> 上面\n\n> 下面");
  });

  it("引用第一行是空行时按退格：删掉它并整块脱出引用", () => {
    const root = build("<p>前面</p><blockquote><p><br></p></blockquote>");
    caretIn(root.querySelector("blockquote p")!, 0);
    const e = press("Backspace");
    expect(handleQuoteExit(root, e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelector("blockquote"), "空引用应被整块移除").toBeNull();
    expect(root.textContent).toBe("前面");
    expect(htmlToMarkdown(root.innerHTML)).toBe("前面");
  });

  it("引用里还有别的行时：第一行空行退格后引用保留、光标脱出到前一块末尾", () => {
    const root = build("<p>前面</p><blockquote><p><br></p><p>引用正文</p></blockquote>");
    caretIn(root.querySelector("blockquote p")!, 0);
    const e = press("Backspace");
    expect(handleQuoteExit(root, e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelector("blockquote")!.textContent).toBe("引用正文");
    expect(htmlToMarkdown(root.innerHTML)).toBe("前面\n\n> 引用正文");
  });

  it("文本为空但有结构的块（表格）不算空行：引用内按回车不能把它删掉", () => {
    const root = build(
      "<blockquote><table><tbody><tr><td></td></tr></tbody></table></blockquote>",
    );
    caretIn(root.querySelector("td")!, 0);
    // isBlankLine 用 querySelector 判断，匹配不到元素自身 —— 空文本的表格曾被
    // 当成"空行"整块删掉（数据丢失）。表格是内容，这里必须不拦、更不能删。
    expect(handleQuoteExit(root, press("Enter"))).toBe(false);
    expect(root.querySelector("table")).toBeTruthy();
  });
});


// ---------------------------------------------------------------- 撤销/重做
// 2026-10-07 用户反馈：批注动作是直接 DOM 手术，浏览器原生撤销栈靠不住。
// 这里锁自定义快照栈的核心语义：动作可退、打字合并、undo 后接着打字不吞历史。
describe("createUndoStack (editor undo history)", () => {
  function editorWith(html: string): HTMLDivElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it("action push/undo/redo restores the exact snapshot", () => {
    const el = editorWith("<p>第一段</p>");
    const stack = createUndoStack(() => el);
    stack.reset();
    el.innerHTML = "<p>第一段</p><p>第二段</p>";
    stack.push();
    expect(el.innerHTML).toContain("第二段");
    expect(stack.undo()).toBe(true);
    expect(el.innerHTML).not.toContain("第二段");
    expect(stack.redo()).toBe(true);
    expect(el.innerHTML).toContain("第二段");
    el.remove();
  });

  it("undo at the baseline is a no-op (nothing to revert)", () => {
    const el = editorWith("<p>a</p>");
    const stack = createUndoStack(() => el);
    stack.reset();
    expect(stack.undo()).toBe(false);
    el.remove();
  });

  it("typing bursts coalesce, but an undo'ed state is never overwritten", async () => {
    const el = editorWith("<p>a</p>");
    const stack = createUndoStack(() => el);
    stack.reset();
    // 连续打字：600ms 内的 typing push 合并成一步。
    el.innerHTML = "<p>ab</p>";
    stack.push("typing");
    el.innerHTML = "<p>abc</p>";
    stack.push("typing");
    expect(stack.undo()).toBe(true);
    expect(el.innerHTML).toBe("<p>a</p>");
    // 撤销后立刻打字：恢复出来的状态必须留在历史里（不被下一个字覆盖）。
    el.innerHTML = "<p>ax</p>";
    stack.push("typing");
    expect(stack.undo()).toBe(true);
    expect(el.innerHTML).toBe("<p>a</p>");
    expect(stack.redo()).toBe(true);
    expect(el.innerHTML).toBe("<p>ax</p>");
    el.remove();
  });

  it("action pushes never coalesce (a Ctrl+Z right after surgery reverts it)", () => {
    const el = editorWith("<p>a</p>");
    const stack = createUndoStack(() => el);
    stack.reset();
    el.innerHTML = "<p>a</p>";
    stack.push("typing");
    el.innerHTML = "<p><strong>a</strong></p>";
    stack.push("action"); // 批注动作：立即独立成步
    expect(stack.undo()).toBe(true);
    expect(el.innerHTML).toBe("<p>a</p>");
    el.remove();
  });

  it("a new push after an undo drops the redo tail", () => {
    const el = editorWith("<p>1</p>");
    const stack = createUndoStack(() => el);
    stack.reset();
    el.innerHTML = "<p>2</p>";
    stack.push();
    stack.undo();
    el.innerHTML = "<p>3</p>";
    stack.push();
    expect(stack.redo()).toBe(false); // redo 分支应被截断
    expect(stack.undo()).toBe(true);
    expect(el.innerHTML).toBe("<p>1</p>");
    el.remove();
  });
});

// ------------------------------------------------------------------- 粘贴
// 2026-10-07 用户反馈：外部粘贴的字体/段落格式和原始内容不一样 —— 现在粘贴
// 统一走 markdown 归一化再落进卡面（外部字体/颜色根本不进 DOM）。
describe("pasteStructured (clipboard normalization)", () => {
  function pasteEvent(payload: { html?: string; text?: string }): ClipboardEvent {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text/html" ? (payload.html ?? "") : (payload.text ?? ""),
      },
    });
    return event;
  }

  it("normalizes rich HTML through markdown (external styles stripped)", () => {
    const el = editorWith2("<p>前</p>");
    selectContents2(el.querySelector("p")!);
    const handled = pasteStructured(
      el,
      pasteEvent({ html: '<span style="font-family:Comic Sans;font-size:30px">加粗<b>重点</b></span>' }),
    );
    expect(handled).toBe(true);
    const md = htmlToMarkdown(el.innerHTML);
    expect(md).toContain("**重点**");
    expect(md).not.toContain("Comic Sans");
    el.remove();
  });

  it("keeps paragraphs from the source", () => {
    const el = editorWith2("<p>开头</p>");
    selectContents2(el);
    pasteStructured(
      el,
      pasteEvent({ html: "<p>第一段</p><p>第二段</p>" }),
    );
    const md = htmlToMarkdown(el.innerHTML);
    expect(md).toContain("第一段");
    expect(md).toContain("第二段");
    expect(htmlToMarkdown(el.innerHTML).split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(2);
    el.remove();
  });

  it("inserts plain text with line breaks when there is no HTML flavor", () => {
    const el = editorWith2("<p>前</p>");
    selectContents2(el);
    const handled = pasteStructured(el, pasteEvent({ text: "一行\n二行" }));
    expect(handled).toBe(true);
    expect(el.innerHTML).toContain("一行");
    expect(el.innerHTML).toContain("<br>");
    el.remove();
  });

  it("lets the browser paste when the clipboard is empty for us", () => {
    const el = editorWith2("<p>前</p>");
    const handled = pasteStructured(el, pasteEvent({}));
    expect(handled).toBe(false);
    el.remove();
  });
});

function editorWith2(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function selectContents2(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}
