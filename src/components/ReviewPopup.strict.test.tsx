// @vitest-environment jsdom
// strict 模式（SPEC §8.6「复习完所有卡片才能关闭」）的**前端半**：评完最后一张卡
// 时，会话正常收尾 —— `advance()` → `endSession("completed")` → 上报结局 → 关窗。
//
// 2026-10-07 语义更新：关窗从 `appWindow.close()`（会被 Rust 的 strict 分支
// `prevent_close` 拦下，窗口永远留在屏上——用户反馈「点结束本次没退出」）改成
// `appWindow.hide()`，不再经过 CloseRequested 通道。strict 拦的是**用户发起**的
// 关闭（Alt+F4），不拦已正常收尾的会话。jsdom 里 appWindow 为 null，hide 落不
// 到 invoke 上，所以这里锁的是前端可观测的契约：结局上报（completed）必须发生
// 且晚于评分；strict 的 UI 收口（徽标、无跳过、无 ✕）一并锁住。
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import ReviewPopup from "./ReviewPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE_KEY = "flashmemo-mock-v1";
const PAST = "2000-01-01T00:00:00.000Z";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
/** 记录本次测试发出的全部命令，用来断言"确实请求了关闭/确实评分了"。 */
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

/** 最后一条该命令的下标（-1 = 没发过）。`findLastIndex` 要 ES2023，本项目 lib 是 ES2020。 */
function lastIndexOfCmd(cmd: string): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].cmd === cmd) return i;
  }
  return -1;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, what = "条件", timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await settle(60);
  }
  throw new Error(`waitFor 超时：${what}`);
}

async function mount(ui: ReactElement, ms = 400): Promise<HTMLDivElement> {
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

const btnByText = (dom: ParentNode, text: string) =>
  [...dom.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));

const click = async (el: Element | null | undefined, ms = 250) => {
  expect(el, "要点的元素不存在").toBeTruthy();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
  await settle(ms);
};

beforeAll(async () => {
  // 1 张待复习卡 + 每次弹窗 1 张 + strict 关闭策略：评一张就走完整个会话。
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      cards: [
        {
          id: 1,
          deck: "MySQL",
          chapter: "事务",
          title: "只有一张卡",
          contentMd: "答案正文",
          frontMd: "",
          state: "review",
          dueAt: PAST,
          needsAttention: false,
          level: 1,
          lapses: 0,
        },
      ],
      settings: { per_popup: "1", close_policy: "strict" },
      nextId: 900,
      reviews: [],
      introduced: [],
      streaks: {},
      links: [],
      deckChain: {},
    }),
  );
  const mod = await import("../lib/mockBackend");
  mod.installMockBackend();
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } })
    .__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  const raw = internals.invoke;
  internals.invoke = ((cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    return raw(cmd, args);
  }) as Invoke;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe("strict 模式评完最后一张卡（SPEC §8.6）", () => {
  it("评完最后一张卡：正常收尾——结局上报 completed，且晚于评分", async () => {
    calls = [];
    const dom = await mount(<ReviewPopup />);

    // strict 上下文进了 UI：徽标出现，且退出入口（✕/跳过）被收起。
    await waitFor(() => dom.querySelector(".popup-reveal") !== null, "揭示按钮");
    expect(dom.querySelector(".popup-strict-badge"), "strict 徽标").toBeTruthy();
    expect(btnByText(dom, "跳过"), "strict 下不该有「跳过」").toBeUndefined();
    expect(
      dom.querySelector('button[title="关闭并跳过剩余"]'),
      "strict 下不该有「关闭并跳过剩余」的 ✕",
    ).toBeNull();
    expect(calls.some((c) => c.cmd === "close_context"), "应问过后端关闭策略").toBe(true);

    // 揭示 → 评分（这是队列里唯一的一张卡）。
    await click(dom.querySelector(".popup-reveal"));
    await click(btnByText(dom, "熟悉"), 300);

    await waitFor(
      () => calls.some((c) => c.cmd === "report_popup_session"),
      "会话结束时上报结局（report_popup_session）",
    );
    expect(calls.some((c) => c.cmd === "rate_card"), "评分必须真的发出").toBe(true);
    // 顺序也要对：评分先落库，再上报结局（结局里带着 rated 数）。
    expect(lastIndexOfCmd("report_popup_session"), "上报必须在评分之后").toBeGreaterThan(
      lastIndexOfCmd("rate_card"),
    );
    const report = calls[lastIndexOfCmd("report_popup_session")]!;
    expect(report.args.reason, "队列传完了 = completed").toBe("completed");
  });
});
