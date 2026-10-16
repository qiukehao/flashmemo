import { imageMarkdown, resolveAttachment } from "./attachments";

/**
 * Keyboard routing helper: when the event target lives inside a text field
 * (the always-editable card, an input, a textarea), shortcuts like
 * `1/2/3` or space must go to the text instead of the review actions.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest('[contenteditable="true"], textarea, input, select'));
}

/**
 * Insert an image into a contenteditable card at the caret (SPEC §9.4). The
 * node carries `data-md-raw` so the WYSIWYG round-trip writes exactly this
 * markdown back; the caret lands after the image for continued typing.
 */
export function insertImageAtCaret(
  root: HTMLElement,
  mdSrc: string,
  alt = "图片",
): boolean {
  const img = document.createElement("img");
  img.setAttribute("data-md-src", mdSrc);
  img.setAttribute("data-md-raw", imageMarkdown(alt, mdSrc));
  img.setAttribute("alt", alt);
  const resolved = resolveAttachment(mdSrc);
  if (resolved) img.setAttribute("src", resolved);
  img.className = "card-image";

  const sel = window.getSelection();
  let placed = false;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      placed = true;
    }
  }
  if (!placed) root.appendChild(img);
  return true;
}

/**
 * Insert markdown text at the caret of a textarea (AddCardPage). The caller
 * passes the padding it wants (an image block needs its own lines).
 *
 * The write goes through the *prototype* value setter on purpose: React keeps
 * its own value tracker on the instance, and a plain `ta.value = …` would be
 * recorded by that tracker, so the `input` event below would look like "no
 * change" and `onChange` would never run — the textarea would show the image
 * while React state (and the preview/save) kept the old markdown.
 */
export function insertTextAtCaret(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + text + ta.value.slice(end);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(ta, next);
  else ta.value = next;
  const caret = start + text.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Copy text to the clipboard, with a legacy fallback (SPEC §10.1 带题). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Pointer-capture drag for sidebar resize handles. Plain mousemove dies the
 * moment the cursor crosses the native AI webview overlay (a separate HWND
 * swallows the events), so the drag "stops halfway" — with pointer capture
 * the handle keeps receiving pointermove wherever the cursor goes.
 *
 * `computeWidth` turns a clientX into the new sidebar width; `onWidth` fires
 * live during the drag and `onEnd` once, with the final width, on release.
 */
export function dragWidth(
  handle: HTMLElement,
  ev: { pointerId: number; preventDefault(): void },
  computeWidth: (clientX: number) => number,
  onWidth: (w: number) => void,
  onEnd?: (w: number) => void,
): void {
  ev.preventDefault();
  let last = 0;
  // handle 与 document 都注册了监听器（pointer capture 可能不可用），而事件会从
  // handle 冒泡到 document —— 同一个 pointermove 会被派发两次。宽度值幂等，但每次
  // 都是一次 setState → 整页重渲染，拖动 AI 侧栏时正好把主线程拖住（t13：Bug3
  // 「点 AI 侧栏后一编辑就卡死」的候选路径之一）。按事件对象去重，一个指针事件
  // 只更新一次；pointerup 同理，避免 onEnd 落两次设置。
  const seen = new WeakSet<Event>();
  const onMove = (pe: PointerEvent) => {
    if (seen.has(pe)) return;
    seen.add(pe);
    last = Math.round(computeWidth(pe.clientX));
    onWidth(last);
  };
  const onUp = (pe: PointerEvent) => {
    if (seen.has(pe)) return;
    seen.add(pe);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    onEnd?.(last);
  };
  // Belt and suspenders: pointer capture routes events to the handle; the
  // document listeners still catch them if capture is unavailable.
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
  try {
    handle.setPointerCapture(ev.pointerId);
  } catch {
    // Without capture the drag still works while the cursor stays on us.
  }
}
