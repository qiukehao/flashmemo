import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
// The plugin's default entry imports the full highlight.js (~1MB); the `core`
// entry takes an instance instead, so we pass the common-language subset.
import highlightjs from "markdown-it-highlightjs/core";
import hljs from "highlight.js/lib/common";
import type { PluginSimple } from "markdown-it";
import { imageMarkdown, resolveAttachment } from "./attachments";

/**
 * `%%备注%%` → SPEC §9.1 批注块 (left bar + 📝 + light background).
 * No maintained markdown-it plugin exists for this syntax, so it is a small
 * local inline rule. Inner text is rendered as inline markdown.
 */
const cardRemark: PluginSimple = (md) => {
  md.inline.ruler.before("emphasis", "card_remark", (state, silent) => {
    const start = state.pos;
    if (
      state.src.charCodeAt(start) !== 0x25 /* % */ ||
      state.src.charCodeAt(start + 1) !== 0x25
    ) {
      return false;
    }
    const end = state.src.indexOf("%%", start + 2);
    if (end < 0) return false;
    if (!silent) {
      const token = state.push("card_remark", "", 0);
      token.markup = "%%";
      const content = state.src.slice(start + 2, end);
      token.children = [];
      state.md.inline.parse(content, state.md, state.env, token.children);
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.card_remark = (tokens, idx, options, env, self) => {
    const inner = self.renderInline(tokens[idx].children ?? [], options, env);
    return `<div class="card-note"><span class="card-note-icon">📝</span>${inner}</div>`;
  };
};

/**
 * Obsidian-style callouts: `> [!note] 傻瓜讲解` + quoted body. The user's real
 * notes lean on these heavily, so they get a styled block (icon + title +
 * tinted background per type) instead of a literal `[!note]` blockquote.
 */
const CALLOUT_ICONS: Record<string, string> = {
  note: "📘",
  tip: "💡",
  info: "ℹ️",
  important: "❗",
  warning: "⚠️",
  caution: "⚠️",
  danger: "🔥",
  error: "❌",
  bug: "🐛",
  success: "✅",
  question: "❓",
  example: "🧪",
  quote: "❝",
  failure: "❌",
};
const CALLOUT_DEFAULT_TITLES: Record<string, string> = {
  note: "笔记",
  tip: "技巧",
  warning: "注意",
  danger: "危险",
  important: "重要",
  success: "完成",
  question: "问题",
  example: "示例",
};

const callouts: PluginSimple = (md) => {
  // Runs after block parsing but BEFORE the inline core rule, so the rewritten
  // first line is what actually gets parsed into inline children. The original
  // blockquote is kept intact inside a wrapper div, which keeps the markdown
  // round-trip (see wysiwyg.ts) lossless.
  md.core.ruler.after("block", "card_callouts", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      // The marker must be the first thing in the blockquote's first inline.
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== "blockquote_close") {
        if (tokens[j].type === "inline") break;
        j++;
      }
      const inline = tokens[j];
      if (!inline || inline.type !== "inline") continue;
      const m = /^\[!([A-Za-z]+)\][+-]?[ \t]*(.*?)(?:\n|$)/.exec(inline.content);
      if (!m) continue;
      const type = m[1].toLowerCase();
      const title = (m[2] ?? "").trim();
      inline.content = inline.content.slice(m[0].length);

      // A marker-only first line becomes an empty paragraph: drop it.
      if (inline.content.trim() === "" && tokens[j - 1]?.type === "paragraph_open") {
        tokens.splice(j - 1, 3); // paragraph_open, inline, paragraph_close
      }

      // Wrap the blockquote: <div class="callout …"><p class="callout-title">…</p><blockquote>…</blockquote></div>
      const open = new state.Token("callout_open", "div", 1);
      open.attrSet("class", `callout callout-${type}`);
      const titleToken = new state.Token("callout_title", "", 0);
      titleToken.meta = {
        icon: CALLOUT_ICONS[type] ?? "📘",
        title: title || CALLOUT_DEFAULT_TITLES[type] || type,
      };
      tokens.splice(i, 0, open, titleToken);

      // Matching close: start after our own open/title/blockquote_open trio
      // (i + 3) and only count NESTED blockquotes from there.
      let depth = 0;
      for (let k = i + 3; k < tokens.length; k++) {
        if (tokens[k].type === "blockquote_open") depth++;
        else if (tokens[k].type === "blockquote_close") {
          if (depth === 0) {
            const close = new state.Token("callout_close", "div", -1);
            tokens.splice(k + 1, 0, close);
            break;
          }
          depth--;
        }
      }
      i += 2; // skip the inserted open + title
    }
  });
  md.renderer.rules.callout_title = (tokens, idx) => {
    const meta = tokens[idx].meta as { icon: string; title: string };
    return `<p class="callout-title"><span class="callout-icon">${meta.icon}</span><span class="callout-title-text">${md.utils.escapeHtml(
      meta.title,
    )}</span></p>`;
  };
};

/**
 * Card images (SPEC §5.4): `attachment:<file>` refs resolve to an asset URL.
 * Anything else we cannot load — a relative path from a note that was never
 * imported with its images, or a remote URL, which the offline privacy rule
 * forbids — renders as a visible placeholder instead of a broken-image icon.
 * The `data-md-raw` / `data-md-src` attributes let the WYSIWYG round-trip
 * (wysiwyg.ts) put the very same markdown back on save.
 */
const cardImages: PluginSimple = (md) => {
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    const altIndex = token.attrIndex("alt");
    if (altIndex < 0) token.attrPush(["alt", alt]);
    else token.attrs![altIndex][1] = alt;

    const src = token.attrGet("src") ?? "";
    const title = token.attrGet("title");
    const raw = imageMarkdown(alt, src, title);
    const resolved = resolveAttachment(src);
    if (resolved) {
      token.attrSet("src", resolved);
      token.attrSet("data-md-src", src);
      token.attrSet("data-md-raw", raw);
      token.attrJoin("class", "card-image");
      return self.renderToken(tokens, idx, options);
    }
    const remote = /^(https?:)?\/\//i.test(src);
    const note = remote
      ? "🔒 远程图片未加载（闪记离线运行，不请求网络）"
      : `🖼 图片未找到：${src}`;
    return `<span class="card-image-missing" data-md-raw="${md.utils.escapeHtml(
      raw,
    )}" data-md-src="${md.utils.escapeHtml(src)}" data-md-alt="${md.utils.escapeHtml(
      alt,
    )}" title="${md.utils.escapeHtml(note)}">${md.utils.escapeHtml(note)}</span>`;
  };
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.use(mark);
md.use(cardRemark);
md.use(callouts);
md.use(cardImages);
md.use(highlightjs, { inline: false, auto: true, code: true, hljs });
// Extended GFM: `- [x]` task lists and `[^n]` footnotes (2026-10-03 audit).
md.use(taskLists);
md.use(footnote);

/** Render card back markdown: GFM basics + ==highlight== + %%remark%% +
 *  Obsidian callouts + syntax-highlighted code blocks (SPEC §9.1). */
export function renderCard(src: string): string {
  return md.render(src ?? "");
}

// --------------------------------------------------------------- 题面（正面）
// 需求7（SPEC §5.2 / §9.2）：正面不再假设是"一行纯文本标题"。图片型 / 长题干卡
// 用同一套 Markdown 渲染器，所以正面也支持图片与多行；旧卡（没有 front_md、
// 标题是单行）走原来的纯文本路径，观感逐字节不变。

/**
 * 题面的 Markdown 来源：`front_md` 非空就用它，否则退回 `title`。
 * `title` 仍然是**身份键**（`UNIQUE(chapter_id,title)` + 导入幂等键 + 列表标签），
 * 因此题面变长/变图不会把卡片变成"新卡"（复习进度不丢）。
 */
export function frontMarkdown(title: string, frontMd?: string | null): string {
  const rich = (frontMd ?? "").trim();
  return rich || (title ?? "");
}

/**
 * 题面是否是"富题面"（含图片引用或换行）：决定正面用 Markdown 渲染，还是保持
 * 原来的单行纯文本样式。纯文本正面返回 false —— 现有卡的外观与既有测试不变。
 */
export function isRichFront(src: string): boolean {
  const text = src ?? "";
  return /!\[[^\]]*\]\(/.test(text) || text.includes("\n");
}

/**
 * 题面的单行投影：只能用一行的位置（列表行、「继续下一张」按钮、知识铺垫标题）
 * 用它。图片引用折成 🖼，换行折成「 · 」，单行纯文本原样返回（恒等）。
 */
export function frontLabel(src: string): string {
  return (src ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "🖼")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ")
    .trim();
}
