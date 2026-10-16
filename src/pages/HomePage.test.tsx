// @vitest-environment jsdom
// Bug1 / t14：首页「待复习」必须与弹窗真正取到的卡**同源同时刻**。
// 用 mock 后端做可复现的对照检查（SPEC §14.1：待复习 = 现在就能进弹窗的候选池）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "../lib/api";
import { installMockBackend } from "../lib/mockBackend";
import HomePage from "./HomePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 与 Rust `services::per_popup_size` / mock `perPopupSize()` 同口径（默认 3，1~5）。 */
const PER_POPUP_DEFAULT = 3;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

/** mock 后端每次 invoke 有 80ms 延迟。 */
async function settle(ms = 320) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 首页上「待复习」那张统计卡显示的数字。 */
function dueNumber(dom: HTMLElement): number {
  const card = [...dom.querySelectorAll(".stat-card")].find((c) =>
    (c.textContent ?? "").includes("待复习"),
  );
  expect(card, "首页应有「待复习」统计卡").toBeTruthy();
  const num = card?.querySelector(".stat-num")?.textContent ?? "";
  return Number.parseInt(num, 10);
}

async function mountHome(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(
      <HomePage onNavigate={() => {}} onOpenCards={() => {}} onComposeExam={() => {}} />,
    );
  });
  await settle();
  return dom;
}

describe("主页「待复习」与弹窗取卡同源（Bug1 / t14）", () => {
  it("首页数字 = 待复习池大小；「立即复习」拿到的是 min(每次弹窗张数, 池)", async () => {
    const dom = await mountHome();

    const shown = dueNumber(dom);
    const pool = await api.dueCount();
    const queue = await api.reviewQueue();

    // 一个数：首页显示的就是池大小（同一条谓词，不是两套口径）。
    expect(shown).toBe(pool);
    // 弹窗是池的**配额切片**：不会多于池，也不会多于每次弹窗张数。
    expect(queue.length).toBe(Math.min(PER_POPUP_DEFAULT, pool));
    expect(queue.length).toBeLessThanOrEqual(shown);
  });

  it("数据变了以后回到主窗口：focus 立刻刷新同一来源，不停在旧数字上", async () => {
    const dom = await mountHome();
    const before = dueNumber(dom);
    expect(before).toBeGreaterThan(1);

    // 模拟"弹窗里处理掉一张"造成的数据变化。mock 的 rate_card 刻意不改 due_at
    // （只镜像等级/连击），所以这里用删除来改变池——被测的是刷新时机与来源。
    const queue = await api.reviewQueue();
    await api.deleteCard(queue[0].id);

    // 主窗口重新获得焦点（真机上就是从弹窗切回来）。
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    const after = dueNumber(dom);
    expect(after).toBe(before - 1);
    // 刷新后显示的仍然等于后端那一个数。
    expect(after).toBe(await api.dueCount());
  });

  it("从隐藏切回可见（visibilitychange）也会刷新，而不只是 focus", async () => {
    const dom = await mountHome();
    const before = dueNumber(dom);

    const queue = await api.reviewQueue();
    await api.deleteCard(queue[0].id);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(dueNumber(dom)).toBe(before - 1);
  });
});
