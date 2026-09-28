import { describe, expect, it } from "vitest";
import { DEFAULT_CHAPTER, nonEmptyDecks, parseMarkdown } from "./markdownImport";

describe("parseMarkdown (browser mock mirror of parser.rs)", () => {
  it("parses H1/H2/H3 into deck/chapter/card", () => {
    const decks = parseMarkdown("# MySQL\n\n## 事务\n\n### ACID?\n- **原子性**\n", "x");
    expect(decks).toHaveLength(1);
    expect(decks[0].name).toBe("MySQL");
    expect(decks[0].chapters[0].name).toBe("事务");
    expect(decks[0].chapters[0].cards[0].title).toBe("ACID?");
    expect(decks[0].chapters[0].cards[0].contentMd).toContain("- **原子性**");
  });

  it("ignores hashes inside fenced code blocks", () => {
    const src = "# D\n\n## C\n\n### 卡\n```sql\n-- # 注释\n### 不拆卡\n```\n";
    const decks = parseMarkdown(src, "x");
    expect(decks[0].chapters[0].cards).toHaveLength(1);
    expect(decks[0].chapters[0].cards[0].contentMd).toContain("### 不拆卡");
  });

  it("uses the fallback deck name only when the file has no H1", () => {
    const decks = parseMarkdown("## C\n\n### 卡\nx\n", "文件名");
    expect(decks[0].name).toBe("文件名");
    expect(decks[0].chapters[0].name).toBe("C");
  });

  it("joins pre-H1 content into the first H1 deck", () => {
    const decks = parseMarkdown("## C1\n\n### t1\nx\n\n# REAL\n\n### t2\ny\n", "文件名");
    expect(decks).toHaveLength(1);
    expect(decks[0].name).toBe("REAL");
    expect(decks[0].chapters.map((c) => c.name)).toEqual(["C1", DEFAULT_CHAPTER]);
  });

  it("drops empty decks (stray leading H1)", () => {
    const decks = parseMarkdown("# MySQL\n\n# Mysql重点\n\n## 事务\n\n### 卡\n内容\n", "x");
    const kept = nonEmptyDecks(decks);
    expect(kept).toHaveLength(1);
    expect(kept[0].name).toBe("Mysql重点");
  });
});
