// SPEC §5.5：粘贴一大段文本 → 一次导入多张卡。规则与文件导入完全一致（§5.2），
// 这里只测「包装成虚拟文件 + 预览摘要」这两件事。
import { describe, expect, it } from "vitest";
import { hasDeckHeading, pasteImportFile, summarizePaste } from "./pasteImport";
import { parseMarkdown } from "./markdownImport";

const PASTE = [
  "## 事务",
  "",
  "### ACID 是什么？",
  "- **原子性**：不可分割",
  "",
  "### 隔离级别有哪些？",
  "1. 读未提交",
  "",
  "## 索引",
  "",
  "### B+ 树和 B 树的区别？",
  "叶子节点存数据",
  "",
].join("\n");

describe("hasDeckHeading（文本自带卡包标题吗）", () => {
  it("有 `# ` 一级标题时为真", () => {
    expect(hasDeckHeading("# MySQL\n\n### 卡\n内容\n")).toBe(true);
  });

  it("只有 `##` / `###` 时为假", () => {
    expect(hasDeckHeading(PASTE)).toBe(false);
  });

  it("围栏代码块里的 `# 注释` 不算标题", () => {
    expect(hasDeckHeading("```sql\n-- # 不是标题\nSELECT 1;\n```\n")).toBe(false);
  });

  it("空文本为假（没有卡包可谈）", () => {
    expect(hasDeckHeading("   \n\n")).toBe(false);
  });
});

describe("pasteImportFile（包装成一次导入的虚拟文件）", () => {
  it("文本没有 `#` 时，用页面上选的卡包补一行 H1", () => {
    const file = pasteImportFile(PASTE, "MySQL 八股");
    expect(file.name).toBe("MySQL 八股.md");
    const decks = parseMarkdown(file.content, "should-not-be-used");
    expect(decks.map((d) => d.name)).toEqual(["MySQL 八股"]);
    expect(decks[0].chapters.map((c) => c.name)).toEqual(["事务", "索引"]);
    expect(decks[0].chapters[0].cards.map((c) => c.title)).toEqual([
      "ACID 是什么？",
      "隔离级别有哪些？",
    ]);
  });

  it("文本自带 `#` 时原样解析（一次可带多个卡包）", () => {
    const text = "# A\n\n### 卡1\n甲\n\n# B\n\n### 卡2\n乙\n";
    const file = pasteImportFile(text, "被忽略的卡包");
    expect(file.content).toBe(text);
    const decks = parseMarkdown(file.content, "fallback");
    expect(decks.map((d) => d.name)).toEqual(["A", "B"]);
  });

  it("只有 `###` 卡片时落进所选卡包的「未分类」章节", () => {
    const file = pasteImportFile("### 孤儿卡\n要点\n", "目标包");
    const decks = parseMarkdown(file.content, "fallback");
    expect(decks[0].name).toBe("目标包");
    expect(decks[0].chapters[0].name).toBe("未分类");
  });

  it("补 H1 不会改坏卡面：`> [!question]` 题面仍然照常拆分", () => {
    const text = "### LC146\n> [!question]\n> 设计 LRU 缓存\n\n哈希表 + 双向链表\n";
    const decks = parseMarkdown(pasteImportFile(text, "刷题").content, "fallback");
    const card = decks[0].chapters[0].cards[0];
    expect(card.title).toBe("LC146");
    expect(card.frontMd).toBe("设计 LRU 缓存");
    expect(card.contentMd).toBe("哈希表 + 双向链表");
  });

  it("卡包名去掉首尾空白（避免铸出一个带空格的卡包）", () => {
    expect(pasteImportFile(PASTE, "  MySQL  ").content.startsWith("# MySQL\n")).toBe(true);
  });
});

describe("summarizePaste（导入前给用户看的摘要）", () => {
  it("数出章节/卡片/卡包，并给出章节·标题样例", () => {
    const s = summarizePaste(PASTE, "MySQL 八股");
    expect(s.chapters).toBe(2);
    expect(s.cards).toBe(3);
    expect(s.deckNames).toEqual(["MySQL 八股"]);
    expect(s.samples).toEqual([
      "事务 · ACID 是什么？",
      "事务 · 隔离级别有哪些？",
      "索引 · B+ 树和 B 树的区别？",
    ]);
    expect(s.allFrontCards).toBe(false);
    expect(s.notice).toBeNull();
  });

  it("文本有 `##` 章节但没有 `###`：整段成为该章节的题面卡", () => {
    const s = summarizePaste("## 随手记\n\n第一章讲事务。\n", "随手记");
    expect(s.cards).toBe(1);
    expect(s.chapters).toBe(1);
    expect(s.deckNames).toEqual(["随手记"]);
    expect(s.allFrontCards).toBe(true);
    expect(s.notice).toContain("###");
  });

  it("整段没有任何标题：补上「未分类」章节，整段成为一张题面卡", () => {
    const file = pasteImportFile("什么是事务？\n事务是一组不可分割的操作。\n", "随手记");
    const decks = parseMarkdown(file.content, "fallback");
    expect(decks[0].name).toBe("随手记");
    expect(decks[0].chapters[0].name).toBe("未分类");
    expect(decks[0].chapters[0].cards[0].frontMd).toBe(
      "什么是事务？\n事务是一组不可分割的操作。",
    );
    expect(decks[0].chapters[0].cards[0].contentMd).toBe("");
  });

  it("空文本：0 张卡，提示先粘贴内容", () => {
    const s = summarizePaste("\n  \n", "随手记");
    expect(s.cards).toBe(0);
    expect(s.notice).toContain("粘贴");
  });

  it("只有 `#` 卡包没有任何卡时不假装有卡", () => {
    const s = summarizePaste("# 空卡包\n", "随手记");
    expect(s.cards).toBe(0);
    expect(s.deckNames).toEqual([]);
  });

  it("样例最多 8 条，长粘贴不把预览撑爆", () => {
    const many = Array.from({ length: 20 }, (_, i) => `### 卡${i + 1}\n答案`).join("\n\n");
    const s = summarizePaste(many, "批量");
    expect(s.cards).toBe(20);
    expect(s.samples).toHaveLength(8);
  });
});
