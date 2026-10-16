// @vitest-environment jsdom
// 需求 3 / SPEC §15.2：卡包工作区两列独立滚动——左列卡片列表与右列编辑面板
// 必须是两个不同的滚动容器（互不包含），否则滚动列表会把编辑面板一起带走。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import DecksPage from "./DecksPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** 等 mock 后端（每次 invoke 80ms 延迟）与 React 副作用结算完。 */
async function settle(ms = 260) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeAll(() => {
  installMockBackend();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** 渲染卡包管理页并打开第一个卡包的工作区。 */
async function openDeckWorkspace(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<DecksPage />);
  });
  await settle();

  const open = [...dom.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("打开工作区"),
  );
  expect(open, "卡包列表里应有「打开工作区」入口").toBeTruthy();
  await act(async () => {
    (open as HTMLButtonElement).click();
  });
  await settle();
  return dom;
}

describe("卡包工作区两列独立滚动（需求 3）", () => {
  it("左列列表与右列编辑面板是两个不同的滚动容器", async () => {
    const dom = await openDeckWorkspace();

    const list = dom.querySelector('[data-testid="deck-list-scroll"]');
    const detail = dom.querySelector('[data-testid="deck-detail-scroll"]');
    expect(list, "缺少卡片列表滚动容器").toBeTruthy();
    expect(detail, "缺少编辑面板滚动容器").toBeTruthy();
    expect(list).not.toBe(detail);

    // 互不包含：两个容器各自独立滚动，而不是一个套在另一个里。
    expect(list?.contains(detail ?? null)).toBe(false);
    expect(detail?.contains(list ?? null)).toBe(false);

    // 两列各自承载自己的内容：列表放卡片条目，编辑面板放所见即所得编辑器。
    expect(list?.querySelectorAll(".workspace-card-item").length ?? 0).toBeGreaterThan(0);
    expect(detail?.querySelector(".workspace-wysiwyg")).toBeTruthy();
  });

  it("两列共同挂在一个只负责分栏的外壳下", async () => {
    const dom = await openDeckWorkspace();
    const grid = dom.querySelector('[data-testid="deck-workspace"]');
    const list = dom.querySelector('[data-testid="deck-list-scroll"]');
    const detail = dom.querySelector('[data-testid="deck-detail-scroll"]');
    expect(grid, "缺少两列外壳").toBeTruthy();
    expect(grid?.contains(list ?? null)).toBe(true);
    expect(grid?.contains(detail ?? null)).toBe(true);
  });
});

// SPEC §5.2 rule 13：主窗口编辑器要能编辑题面（正面）——这是"长/图题面 +
// 结构化答案"唯一的入口，题面必须走 `update_card` 的 `frontMd` 参数落库。
describe("题面（正面）编辑区（rule 13）", () => {
  type Call = { cmd: string; args: Record<string, unknown> };

  /** 挂上 invoke 探针，跑一段编辑，返回期间发出的命令。 */
  async function capture(edit: () => Promise<void>): Promise<Call[]> {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => unknown };
      }
    ).__TAURI_INTERNALS__;
    expect(internals?.invoke, "mock 后端应已接管 invoke").toBeTruthy();
    const original = internals!.invoke;
    const calls: Call[] = [];
    internals!.invoke = (cmd: string, args?: unknown) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return original(cmd, args);
    };
    try {
      await edit();
      await settle(1400); // 800ms 防抖 + mock 后端 80ms 延迟
    } finally {
      internals!.invoke = original;
    }
    return calls;
  }

  it("编辑题面后 update_card 带上 frontMd", async () => {
    const dom = await openDeckWorkspace();
    const front = dom.querySelector<HTMLElement>(".workspace-front");
    expect(front, "工作区应有题面编辑区").toBeTruthy();

    const calls = await capture(async () => {
      await act(async () => {
        front!.innerHTML = "<p>一段话题目</p>";
        front!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
    });

    const update = calls.find((c) => c.cmd === "update_card");
    expect(update, "题面编辑应触发 update_card").toBeTruthy();
    expect(String(update!.args.frontMd)).toContain("一段话题目");
  });

  it("只改背面时不重写题面（frontMd 不下发）", async () => {
    const dom = await openDeckWorkspace();
    const back = dom.querySelector<HTMLElement>(".workspace-wysiwyg");
    expect(back, "工作区应挂载背面编辑器").toBeTruthy();

    const calls = await capture(async () => {
      await act(async () => {
        back!.innerHTML = "<p>只改了背面</p>";
        back!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
    });

    const update = calls.find((c) => c.cmd === "update_card");
    expect(update, "背面编辑应触发 update_card").toBeTruthy();
    // 没动题面就不该顺手改写它（front_md 的往返不是逐字节恒等）。
    expect(update!.args.frontMd).toBeUndefined();
  });
});

// Bug2（t12）：编辑器里出现零行 <table> 时，DOM→markdown 转换曾抛 TypeError，
// 自动保存的 Promise 直接 reject —— 用户的改动静默丢失，日志里只有
// `unhandled rejection`。这里锁住「异常不再逃逸，而且这次编辑真的写库了」。
describe("卡面保存链路的异常防护（Bug2 / t12）", () => {
  it("零行表格不会吞掉自动保存：不抛错且 update_card 真的被调用", async () => {
    const dom = await openDeckWorkspace();
    const editor = dom.querySelector<HTMLElement>(".workspace-wysiwyg");
    expect(editor, "工作区应挂载所见即所得编辑器").toBeTruthy();

    // 记录发往 mock 后端的命令，确认这次编辑真的落库（而不是被 catch 吞掉）。
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => unknown };
      }
    ).__TAURI_INTERNALS__;
    expect(internals?.invoke, "mock 后端应已接管 invoke").toBeTruthy();
    const original = internals!.invoke;
    const calls: string[] = [];
    internals!.invoke = (cmd: string, args?: unknown) => {
      calls.push(cmd);
      return original(cmd, args);
    };

    try {
      await act(async () => {
        editor!.innerHTML = "<p>保留我</p><table></table><p>也保留</p>";
        editor!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      await settle(1400); // 800ms 防抖 + mock 后端 80ms 延迟
    } finally {
      internals!.invoke = original;
    }

    expect(calls).toContain("update_card");
    expect(dom.textContent).not.toContain("保存失败");
  });
});

