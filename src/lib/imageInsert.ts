import { insertImageAtCaret, insertTextAtCaret } from "./dom";
import {
  imageFilesFromClipboard,
  pickImageRef,
  uploadImageFiles,
} from "./attachments";
import { pasteStructured } from "./wysiwyg";

/**
 * 插入图片 flows shared by the three editing surfaces (SPEC §9.4): the review
 * popup, the deck card editor and the add-card form. Picking/pasting stores
 * the bytes through the attachment command and only the returned
 * `attachment:` reference ends up in the card markdown.
 */

/** Toolbar 「图片」 for a contenteditable card. Returns true when one was inserted. */
export async function insertPickedImage(root: HTMLElement, alt = "图片"): Promise<boolean> {
  const ref = await pickImageRef().catch((e) => {
    console.warn("[attachments] 选择图片失败：", e);
    return null;
  });
  if (!ref) return false;
  return insertImageAtCaret(root, ref, alt);
}

/** Toolbar 「图片」 for the markdown textarea (add-card form). */
export async function insertPickedImageMarkdown(ta: HTMLTextAreaElement): Promise<boolean> {
  const ref = await pickImageRef().catch((e) => {
    console.warn("[attachments] 选择图片失败：", e);
    return null;
  });
  if (!ref) return false;
  insertTextAtCaret(ta, imageBlock(ta, ref));
  return true;
}

/** Paste into the markdown textarea: same store, markdown ref instead of DOM. */
export async function insertPastedImageMarkdown(
  ta: HTMLTextAreaElement,
  e: ClipboardEvent,
): Promise<boolean> {
  const files = imageFilesFromClipboard(e);
  if (files.length === 0) return false;
  e.preventDefault();
  for (const ref of await uploadImageFiles(files)) insertTextAtCaret(ta, imageBlock(ta, ref));
  return true;
}

/** An image on its own lines (a real image block), padded around existing text. */
function imageBlock(ta: HTMLTextAreaElement, src: string): string {
  return `${ta.value.trim() ? "\n\n" : ""}![图片](${src})\n\n`;
}

/** Paste into a contenteditable card editor, replacing the browser's default:
 *  screenshots arrive as files → attachment refs; rich HTML / plain text is
 *  normalized to card markup at the caret (external fonts and colors never
 *  enter the card DOM). Call SYNCHRONOUSLY from the paste handler — the
 *  preventDefault inside only works during event dispatch. */
export function pasteIntoCardEditor(root: HTMLElement, e: ClipboardEvent): boolean {
  const files = imageFilesFromClipboard(e);
  if (files.length > 0) {
    e.preventDefault();
    void uploadImageFiles(files).then((refs) => {
      for (const ref of refs) insertImageAtCaret(root, ref);
    });
    return true;
  }
  return pasteStructured(root, e);
}
