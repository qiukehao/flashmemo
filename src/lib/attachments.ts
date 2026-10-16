import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./env";

/**
 * Card images (SPEC §5.4 / §9.4). The markdown source of truth is a stable
 * `attachment:<file>` reference; the file itself lives in
 * `%APPDATA%\FlashMemo\attachments` and is served to the webview through the
 * asset protocol. The browser debug mode has no filesystem, so it keeps the
 * pasted bytes as data URLs in memory and resolves refs from there.
 */
export const ATTACHMENT_PREFIX = "attachment:";

/** Extensions the Rust store accepts (kept in sync with attachments.rs). */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];

let storeDir = "";
const mockFiles = new Map<string, string>();

/** Called once per window at bootstrap, before the first card renders. */
export async function initAttachments(): Promise<void> {
  if (!isTauri()) return;
  try {
    storeDir = await invoke<string>("attachment_dir");
  } catch (e) {
    console.warn("[attachments] 附件目录不可用，卡面图片将显示占位：", e);
  }
}

export function attachmentDir(): string {
  return storeDir;
}

export function isAttachment(src: string): boolean {
  return src.startsWith(ATTACHMENT_PREFIX);
}

/** Mock-only: remember a stored image as a data URL (no filesystem in a browser). */
export function registerMockAttachment(name: string, dataUrl: string): void {
  mockFiles.set(name, dataUrl);
}

/** Mock-only: is this ref already backed by bytes? (So a debug placeholder never clobbers it.) */
export function hasMockAttachment(name: string): boolean {
  return mockFiles.has(name);
}

/** `attachment:<file>` -> something an `<img>` can load, or null when unknown. */
export function resolveAttachment(src: string): string | null {
  if (!isAttachment(src)) return null;
  const file = src.slice(ATTACHMENT_PREFIX.length);
  // Never let a card reference escape the attachment folder.
  if (!file || /[\\/]/.test(file) || file.includes("..")) return null;
  const mock = mockFiles.get(file);
  if (mock) return mock;
  if (!storeDir || !isTauri()) return null;
  return convertFileSrc(`${storeDir}/${file}`);
}

/**
 * What the lightbox needs to show one card image (SPEC §5.4 放大预览).
 * `mdSrc` is the untouched markdown reference — the preview is read-only and
 * must never rewrite what the WYSIWYG round-trip saves back.
 */
export interface ImagePreview {
  mdSrc: string;
  url: string;
  alt: string;
}

/** The card image a pointer event landed on, or null. */
export function closestCardImage(target: EventTarget | null): Element | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return null;
  // Card images are leaf nodes, so the target normally IS the `<img>`. The two
  // fallbacks cover the only wrappers our renderer can produce: an ancestor hit
  // inside a wrapped image, and a `[![图](attachment:x)](url)` link, whose box
  // the image fills. Deliberately NOT a descendant search on a paragraph —
  // clicking the text next to an image must not open a preview.
  const img =
    el.tagName === "IMG"
      ? el
      : el.closest("img.card-image") ??
        (el.tagName === "A" ? el.querySelector("img.card-image") : null);
  return img && img.classList.contains("card-image") ? img : null;
}

/**
 * Preview target for a rendered card image, or null when it must not open one:
 * only resolvable local `attachment:` refs qualify — remote/missing refs render
 * as a `.card-image-missing` placeholder (never an `<img>`) and stay inert.
 */
export function previewFromCardImage(img: Element | null): ImagePreview | null {
  if (!img || img.tagName !== "IMG" || !img.classList.contains("card-image")) return null;
  const mdSrc = img.getAttribute("data-md-src") ?? "";
  if (!isAttachment(mdSrc)) return null;
  const url = resolveAttachment(mdSrc);
  if (!url) return null;
  return { mdSrc, url, alt: img.getAttribute("alt") ?? "" };
}

/**
 * The lightbox gesture on a card (SPEC §5.4 / §9.2). 编辑态的单击必须留给浏览器 ——
 * 它要落光标、拖选、给右键批注菜单准备选区；打断它就等于毁掉卡面编辑。所以
 * 编辑态（contenteditable）改用**双击**放大，只读渲染（知识铺垫前置卡、预览）
 * 没有编辑语义，**单击**即放大。
 */
export function cardImagePreview(type: string, target: EventTarget | null): ImagePreview | null {
  const img = closestCardImage(target);
  if (!img) return null;
  const editable = Boolean(img.closest('[contenteditable="true"]'));
  if (type !== (editable ? "dblclick" : "click")) return null;
  return previewFromCardImage(img);
}

/**
 * Rebuild the markdown for one image. Paths with spaces or parentheses must
 * stay inside `<...>` or they stop being a valid link destination — the reason
 * this helper exists instead of a plain template string.
 */
export function imageMarkdown(alt: string, src: string, title?: string | null): string {
  const dest = /[\s()]/.test(src) ? `<${src}>` : src;
  return `![${alt}](${dest}${title ? ` "${title}"` : ""})`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Store pasted/selected bytes; returns the markdown reference to embed. */
export async function uploadImageBlob(blob: Blob, nameHint?: string): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  const ext = nameHint?.split(".").pop()?.toLowerCase();
  return invoke<string>("save_attachment", {
    data: dataUrl,
    ext: ext && IMAGE_EXTS.includes(ext) ? ext : null,
  });
}

/** Pick one image; resolves to an `attachment:` ref, or null when cancelled. */
export async function pickImageRef(): Promise<string | null> {
  if (isTauri()) {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: IMAGE_EXTS }],
    });
    const path = typeof picked === "string" ? picked : null;
    return path ? await invoke<string>("save_attachment_file", { path }) : null;
  }
  const file = await pickImageViaInput();
  return file ? await uploadImageBlob(file, file.name) : null;
}

/** Mock/browser picker (also a fallback when the native dialog is unavailable). */
function pickImageViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });
    // A cancelled picker fires no event: release on window focus after a beat.
    window.addEventListener(
      "focus",
      () => setTimeout(() => {
        if (document.body.contains(input)) {
          input.remove();
          resolve(null);
        }
      }, 500),
      { once: true },
    );
    input.click();
  });
}

/** Images carried by a paste event (screenshots land here as image/png). */
export function imageFilesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Store every image in a drop/paste payload, keeping document order. */
export async function uploadImageFiles(files: File[]): Promise<string[]> {
  const refs: string[] = [];
  for (const file of files) {
    try {
      refs.push(await uploadImageBlob(file, file.name));
    } catch (e) {
      console.warn("[attachments] 图片保存失败：", e);
    }
  }
  return refs;
}
