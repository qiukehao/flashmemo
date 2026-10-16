// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dragWidth, insertImageAtCaret, insertTextAtCaret, isTextEntryTarget } from "./dom";
import { registerMockAttachment } from "./attachments";

describe("isTextEntryTarget", () => {
  it("treats the editable card and form fields as text entry", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editor.appendChild(span);
    document.body.appendChild(editor);
    expect(isTextEntryTarget(span)).toBe(true);
    expect(isTextEntryTarget(editor)).toBe(true);

    const input = document.createElement("input");
    expect(isTextEntryTarget(input)).toBe(true);
    const textarea = document.createElement("textarea");
    expect(isTextEntryTarget(textarea)).toBe(true);
  });

  it("lets shortcuts through everywhere else", () => {
    expect(isTextEntryTarget(document.body)).toBe(false);
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(isTextEntryTarget(button)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    // A read-only rendered card is not a text entry target.
    const readOnly = document.createElement("div");
    document.body.appendChild(readOnly);
    expect(isTextEntryTarget(readOnly)).toBe(false);
  });
});

describe("insertImageAtCaret (SPEC §9.4)", () => {
  function buildEditor(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it("inserts a stored image at the caret and keeps the markdown on the node", () => {
    registerMockAttachment("shot.png", "data:image/png;base64,AAAA");
    const root = buildEditor("<p>答案要点</p>");
    const text = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(insertImageAtCaret(root, "attachment:shot.png")).toBe(true);
    const img = root.querySelector("img")!;
    expect(img.getAttribute("data-md-src")).toBe("attachment:shot.png");
    expect(img.getAttribute("data-md-raw")).toBe("![图片](attachment:shot.png)");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("appends when the selection is outside the editor", () => {
    const root = buildEditor("<p>正文</p>");
    window.getSelection()!.removeAllRanges();
    expect(insertImageAtCaret(root, "attachment:other.png", "示意图")).toBe(true);
    const img = root.querySelector("img")!;
    expect(img.getAttribute("data-md-raw")).toBe("![示意图](attachment:other.png)");
    // Unknown ref: still inserted — it renders as the 图片未找到 placeholder.
    expect(img.getAttribute("src")).toBeNull();
  });
});

describe("insertTextAtCaret (AddCardPage textarea)", () => {
  it("inserts the passed markdown at the caret and fires input", () => {
    const ta = document.createElement("textarea");
    ta.value = "第一行";
    document.body.appendChild(ta);
    ta.setSelectionRange(5, 5);

    let fired = 0;
    ta.addEventListener("input", () => (fired += 1));
    insertTextAtCaret(ta, "\n\n![图片](attachment:x.png)\n\n");

    expect(ta.value).toBe("第一行\n\n![图片](attachment:x.png)\n\n");
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(fired).toBe(1);
  });

  it("replaces the current selection", () => {
    const ta = document.createElement("textarea");
    ta.value = "abcXYZ";
    ta.setSelectionRange(3, 6);
    insertTextAtCaret(ta, "!");
    expect(ta.value).toBe("abc!");
    expect(ta.selectionStart).toBe(4);
  });

  it("writes through the prototype setter so React's value tracker sees a change", () => {
    // Mimics React: an instance-level `value` property records every set, so a
    // direct `ta.value = …` would make the following input event a no-op.
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
    const ta = document.createElement("textarea");
    let trackerSets = 0;
    Object.defineProperty(ta, "value", {
      configurable: true,
      get: () => proto.get!.call(ta) as string,
      set: (v: string) => {
        trackerSets += 1;
        proto.set!.call(ta, v);
      },
    });
    insertTextAtCaret(ta, "X");
    expect(ta.value).toBe("X");
    expect(trackerSets).toBe(0);
  });
});

// t13：拖动侧栏时 handle 与 document 双注册会把同一次 pointermove 派发两次，
// 每次都是一次 setState → 整页重渲染（主线程被拖住，Bug3 的候选路径之一）。
describe("dragWidth（t13：一个指针事件只更新一次）", () => {
  function pointerEvent(type: string, init: MouseEventInit): Event {
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    return new Ctor(type, init);
  }

  it("冒泡导致的重复投递被去重，pointerup 也只收尾一次", () => {
    const handle = document.createElement("div");
    document.body.appendChild(handle);
    const widths: number[] = [];
    let ends = 0;
    dragWidth(
      handle,
      { pointerId: 1, preventDefault() {} },
      (x) => x,
      (w) => widths.push(w),
      () => (ends += 1),
    );

    handle.dispatchEvent(pointerEvent("pointermove", { bubbles: true, clientX: 300 }));
    handle.dispatchEvent(pointerEvent("pointermove", { bubbles: true, clientX: 340 }));
    handle.dispatchEvent(pointerEvent("pointerup", { bubbles: true }));

    expect(widths).toEqual([300, 340]);
    expect(ends).toBe(1);
    handle.remove();
  });
});

