// @vitest-environment jsdom
// Bug5 / t12 要求：渲染期异常必须变成「可读报错 + 日志」，而不是一片白屏。
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logFrontendMock } = vi.hoisted(() => ({ logFrontendMock: vi.fn(async () => {}) }));
vi.mock("./lib/logger", () => ({ logFrontend: logFrontendMock }));

import { AppErrorBoundary } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  logFrontendMock.mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(node);
  });
  return dom;
}

describe("白屏护栏（Bug5 / t12）", () => {
  it("渲染期异常不再白屏：给出可读报错并写进日志", async () => {
    function Boom(): never {
      throw new Error("boom-render");
    }
    // React 会把捕获到的错误也打到 console.error，测试里静音。
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = await render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();

    const alert = dom.querySelector('[role="alert"]');
    expect(alert, "缺少可读报错面板（这就是白屏）").toBeTruthy();
    expect(dom.textContent).toContain("界面出错了");
    expect(dom.textContent).toContain("boom-render");
    expect(logFrontendMock).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("boom-render"),
    );
  });

  it("重试按钮清掉错误态并重新渲染子树", async () => {
    let failing = true;
    function Flaky() {
      if (failing) throw new Error("boom-once");
      return <p>恢复正常</p>;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = await render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();
    expect(dom.querySelector('[role="alert"]')).toBeTruthy();

    failing = false;
    const retry = [...dom.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("重试"),
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      (retry as HTMLButtonElement).click();
    });

    expect(dom.querySelector('[role="alert"]')).toBeNull();
    expect(dom.textContent).toContain("恢复正常");
  });

  it("正常子树原样渲染，不引入任何包装 DOM", async () => {
    const dom = await render(
      <AppErrorBoundary>
        <p>正常内容</p>
      </AppErrorBoundary>,
    );
    expect(dom.querySelector('[role="alert"]')).toBeNull();
    expect(dom.textContent).toBe("正常内容");
  });
});

// t13：白屏护栏的「可复制」与「两个窗口各一处」。
describe("白屏护栏的出口与诊断（t13）", () => {
  it("主窗口变体：重试 / 复制诊断信息 / 重新加载，不给「关闭弹窗」", async () => {
    function Boom(): never {
      throw new Error("main-boom");
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = await render(
      <AppErrorBoundary variant="main">
        <Boom />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();

    const labels = [...dom.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["重试", "复制诊断信息", "重新加载"]);
    expect(dom.querySelector('[role="alert"]')?.getAttribute("data-variant")).toBe("main");
    // 日志里带上变体名，日志文件能区分是哪个窗口崩的。
    expect(logFrontendMock).toHaveBeenCalledWith("error", expect.stringContaining("(main)"));
  });

  it("复习弹窗变体：额外给「关闭弹窗」，否则用户卡在点不动的窗口里", async () => {
    function Boom(): never {
      throw new Error("popup-boom");
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = await render(
      <AppErrorBoundary variant="popup">
        <Boom />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();

    const labels = [...dom.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("关闭弹窗");
    expect(dom.querySelector('[role="alert"]')?.getAttribute("data-variant")).toBe("popup");
    expect(logFrontendMock).toHaveBeenCalledWith("error", expect.stringContaining("(popup)"));
  });

  it("「复制诊断信息」把报错与组件栈写进剪贴板", async () => {
    function Boom(): never {
      throw new Error("copy-me");
    }
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = await render(
      <AppErrorBoundary variant="popup">
        <Boom />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();

    const copy = [...dom.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("复制诊断信息"),
    );
    await act(async () => {
      (copy as HTMLButtonElement).click();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("[闪记 FlashMemo 报错]");
    expect(text).toContain("窗口: popup");
    expect(text).toContain("copy-me");
  });
});

