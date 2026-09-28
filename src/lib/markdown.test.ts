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

  it("escapes raw html for safety", () => {
    const html = renderCard('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
