/**
 * 粘贴文本导入（SPEC §5.5）：把一大段符合 §5 规范的文本直接贴进「导入」页，
 * 一次变成多张卡——不用先落成 `.md` 文件。
 *
 * 解析规则一个字都不新增：用的还是 §5.2 那一套（`#` 卡包 / `##` 章节 /
 * `###` 卡片 / `> [!question]` 题面）。本模块只做两件事：
 *
 * 1. 把文本包装成一次导入的虚拟文件——文本自带 `# 卡包` 就原样解析（可以一次
 *    带多个卡包），没有就用页面上选的卡包名补一行 H1；
 * 2. 给导入前的预览算一份摘要（章节/卡片数、卡片样例、以及"没有 `###`"这类
 *    会让人意外的提示）。
 */
import { DEFAULT_CHAPTER, hasHeading, parseMarkdown } from "./markdownImport";
import type { ImportFile } from "./api";

/** 预览里最多列几张卡——长粘贴不该把预览撑成一堵墙。 */
export const SAMPLE_LIMIT = 8;

/** 粘贴文本自带 `# 卡包` 吗（围栏代码块里的 `#` 不算标题）。 */
export function hasDeckHeading(text: string): boolean {
  return hasHeading(text, 1);
}

/**
 * 把粘贴文本包装成一次导入的虚拟文件。`deck` 是页面上选的卡包，只有在文本
 * **没有**一级标题时才用得上（`parse_files` 的 fallback 也认这个名字，两边一致）。
 *
 * 补标题的分寸（只影响粘贴，不动文件导入的规则）：
 * - 有 `#` → 原样，文本自带几个卡包就建几个；
 * - 没有 `#` 但有 `##` → 补 `# <卡包>`；
 * - 一个标题都没有 → 再补一行 `## 未分类`，否则这段正文挂在 `#` 下**不成卡**
 *   （§5.2 rule 10 认的是「没有 `###` 的章节」），用户会觉得"粘了等于没粘"。
 */
export function pasteImportFile(text: string, deck: string): ImportFile {
  const name = deck.trim() || "粘贴文本";
  if (hasDeckHeading(text)) return { name: `${name}.md`, content: text };
  const chapter = hasHeading(text, 2) ? "" : `## ${DEFAULT_CHAPTER}\n\n`;
  return { name: `${name}.md`, content: `# ${name}\n\n${chapter}${text}` };
}

export interface PasteSummary {
  chapters: number;
  cards: number;
  /** 这次粘贴会写进哪些卡包（按出现顺序去重）。 */
  deckNames: string[];
  /** 「章节 · 标题」样例，最多 [`SAMPLE_LIMIT`] 条。 */
  samples: string[];
  /** 整段一个 `###` 都没有：解析出来的全是「题面卡」（正面是整段、背面留空）。 */
  allFrontCards: boolean;
  /** 导入前的一句提示；null = 没什么要提醒的。 */
  notice: string | null;
}

/** 导入前的预览摘要。空的卡包（只有 `#` 没有卡）不计入。 */
export function summarizePaste(text: string, deck: string): PasteSummary {
  const parsed = parseMarkdown(pasteImportFile(text, deck).content, deck.trim());
  const samples: string[] = [];
  const deckNames: string[] = [];
  let chapters = 0;
  let cards = 0;
  for (const d of parsed) {
    let decksCards = 0;
    for (const ch of d.chapters) {
      if (ch.cards.length === 0) continue;
      chapters += 1;
      decksCards += ch.cards.length;
      for (const c of ch.cards) {
        if (samples.length < SAMPLE_LIMIT) samples.push(`${ch.name} · ${c.title}`);
      }
    }
    if (decksCards === 0) continue;
    cards += decksCards;
    if (!deckNames.includes(d.name)) deckNames.push(d.name);
  }
  // 一个 `###` 都没有 ⇒ 每一张都是 rule 10 的题面卡，值得先说一声。
  const allFrontCards = cards > 0 && !hasHeading(text, 3);
  return {
    chapters,
    cards,
    deckNames,
    samples,
    allFrontCards,
    notice:
      cards === 0
        ? "还没有解析出卡片：先粘贴内容，每张卡用一行 `### 标题` 开头。"
        : allFrontCards
          ? `没有识别到 \`###\` 标题：整段会存成 ${cards} 张「题面卡」（正面是全文、背面留空）。想拆成多张卡，请给每张卡加一行 \`### 标题\`。`
          : null,
  };
}
