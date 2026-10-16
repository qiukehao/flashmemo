// @vitest-environment jsdom
// Bug4（t9）：点「📝 备注」必须真的插入备注块（白屏 Bug 的 DOM 层不变式）。
//
// 2026-10-07 起弹窗里不再内嵌 AI 侧栏（改为独立窗口），但本文件锁死的 DOM
// 层不变式依然成立：
//   1. 点「备注」必须**真的**插入一个可见的备注块 —— 不能因为光标不在卡面里
//      （刚点过按钮/别的元素，选区就没了）而静默什么都不做；
//   2. 有选区 → 就地包块；无选区 → 末尾插块；防抖落盘、%%…%% 回写一致；
//   3. 整条路径不产生任何未捕获错误 / 未处理拒绝（"白屏"的可观测定义）；
//   4. 编辑走自定义撤销栈：批注动作是直接 DOM 手术，Ctrl+Z 必须能退掉。
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import EditContextMenu from "./EditContextMenu";
import ReviewPopup from "./ReviewPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C1 = 1;

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoke(): Invoke {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  return internals.invoke;
}

async function contentMdOf(cardId: number): Promise<string | null> {
  const card = (await invoke()("get_card", { cardId })) as { contentMd?: string } | null;
  return card?.contentMd ?? null;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, what = "条件", timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await settle(60);
  }
  throw new Error(`waitFor 超时：${what}`);
}

async function mount(ui: ReactElement, ms = 300): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const dom = host;
  root = createRoot(dom);
  await act(async () => {
    root?.render(ui);
  });
  await settle(ms);
  return dom;
}

const click = async (el: Element | null | undefined, ms = 200) => {
  expect(el, "要点的元素不存在").toBeTruthy();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
  await settle(ms);
};

const btnByText = (dom: ParentNode, text: string) =>
  [...dom.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));

/** 右键卡面（弹窗的 onContextMenu 据此打开批注菜单）。 */
async function openContextMenu(editor: HTMLElement, x = 120, y = 200): Promise<void> {
  await act(async () => {
    editor.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
  await settle(120);
}

/** 把光标放进卡面的最后一段（模拟"用户刚在卡面里点了字"）。 */
function caretAtEnd(editor: HTMLElement): void {
  const block = editor.querySelector("p, li, h1, h2, h3, h4, div") ?? editor;
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 清掉选区（模拟侧栏拿走焦点后 DOM 选区消失）。 */
function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

let consoleErrors: unknown[][] = [];
let pageErrors: string[] = [];
let onError: ((e: ErrorEvent) => void) | null = null;
let onRejection: ((e: PromiseRejectionEvent) => void) | null = null;

beforeAll(() => {
  installMockBackend();
});

beforeEach(() => {
  consoleErrors = [];
  pageErrors = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
    originalError(...(args as []));
  };
  onError = (e: ErrorEvent) => pageErrors.push(`window.onerror: ${e.message}`);
  onRejection = (e: PromiseRejectionEvent) => pageErrors.push(`unhandledrejection: ${String(e.reason)}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
});

afterEach(() => {
  if (onError) window.removeEventListener("error", onError);
  if (onRejection) window.removeEventListener("unhandledrejection", onRejection);
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** 卡面里的备注块数量。示例卡本来就有 `%%…%%`（渲染成 .card-note），
 *  所以必须比较前后数量，不能用"存在 .card-note"当断言（那样永远为真）。 */
const noteCount = (dom: ParentNode) =>
  dom.querySelectorAll(".popup-edit-wysiwyg .card-note").length;

describe("Bug4：点「📝 备注」（SPEC §9.2 / §9.3）", () => {
  it("光标在卡面里：插入一个新的备注块", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;
    caretAtEnd(editor);
    const before = noteCount(dom);

    await openContextMenu(editor);
    await click(dom.querySelector('[aria-label="备注"]'), 150);

    expect(noteCount(dom), "卡面里应多出一个备注块").toBe(before + 1);
    expect(pageErrors).toEqual([]);
  }, 20000);

  it("焦点不在卡面里（选区丢失）：备注依然插入 —— 不能静默无操作", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    // 焦点被卡面之外的元素拿走（例如刚点过顶栏按钮），DOM 选区消失。
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;
    (dom.querySelector(".popup-header-actions button") as HTMLButtonElement | null)?.focus();
    clearSelection();
    const before = noteCount(dom);

    await openContextMenu(editor);
    await click(dom.querySelector('[aria-label="备注"]'), 150);

    // 复现点：insertNoteBlock 在 rangeCount === 0 时静默 return false，
    // 用户点了「备注」什么也没看见。
    expect(noteCount(dom), "焦点丢失时点备注也必须真的插入备注块").toBe(before + 1);
    expect(pageErrors).toEqual([]);
  }, 20000);

  it("Ctrl+Z 能退掉刚插入的备注块（批注动作是 DOM 手术，原生撤销栈靠不住）", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;
    caretAtEnd(editor);
    const before = noteCount(dom);

    await openContextMenu(editor);
    await click(dom.querySelector('[aria-label="备注"]'), 150);
    expect(noteCount(dom), "插入备注块").toBe(before + 1);

    // 撤销：Ctrl+Z 退回插入前的快照。
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await settle(100);
    expect(noteCount(dom), "Ctrl+Z 后备注块应消失").toBe(before);

    // 重做：Ctrl+Shift+Z 把它找回来。
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle(100);
    expect(noteCount(dom), "Ctrl+Shift+Z 后备注块应回来").toBe(before + 1);
    expect(pageErrors).toEqual([]);
  }, 20000);

  it("有选中文字：原文一字不动，段落后插入批注（2026-10-07 非破坏语义）", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;

    // 选中一段正文，然后点「备注」。
    const target = editor.querySelectorAll("p")[0] ?? editor;
    const selectedText = target.textContent ?? "";
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const beforeCount = noteCount(dom);
    await openContextMenu(editor);
    await click(dom.querySelector('[aria-label="备注"]'), 150);

    // 原文必须原样保留（旧语义会把选中文字卷进备注 = "答案被改"）。
    expect(editor.textContent, "选中的正文不能被备注吃掉").toContain(selectedText.trim());
    expect(noteCount(dom), "段落后面多出一条批注").toBe(beforeCount + 1);
    expect(pageErrors).toEqual([]);
  }, 20000);

  it("批注里打字后按防抖落盘为 %%…%%（保存语义不变）", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;

    caretAtEnd(editor);
    await openContextMenu(editor);
    const beforeCount = noteCount(dom);
    await click(dom.querySelector('[aria-label="备注"]'), 150);
    expect(noteCount(dom), "先确认空批注已插入").toBe(beforeCount + 1);
    // 新插入的批注就是文本只有图标的那条；模拟打字（jsdom 没有 execCommand，
    // 直接改 DOM + input 事件，与真实 onInput 路径一致）。
    const chip = [...editor.querySelectorAll(".card-note")].find(
      (n) => (n.textContent ?? "").trim() === "📝",
    )!;
    chip.appendChild(document.createTextNode("悬浮批注内容"));
    await act(async () => {
      chip.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(1200); // 800ms 防抖 + mock 80ms

    const after = (await contentMdOf(C1)) ?? "";
    expect(after).toContain("%%悬浮批注内容%%");
    expect(pageErrors).toEqual([]);
  }, 20000);

  it("悬浮批注摘要条弹出全文浮层，移开后收起（2026-10-07 用户反馈）", async () => {
    const dom = await mount(<ReviewPopup />);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await click(btnByText(dom, "显示答案"), 150);
    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;
    const note = editor.querySelector<HTMLElement>(".card-note")!;
    const noteText = (note.textContent ?? "").replace("📝", "").trim();

    await act(async () => {
      note.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await settle(80);
    const pop = document.body.querySelector(".note-popover");
    expect(pop, "悬浮摘要条应弹出全文浮层").toBeTruthy();
    expect(pop?.textContent ?? "").toContain(noteText);

    await act(async () => {
      note.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    await settle(600); // 400ms 离开缓冲
    expect(document.body.querySelector(".note-popover"), "移开后浮层应收起").toBeNull();
    expect(pageErrors).toEqual([]);
  }, 20000);
});

describe("菜单动作抛错不打崩整棵子树（Bug4「白屏」的可观测定义）", () => {
  it("动作抛错时菜单留在原地、给出提示，并写进日志", async () => {
    const dom = await mount(
      <EditContextMenu
        x={40}
        y={40}
        editor={document.createElement("div")}
        collapsed
        onNote={() => {
          throw new Error("boom");
        }}
        onPickImage={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
      120,
    );
    await click(dom.querySelector('[aria-label="备注"]'), 200);

    // 旧行为：异常从 onClick 逃逸 → React 卸载子树（= 用户看到的白屏）。
    expect(dom.querySelector(".edit-context-menu"), "菜单不应被卸载").toBeTruthy();
    expect(dom.querySelector(".edit-context-hintline")?.textContent).toContain("没成功");
    expect(pageErrors).toEqual([]); // 没有逃逸到 window
    expect(consoleErrors.flat().join(" ")).toContain("edit menu action failed");
  }, 20000);
});

describe("右键菜单不伸进原生侧栏区（Bug4 候选 C1）", () => {
  it("给了卡面列边界时，菜单被钳在列内", async () => {
    const dom = await mount(
      <EditContextMenu
        x={900}
        y={120}
        editor={document.createElement("div")}
        collapsed
        bounds={{ left: 0, right: 400 }}
        onNote={() => {}}
        onPickImage={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
      120,
    );
    const menu = dom.querySelector<HTMLElement>(".edit-context-menu")!;
    // 252 是菜单估算宽度：左边界必须落在卡面列内（右边界留 8px 余量）。
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(400 - 252 - 8);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
  }, 20000);

  it("没有边界（侧栏关闭）时保持原有视口钳位", async () => {
    const dom = await mount(
      <EditContextMenu
        x={900}
        y={120}
        editor={document.createElement("div")}
        collapsed
        onNote={() => {}}
        onPickImage={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
      120,
    );
    const menu = dom.querySelector<HTMLElement>(".edit-context-menu")!;
    expect(Number.parseFloat(menu.style.left)).toBe(window.innerWidth - 252 - 8);
  }, 20000);
});
