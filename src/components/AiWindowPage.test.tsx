// @vitest-environment jsdom
// AI 独立窗口页面的原生 attach/resize 通道契约（2026-10-07 独立窗口重做）：
// 槽位没变绝不重复派发原生 set_bounds（ai_window_resize 是同步命令），变了才发。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock, logFrontendMock } = vi.hoisted(() => ({
  apiMock: {
    getSettings: vi.fn(async () => ({ ai_sites: "", ai_active_index: "0" })),
    setSettings: vi.fn(async () => {}),
    aiWindowAttach: vi.fn(async () => {}),
    aiWindowResize: vi.fn(async () => {}),
    aiWindowHide: vi.fn(async () => {}),
  },
  logFrontendMock: vi.fn(async () => {}),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));
vi.mock("../lib/env", () => ({ isTauri: () => true }));
vi.mock("../lib/logger", () => ({ logFrontend: logFrontendMock }));

import AiWindowPage from "./AiWindowPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  fire() {
    this.cb();
  }
}

/** Slot rect the component will measure (mutated by the tests). */
let slotRect = { x: 0, y: 44, width: 400, height: 560 };

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function installRectStub() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList?.contains("ai-webview-slot")) {
      return {
        ...slotRect,
        top: slotRect.y,
        left: slotRect.x,
        right: slotRect.x + slotRect.width,
        bottom: slotRect.y + slotRect.height,
        toJSON: () => slotRect,
      } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  FakeResizeObserver.instances = [];
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  slotRect = { x: 0, y: 44, width: 400, height: 560 };
  apiMock.aiWindowAttach.mockClear();
  apiMock.aiWindowResize.mockClear();
  apiMock.aiWindowHide.mockClear();
  logFrontendMock.mockClear();
});

async function mount() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  installRectStub();
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<AiWindowPage />);
  });
  // getSettings() 是异步的：等它落地后 effect 才会把槽位交给原生层。
  await act(async () => {
    await Promise.resolve();
  });
  return dom;
}

describe("AI 窗口的 attach / resize 通道", () => {
  it("挂载时 attach 一次，槽位没变就不重复调用原生层", async () => {
    await mount();
    expect(apiMock.aiWindowAttach).toHaveBeenCalledTimes(1);
    expect(apiMock.aiWindowAttach).toHaveBeenCalledWith(
      "https://chat.deepseek.com/",
      slotRect.x,
      slotRect.y,
      slotRect.width,
      slotRect.height,
    );
    const ro = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1]!;
    await act(async () => {
      ro.fire();
      ro.fire();
      window.dispatchEvent(new Event("resize"));
    });
    expect(apiMock.aiWindowResize).not.toHaveBeenCalled();
  });

  it("槽位真的变了才发一次 resize，并带上新坐标", async () => {
    await mount();
    const ro = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1]!;
    slotRect = { x: 0, y: 44, width: 560, height: 700 };
    await act(async () => {
      ro.fire();
    });
    expect(apiMock.aiWindowResize).toHaveBeenCalledTimes(1);
    expect(apiMock.aiWindowResize).toHaveBeenCalledWith(0, 44, 560, 700);
  });

  it("原生 resize 失败会写进日志，而不是静默吞掉", async () => {
    await mount();
    const ro = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1]!;
    apiMock.aiWindowResize.mockRejectedValueOnce(new Error("set_bounds failed"));
    slotRect = { x: 0, y: 44, width: 560, height: 700 };
    await act(async () => {
      ro.fire();
      await Promise.resolve();
    });
    expect(logFrontendMock).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("set_bounds failed"),
    );
  });

  it("「隐藏」按钮调用 ai_window_hide（隐藏不销毁，对话保留）", async () => {
    const dom = await mount();
    const hide = dom.querySelector<HTMLButtonElement>(".ai-window-head .btn");
    expect(hide?.textContent).toContain("隐藏");
    await act(async () => {
      hide?.click();
    });
    expect(apiMock.aiWindowHide).toHaveBeenCalledTimes(1);
  });
});
