import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAPTER,
  frontTitleProjection,
  nonEmptyDecks,
  parseMarkdown,
} from "./markdownImport";

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

// 需求7 / SPEC §5.2 rule 10/11/12：与 parser.rs 的用例逐条对应（真机行为为准）。
describe("题面卡镜像（需求7，rule 10/11/12）", () => {
  it("无 `###` 的非空章节 → 1 张题面卡：frontMd=整段、背面空、title=单行投影", () => {
    // 与 parser.rs::tests::chapter_without_h3_becomes_front_card 同输入同期望。
    const decks = parseMarkdown(
      "# D\n\n## 题面章\n\n![架构图](attachment:abc.png)\n下面这句话是什么？\n",
      "x",
    );
    const ch = decks[0].chapters[0];
    expect(ch.cards).toHaveLength(1);
    expect(ch.cards[0].frontMd).toBe("![架构图](attachment:abc.png)\n下面这句话是什么？");
    expect(ch.cards[0].contentMd).toBe("");
    expect(ch.cards[0].title).toBe("🖼 · 下面这句话是什么？");
  });

  it("空/纯空白章节不产卡；有 `###` 的卡 frontMd 恒为空", () => {
    const decks = parseMarkdown("# D\n\n## 空章\n\n   \n\n## 有卡\n\n### 卡\n背\n", "x");
    expect(decks[0].chapters[0].cards).toHaveLength(0);
    expect(decks[0].chapters[1].cards).toHaveLength(1);
    expect(decks[0].chapters[1].cards[0].frontMd).toBe("");
    expect(decks[0].chapters[1].cards[0].contentMd).toBe("背");
  });

  it("rule 12：有 `###` 卡的章节，前导正文不成卡也不并入任何卡", () => {
    const decks = parseMarkdown(
      "# D\n\n## C\n\n章节前导说明\n\n### 问题\n背\n",
      "x",
    );
    const cards = decks[0].chapters[0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("问题");
    expect(cards[0].frontMd).toBe("");
    expect(cards[0].contentMd).toBe("背");
    // 前导正文哪里都没进去。
    expect(JSON.stringify(cards)).not.toContain("章节前导说明");
  });

  it("rule 11：围栏里的 `###` 不拆卡，整段进题面", () => {
    const decks = parseMarkdown(
      "# D\n\n## C\n\n```\n### 不是标题\n```\n还是题面\n",
      "x",
    );
    const cards = decks[0].chapters[0].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].frontMd).toContain("### 不是标题");
    expect(cards[0].frontMd).toContain("还是题面");
    expect(cards[0].title).toContain("### 不是标题");
  });

  it("`####` 以下算题面正文（rule 4 在题面卡上的表现）", () => {
    const decks = parseMarkdown("# D\n\n## C\n\n#### 小标题\n正文\n", "x");
    expect(decks[0].chapters[0].cards).toHaveLength(1);
    expect(decks[0].chapters[0].cards[0].frontMd).toContain("#### 小标题");
  });

  it("frontTitleProjection：图片折 🖼、跳空行、` · ` 连接（与 Rust 逐条一致）", () => {
    expect(frontTitleProjection("![图](a.png)")).toBe("🖼");
    expect(frontTitleProjection("![图](a.png)\n\n下面是什么？")).toBe("🖼 · 下面是什么？");
    expect(frontTitleProjection("  前  \n\n  后  ")).toBe("前 · 后");
    expect(frontTitleProjection("纯文本")).toBe("纯文本");
    // 不完整的图片语法原样保留（镜像 image_ref_end 的 None 分支）。
    expect(frontTitleProjection("![没闭合](a.png")).toBe("![没闭合](a.png");
    expect(frontTitleProjection("![缺目标]")).toBe("![缺目标]");
    // 只有图片、没有文字时投影非空 → 仍然成卡。
    expect(frontTitleProjection("![图](a.png)")).not.toBe("");
  });

  it("题面卡能通过 nonEmptyDecks（空章节才会被滤掉）", () => {
    const decks = parseMarkdown("# D\n\n## 题面章\n\n![图](attachment:a.png)\n", "x");
    const kept = nonEmptyDecks(decks);
    expect(kept).toHaveLength(1);
    expect(kept[0].chapters[0].cards[0].frontMd).toBe("![图](attachment:a.png)");
  });
});

// 需求7 / SPEC §5.2 rule 13（2026-10-07）：`###` 卡首块 `> [!question]` 拆题面/背面。
// 与 parser.rs 的用例逐条对应（真机行为为准）。
describe("题面标注块镜像（rule 13）", () => {
  it("首块 `> [!question]` → 题面；其余 → 背面；title 仍是 H3", () => {
    const decks = parseMarkdown(
      "# D\n\n## C\n\n### LC146 LRU 缓存\n> [!question]\n> 设计一个满足 LRU 约束的数据结构……\n> ![题面](lc146.png)\n\n思路：哈希表 + 双向链表\n\n**复杂度** 时间 O(1)\n",
      "x",
    );
    const c = decks[0].chapters[0].cards[0];
    expect(c.title).toBe("LC146 LRU 缓存");
    expect(c.frontMd).toBe("设计一个满足 LRU 约束的数据结构……\n![题面](lc146.png)");
    expect(c.contentMd).toContain("思路：哈希表 + 双向链表");
    expect(c.contentMd).toContain("**复杂度** 时间 O(1)");
    expect(c.contentMd).not.toContain("[!question]");
  });

  it("标注块标题成为题面首行；中文标记 `[!题目]` 同样识别", () => {
    const a = parseMarkdown("# D\n\n## C\n\n### 卡\n> [!question] 题干标题\n> 正文\n\n答案\n", "x");
    expect(a[0].chapters[0].cards[0].frontMd).toBe("题干标题\n正文");
    expect(a[0].chapters[0].cards[0].contentMd).toBe("答案");

    const b = parseMarkdown("# D\n\n## C\n\n### 卡\n> [!题目]\n> 一段话题目\n\n答案\n", "x");
    expect(b[0].chapters[0].cards[0].frontMd).toBe("一段话题目");
  });

  it("不是首块就不拆；空标注块保持旧形状；围栏里的标注块不算", () => {
    const later = parseMarkdown("# D\n\n## C\n\n### 卡\n先说明\n\n> [!question]\n> 后置引用\n", "x");
    expect(later[0].chapters[0].cards[0].frontMd).toBe("");
    expect(later[0].chapters[0].cards[0].contentMd).toContain("[!question]");

    const empty = parseMarkdown("# D\n\n## C\n\n### 卡\n> [!question]\n\n答案\n", "x");
    expect(empty[0].chapters[0].cards[0].frontMd).toBe("");
    expect(empty[0].chapters[0].cards[0].contentMd).toContain("答案");

    const fenced = parseMarkdown("# D\n\n## C\n\n### 卡\n```md\n> [!question]\n```\n答案\n", "x");
    expect(fenced[0].chapters[0].cards[0].frontMd).toBe("");
    expect(fenced[0].chapters[0].cards[0].contentMd).toContain("> [!question]");
  });

  it("只有题面、没有答案时背面为空", () => {
    const decks = parseMarkdown("# D\n\n## C\n\n### 卡\n> [!question]\n> 只有题面\n", "x");
    expect(decks[0].chapters[0].cards[0].frontMd).toBe("只有题面");
    expect(decks[0].chapters[0].cards[0].contentMd).toBe("");
  });
});
