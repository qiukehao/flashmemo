import { describe, expect, it } from "vitest";
import { renderCard } from "./markdown";

describe("renderCard", () => {
  it("renders lists, bold and tables", () => {
    const html = renderCard("- **原子性**：不可分割\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<strong>原子性</strong>");
    expect(html).toContain("<table>");
  });

  it("renders ==highlight== via markdown-it-mark", () => {
    expect(renderCard("这是 ==重点== 内容")).toContain("<mark>重点</mark>");
  });

  it("renders %%remark%% as the card-note block (SPEC §9.1)", () => {
    const html = renderCard("正文 %%这里是我的备注%% 结尾");
    expect(html).toContain('class="card-note"');
    expect(html).toContain("📝");
    expect(html).toContain("这里是我的备注");
    expect(html).not.toContain("%%");
  });

  it("renders markdown inside a remark", () => {
    const html = renderCard("%%注意 **这个词**%%");
    expect(html).toContain('class="card-note"');
    expect(html).toContain("<strong>这个词</strong>");
  });

  it("leaves a lone %% untouched", () => {
    expect(renderCard("折扣 50% 起")).toContain("50%");
  });

  it("syntax-highlights fenced code blocks", () => {
    const html = renderCard("```js\nconst a = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("hljs-keyword");
  });

  it("renders Obsidian callouts with icon, title and body", () => {
    const html = renderCard("> [!note] 傻瓜讲解\n> 可以把事务想象成一次银行转账。");
    expect(html).toContain('class="callout callout-note"');
    expect(html).toContain("📘");
    expect(html).toContain("傻瓜讲解");
    expect(html).toContain("可以把事务想象成一次银行转账。");
    expect(html).not.toContain("[!note]");
  });

  it("handles uppercase markers and marker-only first lines", () => {
    const html = renderCard("> [!NOTE] ✏️ 面试回答\n>\n> **要点**：内容");
    expect(html).toContain("callout-note");
    expect(html).toContain("✏️ 面试回答");
    expect(html).toContain("<strong>要点</strong>");
    expect(html).not.toContain("[!NOTE]");
  });

  it("uses a default title when the marker has none", () => {
    const html = renderCard("> [!warning]\n> 注意这里");
    expect(html).toContain("callout-warning");
    expect(html).toContain("注意");
  });

  it("leaves plain blockquotes untouched", () => {
    const html = renderCard("> 普通引用");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
  });

  it("renders adjacent callouts as siblings, not nested", () => {
    const html = renderCard(
      "> [!note] 傻瓜讲解\n> 正文一\n\n> [!NOTE] 面试回答\n>\n> 正文二",
    );
    expect(html.match(/class="callout /g)?.length).toBe(2);
    // Two sibling divs: the rendered HTML must close the first before the second opens.
    const firstClose = html.indexOf("</div>");
    const secondOpen = html.indexOf('class="callout callout-note"', firstClose);
    expect(secondOpen).toBeGreaterThan(firstClose);
    expect(html).not.toContain("<div class=\"callout callout-note\"><div class=\"callout callout-note\">");
  });

  it("escapes raw html for safety", () => {
    const html = renderCard('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
