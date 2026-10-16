// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  cardImagePreview,
  closestCardImage,
  previewFromCardImage,
  registerMockAttachment,
  resolveAttachment,
} from "./attachments";

const DATA_URL = "data:image/png;base64,AAAA";

/** A card image exactly as markdown.ts renders one (see markdown.test.ts). */
function cardImage(mdSrc: string, attrs: Record<string, string> = {}): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "card-image";
  img.setAttribute("data-md-src", mdSrc);
  for (const [name, value] of Object.entries(attrs)) img.setAttribute(name, value);
  return img;
}

describe("resolveAttachment (SPEC §5.4)", () => {
  it("maps an attachment ref to a loadable src", () => {
    registerMockAttachment("resolve-shot.png", DATA_URL);
    expect(resolveAttachment("attachment:resolve-shot.png")).toBe(DATA_URL);
  });

  it("ignores anything that is not an attachment ref", () => {
    expect(resolveAttachment("https://example.com/a.png")).toBeNull();
    expect(resolveAttachment("images/a.png")).toBeNull();
    expect(resolveAttachment("")).toBeNull();
  });

  it("refuses refs that try to escape the attachment directory", () => {
    expect(resolveAttachment("attachment:../secret.png")).toBeNull();
    expect(resolveAttachment("attachment:nested/a.png")).toBeNull();
    expect(resolveAttachment("attachment:nested\\a.png")).toBeNull();
    expect(resolveAttachment("attachment:")).toBeNull();
  });

  it("returns null while the referenced file is unknown", () => {
    expect(resolveAttachment("attachment:never-registered.png")).toBeNull();
  });
});

describe("closestCardImage (SPEC §5.4 放大预览)", () => {
  it("returns the rendered card image itself", () => {
    const img = cardImage("attachment:x.png");
    expect(closestCardImage(img)).toBe(img);
  });

  it("treats a link wrapping the image as the image", () => {
    // markdown-it renders `[![图](attachment:x.png)](url)` as <a><img></a>, and
    // the image fills the anchor's box — both are the same click target.
    const img = cardImage("attachment:x.png");
    const link = document.createElement("a");
    link.appendChild(img);
    expect(closestCardImage(link)).toBe(img);
  });

  it("does not reach into a block that merely contains an image", () => {
    // Clicking the text next to an image must not open a preview.
    const img = cardImage("attachment:x.png");
    const p = document.createElement("p");
    p.appendChild(img);
    p.appendChild(document.createTextNode("旁边的说明文字"));
    expect(closestCardImage(p)).toBeNull();
  });

  it("ignores non-image targets, and images without the card-image class", () => {
    expect(closestCardImage(document.createElement("p"))).toBeNull();
    expect(closestCardImage(null)).toBeNull();
    expect(closestCardImage(document.createElement("span"))).toBeNull();
    const plain = document.createElement("img");
    expect(closestCardImage(plain)).toBeNull();
  });
});

describe("previewFromCardImage (SPEC §5.4 放大预览)", () => {
  it("resolves a rendered local attachment into a preview target", () => {
    registerMockAttachment("preview-ok.png", DATA_URL);
    const img = cardImage("attachment:preview-ok.png", { alt: "架构图" });
    expect(previewFromCardImage(img)).toEqual({
      mdSrc: "attachment:preview-ok.png",
      url: DATA_URL,
      alt: "架构图",
    });
  });

  it("keeps the original ref even when the asset URL is rewritten", () => {
    registerMockAttachment("preview-raw.png", DATA_URL);
    const img = cardImage("attachment:preview-raw.png");
    img.setAttribute("src", DATA_URL);
    img.setAttribute("data-md-raw", "![图](attachment:preview-raw.png)");
    expect(previewFromCardImage(img)?.mdSrc).toBe("attachment:preview-raw.png");
  });

  it("never targets a remote or missing placeholder", () => {
    const placeholder = document.createElement("span");
    placeholder.className = "card-image-missing";
    placeholder.setAttribute("data-md-src", "https://example.com/a.png");
    expect(previewFromCardImage(placeholder)).toBeNull();
    // A remote URL that somehow reached an <img> is still not a local attachment.
    expect(previewFromCardImage(cardImage("https://example.com/a.png"))).toBeNull();
    // A local ref whose file is gone resolves to nothing → no preview.
    expect(previewFromCardImage(cardImage("attachment:gone.png"))).toBeNull();
    expect(previewFromCardImage(null)).toBeNull();
  });
});

describe("cardImagePreview 手势 (SPEC §5.4 / §9.2)", () => {
  it("opens on a single click in read-only rendering", () => {
    registerMockAttachment("gesture-ro.png", DATA_URL);
    const img = cardImage("attachment:gesture-ro.png");
    expect(cardImagePreview("click", img)?.url).toBe(DATA_URL);
    // Read-only rendering never needs a double click.
    expect(cardImagePreview("dblclick", img)).toBeNull();
  });

  it("keeps the single click for the caret in edit mode and opens on double click", () => {
    registerMockAttachment("gesture-edit.png", DATA_URL);
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const img = cardImage("attachment:gesture-edit.png");
    editor.appendChild(img);
    document.body.appendChild(editor);

    // 单击留给浏览器：落光标 / 拖选 / 右键批注的选区。
    expect(cardImagePreview("click", img)).toBeNull();
    expect(cardImagePreview("dblclick", img)?.url).toBe(DATA_URL);
  });

  it("ignores gestures that are not on a card image", () => {
    const text = document.createElement("p");
    text.textContent = "正文";
    expect(cardImagePreview("click", text)).toBeNull();
    expect(cardImagePreview("dblclick", text)).toBeNull();
    expect(cardImagePreview("click", null)).toBeNull();
  });
});
