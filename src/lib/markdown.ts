import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import highlightjs from "markdown-it-highlightjs";
import type { PluginSimple } from "markdown-it";

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

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
md.use(mark);
md.use(cardRemark);
md.use(highlightjs, { inline: false, auto: true, code: true });

/** Render card back markdown: GFM basics + ==highlight== + %%remark%% +
 *  syntax-highlighted code blocks (SPEC §9.1). */
export function renderCard(src: string): string {
  return md.render(src ?? "");
}
