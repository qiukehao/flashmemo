import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
md.use(mark);

/** Render card back markdown: GFM basics + `==highlight==` (SPEC §9.1). */
export function renderCard(src: string): string {
  return md.render(src ?? "");
}
