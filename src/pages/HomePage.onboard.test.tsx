// @vitest-environment jsdom
// 首启引导（2026-10-25）：空库时首页给出「导入示例卡包」主行动，点击后示例卡
// 进入库、统计刷新；有卡时引导不出现。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "../lib/api";
import HomePage from "./HomePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE_KEY = "flashmemo-mock-v1";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(async () => {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      cards: [],
      settings: { per_popup: "3" },
      nextId: 100,
      reviews: [],
      introduced: [],
      streaks: {},
      links: [],
      deckChain: {},
    }),
  );
  // mockBackend 在模块加载时就把 localStorage 读进内存——必须先种空库再动态导入。
  const mod = await import("../lib/mockBackend");
  mod.installMockBackend();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

async function settle(ms = 320) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function mountHome(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<HomePage onNavigate={() => {}} onOpenCards={() => {}} onComposeExam={() => {}} />);
  });
  await settle();
  return dom;
}

describe("首启引导（空库）", () => {
  it("空库显示「导入示例卡包」；点击后卡片进库、引导消失", async () => {
    const dom = await mountHome();
    const btn = [...dom.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("导入示例卡包"),
    );
    expect(btn, "空库应有示例卡包引导").toBeTruthy();

    await act(async () => {
      btn?.click();
    });
    await settle(600);

    const stats = await api.getStats();
    expect(stats.totalCards, "示例卡包应真的进库").toBeGreaterThan(0);
    expect(
      [...dom.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("导入示例卡包")),
      "导入成功、统计刷新后引导应当消失",
    ).toBe(false);
  });

  it("库里已有卡时不出现引导（老用户不受打扰）", async () => {
    // 前一个用例已导入示例卡 → 库非空。
    const dom = await mountHome();
    expect(
      [...dom.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("导入示例卡包")),
      "有卡时不应再显示空库引导",
    ).toBe(false);
  });
});
