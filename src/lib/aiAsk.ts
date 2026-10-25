import { api } from "./api";
import { isTauri } from "./env";

/**
 * 「问 AI」（SPEC §10.1）：把组好的问题写进 AI 站点的聊天输入框。
 *
 * 三步：① 先复制到剪贴板（不同站点的编辑器结构不同，注入是 best-effort，
 * 剪贴板 + Ctrl+V 永远兜底）；② 打开 AI 助手窗口由调用方负责（aiWindowShow，
 * 独立窗口、隐藏不销毁）；③ 注入命令带重试——窗口刚打开时站点 webview
 * 可能还没建好，站点页面也要加载几秒，注入脚本自身会再轮询 8 秒找输入框。
 */
export async function fillAiQuestion(text: string): Promise<void> {
  if (!isTauri()) return;
  // 先等「打开窗口」落地，再开始重试：旧版两件事并发，窗口创建 + 宿主页
  // 加载 + 子 WebView 冷启动轻松超过 2.3 秒，三次重试全部落空——首开必
  // 静默失败（ai_fill_question 对未建好的子 webview 返回错误）。
  await api.aiWindowShow("popup").catch(() => {});
  // 总窗口 ~12.6s：覆盖子 WebView 冷启动；注入脚本自身还会再轮询 ~8.4s
  // 等站点输入框渲染，两条轮询相加足以跨过首次打开的全部延迟。
  for (const delay of [250, 500, 800, 1200, 1600, 2000, 2500, 3500]) {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    const ok = await api
      .aiFillQuestion(text)
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
}

/**
 * 问题最终是**原样落进 AI 站点的输入框**的（textarea 直接写 value、
 * contenteditable 直接写 textContent，见 `src-tauri/src/ai.rs`），卡面那套
 * Markdown 渲染的「软换行折叠成空格」在这里不成立——`\n` 就是真换行。于是
 * 源文件的硬换行、编辑器往返留下的行尾空格、多余空行都会让问题在输入框里
 * 显示得七零八落（2026-10-10 用户反馈：「文字之间的间距会很混乱」）。
 *
 * 这里只收拾**不改变语义**的空白：CRLF→LF、去行尾空白、连续空行最多留一个；
 * 围栏代码块（``` / ~~~）内部原样保留，免得动到卡片里的代码示例。
 */
function tidyWhitespace(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      out.push(line);
      // 闭合围栏：同一种符号、且不短于开启它的那一串。
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      blanks = 0;
      out.push(line);
      continue;
    }
    const trimmed = line.replace(/[ \t]+$/, "");
    if (trimmed === "" && ++blanks > 1) continue;
    if (trimmed !== "") blanks = 0;
    out.push(trimmed);
  }
  return out.join("\n").trim();
}

/** 组问题：标题 + 卡面内容打底（用户 2026-10-06 明确要全文都带给 AI），
 *  划选了文字就在最后追加针对那一段的提问。 */
export function composeQuestion(
  cardTitle: string,
  contentMd: string,
  selection: string,
): string {
  let text = `闪卡问题：${cardTitle}`;
  const content = contentMd.trim();
  if (content) text += `\n\n${content}`;
  const ask = selection.trim();
  if (ask) text += `\n\n想问的是这一段：「${ask}」`;
  return tidyWhitespace(text);
}
