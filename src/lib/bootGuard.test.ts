// @vitest-environment jsdom
// t13：React 挂载之前失败的白屏（bootstrap 抛错）也必须可读、可复制。
import { describe, expect, it, vi } from "vitest";
import { renderBootstrapFailure } from "./bootGuard";

function setupRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root") as HTMLElement;
}

describe("renderBootstrapFailure (t13)", () => {
  it("用原生 DOM 画出可读报错，而不是留一片空白", () => {
    const root = setupRoot();
    renderBootstrapFailure(new Error("db 打开失败"));

    const alert = root.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute("data-variant")).toBe("bootstrap");
    expect(root.textContent).toContain("启动失败");
    expect(root.textContent).toContain("db 打开失败");
    expect(root.textContent).toContain("复制诊断信息");
    expect(root.textContent).not.toBe("");
  });

  it("重复调用不会叠加多个报错页", () => {
    const root = setupRoot();
    renderBootstrapFailure(new Error("first"));
    renderBootstrapFailure(new Error("second"));

    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(root.textContent).toContain("second");
  });

  it("「复制诊断信息」把错误与环境写进剪贴板", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const root = setupRoot();
    renderBootstrapFailure(new Error("copy-me"));

    const copy = [...root.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("复制诊断信息"),
    );
    (copy as HTMLButtonElement).click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0];
    expect(text).toContain("[闪记 FlashMemo 启动失败]");
    expect(text).toContain("copy-me");
  });

  it("没有 #root 时不抛错（静默放弃，交给全局错误钩子记录）", () => {
    document.body.innerHTML = "";
    expect(() => renderBootstrapFailure(new Error("no root"))).not.toThrow();
  });
});
