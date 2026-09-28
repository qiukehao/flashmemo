// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderCard } from "./markdown";
import { htmlToMarkdown } from "./wysiwyg";

/** render → edit-free conversion must reproduce the original markdown. */
function roundTrip(md: string): string {
  return htmlToMarkdown(renderCard(md));
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
