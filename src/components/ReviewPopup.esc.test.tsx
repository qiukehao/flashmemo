// @vitest-environment jsdom
// 顶栏浮层（关联卡片 / 排版）打开时按 Esc：只关浮层，**不能**顺手把当前卡跳过。
// 背景（2026-10-25 真机模拟发现）：评分热键把 Escape 映射为「跳过」（SPEC §8.4），
// 而浮层打开时的守卫漏了「排版」面板；「关联/铺垫」面板虽然列在守卫里，但 React
// 同步 flush 后 window 监听器列表被换新，浏览器里同样守不住——所以守卫要挡
// **所有**浮层，且关浮层的 Esc 要在 document 层止住冒泡。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import ReviewPopup from "./ReviewPopup";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const STORE_KEY = "flashmemo-mock-v1";
const PAST = "2000-01-01T00:00:00.000Z";
let host: HTMLDivElement | null = null;
let root: Root | null = null;
async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function waitFor(check: () => boolean, what = "条件", timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await settle(60);
  }
  throw new Error(`waitFor 超时：${what}`);
}
async function mount(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const dom = host;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<ReviewPopup />);
  });
  await settle(300);
  return dom;
}
const pressEscape = async () => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await settle(150);
};
const frontTitle = (dom: ParentNode): string =>
  dom.querySelector(".popup-front")?.textContent ?? "";
beforeAll(async () => {
  // 两张到期卡：跳过/评分都会推进队列，用题面标题判断「卡有没有被顺手跳过」。
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      cards: [
        {
          id: 1,
          deck: "MySQL",
          chapter: "事务",
          title: "第一张卡",
          contentMd: "答案一",
          frontMd: "",
          state: "review",
          dueAt: PAST,
          needsAttention: false,
          level: 1,
          lapses: 0,
        },
        {
          id: 2,
          deck: "MySQL",
          chapter: "索引",
          title: "第二张卡",
          contentMd: "答案二",
          frontMd: "",
          state: "review",
          dueAt: PAST,
          needsAttention: false,
          level: 1,
          lapses: 0,
        },
      ],
      settings: { per_popup: "3" },
      nextId: 900,
      reviews: [],
      introduced: [],
      streaks: {},
      links: [],
      deckChain: {},
    }),
  );
  await import("../lib/mockBackend").then((m) => m.installMockBackend());
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});
describe("浮层打开时 Esc 只关浮层，不跳卡", () => {
  it("关联卡片浮层 + Esc：浮层关闭，题面还是第一张卡", async () => {
    const dom = await mount();
    await waitFor(() => dom.querySelector(".popup-reveal") !== null, "揭示按钮");
    expect(frontTitle(dom)).toContain("第一张卡");
    await act(async () => {
      dom.querySelector<HTMLButtonElement>('[data-testid="popup-links-btn"]')!.click();
    });
    await settle(150);
    await waitFor(
      () => dom.querySelector('[data-testid="popup-links"]') !== null,
      "关联卡片浮层打开",
    );
    await pressEscape();
    expect(dom.querySelector('[data-testid="popup-links"]'), "浮层应已关闭").toBeNull();
    expect(frontTitle(dom), "Esc 不能把当前卡跳过去").toContain("第一张卡");
  });
  it("排版浮层 + Esc：浮层关闭，题面还是第一张卡", async () => {
    const dom = await mount();
    await waitFor(() => dom.querySelector(".popup-reveal") !== null, "揭示按钮");
    await act(async () => {
      dom.querySelector<HTMLButtonElement>('[data-testid="popup-typo-btn"]')!.click();
    });
    await settle(150);
    await waitFor(() => dom.querySelector(".typo-popover") !== null, "排版浮层打开");
    await pressEscape();
    expect(dom.querySelector(".typo-popover"), "排版浮层应已关闭").toBeNull();
    expect(frontTitle(dom), "Esc 不能把当前卡跳过去").toContain("第一张卡");
  });
});
