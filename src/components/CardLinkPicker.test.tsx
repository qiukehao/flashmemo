// @vitest-environment jsdom
// 需求 2 / SPEC §11.1 §11.2：复习弹窗内就地增删/改绑前置与后置关联。
// 关键不变式：弹窗里能改的只有**手动边**；同章节自动串联的邻居没有边可删，
// 界面必须说清这一点，并且任何删除都要一次明确确认（防误触）。
import { act, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import { api, type CardContext, type CardDto, type CardLinks } from "../lib/api";
import CardLinkPicker, {
  NextLinkActions,
  hasManualLinks,
  linkPairFor,
  manualIds,
  nextLinkSource,
  partitionRequires,
} from "./CardLinkPicker";
import ReviewPopup from "./ReviewPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORE_KEY = "flashmemo-mock-v1";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoke(): Invoke {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  return internals.invoke;
}

/** 手动边直接读 mock 的持久化存储——比 spy 更硬：命令没生效就一定红。 */
function storedLinks(): [number, number][] {
  const raw = localStorage.getItem(STORE_KEY);
  return raw ? ((JSON.parse(raw) as { links?: [number, number][] }).links ?? []) : [];
}

/** mock 的示例卡：1=事务隔离级别(MySQL/事务)、2=B+树(MySQL/索引)、3=InnoDB 锁(MySQL/锁)。 */
const C1 = 1;
const C2 = 2;
const C3 = 3;

async function clearAllLinks(): Promise<void> {
  const inv = invoke();
  for (const id of [C1, C2, C3, 100, 101]) {
    const links = (await inv("get_card_links", { cardId: id })) as CardLinks;
    for (const p of links.prev) await inv("remove_card_link", { fromId: p.id, toId: id });
    for (const n of links.next) await inv("remove_card_link", { fromId: id, toId: n.id });
  }
}

async function addEdge(from: number, to: number): Promise<void> {
  await invoke()("add_card_link", { fromId: from, toId: to });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ms = 260): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** React 会在实例上记 value tracker：直接 `input.value = x` 之后派发 input 事件
 *  会被当成"没变"，onChange 不触发（见 src/lib/dom.ts 的同类注释）。走原型 setter。 */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 等到条件成立（mock IPC 每次 80ms、搜索还有 250ms 防抖，固定 sleep 会 flaky）。 */
async function waitFor(check: () => boolean, what = "条件", timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await settle(60);
  }
  throw new Error(`waitFor 超时：${what}`);
}

async function mount(ui: ReactElement, ms = 200): Promise<HTMLDivElement> {
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
const click = async (el: Element | null | undefined, ms = 200) => {
  expect(el, "要点的元素不存在").toBeTruthy();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
  await settle(ms);
};

beforeAll(() => {
  installMockBackend();
});

beforeEach(async () => {
  await clearAllLinks();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

// --------------------------------------------------------------- 纯逻辑

describe("关联边的手势判定（SPEC §11.1 / §11.2）", () => {
  const card = (id: number, title: string): CardDto => ({
    id,
    deck: "MySQL",
    chapter: "事务",
    title,
    contentMd: "",
    state: "review",
    dueAt: "",
    needsAttention: false,
    level: 0,
    lapses: 0,
  });

  it("把「谁的前置/后置」翻译成有向边 (from → to)", () => {
    expect(linkPairFor(C1, "prev", C2)).toEqual([C2, C1]);
    expect(linkPairFor(C1, "next", C2)).toEqual([C1, C2]);
  });

  it("区分手动边与同章节自动邻居", () => {
    const manual = card(C2, "手动前置");
    const auto = card(9, "自动前置");
    const links: CardLinks = { prev: [manual], next: [] };
    expect([...manualIds(links, "prev")]).toEqual([C2]);
    expect(manualIds(null, "prev").size).toBe(0);

    const split = partitionRequires([manual, auto], links);
    expect(split.manual.map((c) => c.id)).toEqual([C2]);
    expect(split.auto.map((c) => c.id)).toEqual([9]);

    // 后置：手动边可删，章节顺序来的那条没有边可删。
    expect(nextLinkSource(card(C3, "手动后置"), { prev: [], next: [card(C3, "手动后置")] })).toBe("manual");
    expect(nextLinkSource(card(9, "自动后置"), { prev: [], next: [] })).toBe("chapter");
    expect(nextLinkSource(null, null)).toBeNull();
  });

  it("🔗 红点只认手动边（2026-10-09 修正）", () => {
    // 还没加载完 / 一条边都没有：不亮。
    expect(hasManualLinks(null)).toBe(false);
    expect(hasManualLinks({ prev: [], next: [] })).toBe(false);
    // 任一侧有手动边：亮。
    expect(hasManualLinks({ prev: [card(C1, "手动前置")], next: [] })).toBe(true);
    expect(hasManualLinks({ prev: [], next: [card(C1, "手动后置")] })).toBe(true);
  });
});

// --------------------------------------------------------------- 选择器

/** 受控外壳：模拟真实调用方（拉一次手动边，之后由 onLinks 更新）。 */
function PickerHarness({ cardId, deck }: { cardId: number; deck: string }) {
  const [links, setLinks] = useState<CardLinks | null>(null);
  useEffect(() => {
    void api.getCardLinks(cardId).then(setLinks).catch(() => setLinks(null));
  }, [cardId]);
  return <CardLinkPicker cardId={cardId} deck={deck} links={links} onLinks={setLinks} compact />;
}

describe("共享的链接卡片选择器（需求 2）", () => {
  it("列出前置/后置，删除必须二次确认（防误触）", async () => {
    await addEdge(C2, C1); // 2 → 1：卡片 1 的前置
    await addEdge(C1, C3); // 1 → 3：卡片 1 的后置
    const dom = await mount(<PickerHarness cardId={C1} deck="MySQL" />);

    const prevChip = dom.querySelector('[data-side="prev"]');
    const nextChip = dom.querySelector('[data-side="next"]');
    expect(prevChip?.textContent).toContain("B+ 树和 B 树的区别？");
    expect(nextChip?.textContent).toContain("InnoDB 有哪些锁？");

    // 第一次点击只是"要删"，还没删。
    await click(prevChip?.querySelector('[data-action="unlink"]'));
    expect(storedLinks()).toContainEqual([C2, C1]);
    expect(dom.querySelector('[data-action="confirm-remove"]')).toBeTruthy();

    // 「再想想」撤销。
    await click(dom.querySelector('[data-action="cancel-remove"]'));
    expect(dom.querySelector('[data-action="confirm-remove"]')).toBeNull();
    expect(storedLinks()).toContainEqual([C2, C1]);

    // 确认后才真的删掉，而且只剩这一条边被删。
    await click(prevChip?.querySelector('[data-action="unlink"]'));
    await click(dom.querySelector('[data-action="confirm-remove"]'));
    expect(storedLinks()).not.toContainEqual([C2, C1]);
    expect(storedLinks()).toContainEqual([C1, C3]);
    expect(dom.querySelector('[data-side="prev"]')).toBeNull();
  });

  it("搜索本包卡片并设为前置（边方向必须对）", async () => {
    const dom = await mount(<PickerHarness cardId={C1} deck="MySQL" />);
    await click(dom.querySelector('[data-action="open-search"]'), 100);
    const input = dom.querySelector<HTMLInputElement>('[data-testid="card-link-search"]')!;
    expect(input).toBeTruthy();
    await type(input, "锁");
    await waitFor(() => dom.querySelector(".link-result") !== null, "搜索结果");

    const result = dom.querySelector(".link-result");
    expect(result?.textContent).toContain("InnoDB 有哪些锁？");
    await click(result?.querySelector('[data-action="link-prev"]'));
    expect(storedLinks()).toContainEqual([C3, C1]);
  });

  it("改绑：先撤掉旧边，再建新边（不留下两条边）", async () => {
    await addEdge(C1, C3);
    const dom = await mount(<PickerHarness cardId={C1} deck="MySQL" />);

    await click(dom.querySelector('[data-side="next"] [data-action="rebind"]'), 100);
    expect(dom.querySelector('[data-testid="card-link-rebind-hint"]')).toBeTruthy();

    const input = dom.querySelector<HTMLInputElement>('[data-testid="card-link-search"]')!;
    await type(input, "B+ 树");
    await waitFor(() => dom.querySelector(".link-result") !== null, "搜索结果");
    const result = dom.querySelector(".link-result");
    await click(result?.querySelector('[data-action="link-next"]'), 400);

    expect(storedLinks()).toContainEqual([C1, C2]);
    expect(storedLinks()).not.toContainEqual([C1, C3]);
    expect(dom.querySelector('[data-side="next"]')?.textContent).toContain("B+ 树和 B 树的区别？");
  });
});

describe("「继续下一张」旁边的关联动作（SPEC §11.2）", () => {
  it("手动后置：一次确认后取消该关联", async () => {
    await addEdge(C1, C3);
    const links = await api.getCardLinks(C1);
    const next = await api.getCard(C3);
    const dom = await mount(
      <NextLinkActions cardId={C1} next={next} links={links} onRemoved={() => {}} />,
    );
    await click(dom.querySelector('[data-action="unlink-next"]'));
    expect(storedLinks()).toContainEqual([C1, C3]);
    await click(dom.querySelector('[data-action="confirm-unlink-next"]'));
    expect(storedLinks()).not.toContainEqual([C1, C3]);
  });

  it("同章节自动串联：没有边可删，只说明来源", async () => {
    const links = await api.getCardLinks(C1);
    const next = await api.getCard(C3);
    const dom = await mount(
      <NextLinkActions cardId={C1} next={next} links={links} onRemoved={() => {}} />,
    );
    expect(dom.querySelector('[data-action="unlink-next"]')).toBeNull();
    expect(dom.textContent).toContain("自动串联");
  });
});

// --------------------------------------------------------------- 验收：顶栏红点

describe("顶栏 🔗 红点只认手动前置/后置边（2026-10-09 用户反馈）", () => {
  it("只有同章节自动邻居时红点不亮（此前因 context 而常亮）", async () => {
    // C1 是 mock 队列的首张（MySQL/事务）。在同章节内加一张卡，制造「自动后置」：
    // 这正是用户遇到的场景——自己没设任何前后置，🔗 里前置/后置都是「无」。
    const sibling = (await invoke()("add_card", {
      deck: "MySQL",
      chapter: "事务",
      title: "事务自动邻居",
      contentMd: "同章节按顺序自动串联的一张卡",
    })) as CardDto;
    try {
      const ctx = (await invoke()("get_card_context", { cardId: C1 })) as CardContext;
      expect(ctx.next?.id, "前提：C1 确有同章节自动后置").toBe(sibling.id);
      expect(ctx.requires.map((c) => c.id), "前提：C1 没有前置").not.toContain(sibling.id);

      const dom = await mount(<ReviewPopup />, 300);
      await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
      // 手动边是异步拉的：等渲染稳定后再断言红点不存在。
      await settle(120);
      expect(
        dom.querySelector('[data-testid="popup-link-dot"]'),
        "自动邻居不是手动关联，红点不该亮",
      ).toBeNull();
    } finally {
      await invoke()("delete_card", { cardId: sibling.id });
    }
  }, 20000);

  it("手动加一条前置边后红点亮（🔗 面板里确实有内容）", async () => {
    await addEdge(C2, C1); // 2 → 1：C1 的手动前置
    const dom = await mount(<ReviewPopup />, 300);
    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    await waitFor(() => dom.querySelector('[data-testid="popup-link-dot"]') !== null, "红点");
  }, 20000);
});

// --------------------------------------------------------------- 验收：弹窗内取消后置

describe("复习弹窗内就地取消后置关联（需求 2 验收）", () => {
  it("取消 next 后 getCardContext/continueNext 立刻反映：不再排队、会话推进", async () => {
    await addEdge(C2, C1); // 知识铺垫（前置）
    await addEdge(C1, C3); // 继续下一张（后置）
    const dom = await mount(<ReviewPopup />, 300);

    await waitFor(() => (dom.textContent ?? "").includes("事务的隔离级别有哪些？"), "复习队列");
    // 知识铺垫与关联卡片 2026-10-07 起收进顶栏（📚 / 🔗），点开才渲染面板。
    // 入口本身要等 getCardContext 回来，所以先等按钮出现。
    await waitFor(() => dom.querySelector('[data-testid="popup-context-btn"]') !== null, "顶栏知识铺垫入口");
    await click(dom.querySelector('[data-testid="popup-context-btn"]'), 80);
    await waitFor(() => dom.querySelector(".popup-context") !== null, "知识铺垫面板");
    expect(dom.querySelector(".popup-context")?.textContent).toContain("B+ 树和 B 树的区别？");
    expect(dom.querySelector('[data-testid="popup-context-manual"]')).toBeTruthy();
    // 弹窗内可编辑关联的入口。
    await click(dom.querySelector('[data-testid="popup-links-btn"]'), 80);
    await waitFor(() => dom.querySelector('[data-testid="popup-links"]') !== null, "关联卡片面板");
    await click(dom.querySelector('[data-testid="popup-links-btn"]'), 80); // 收起，别挡住后面

    await click(btnByText(dom, "显示答案"), 200);
    await click(dom.querySelector(".popup-btn.familiar"), 400);
    await waitFor(() => (dom.textContent ?? "").includes("继续下一张：InnoDB 有哪些锁？"), "继续下一张");

    // 就地取消这条后置关联。
    await click(dom.querySelector('[data-action="unlink-next"]'), 80);
    await click(dom.querySelector('[data-action="confirm-unlink-next"]'), 120);

    // 1) 边真的没了 2) 不再提供续复习 3) 会话立刻推进到下一张（不停在已评分的卡上）
    await waitFor(() => !(dom.textContent ?? "").includes("继续下一张"), "续复习入口消失");
    expect(storedLinks()).not.toContainEqual([C1, C3]);
    expect(dom.textContent).toContain("第 2/3 张");
    // 前置关联没被误伤。
    expect(storedLinks()).toContainEqual([C2, C1]);
  }, 20000); // 真实弹窗挂载 + 多次 IPC，比单元用例慢，给足预算（不是掩盖 flaky）

  it("取消前置关联后「知识铺垫」就地不再显示那张卡", async () => {
    await addEdge(C2, C1);
    const dom = await mount(<ReviewPopup />, 300);
    await waitFor(() => dom.querySelector('[data-testid="popup-context-btn"]') !== null, "顶栏知识铺垫入口");
    await click(dom.querySelector('[data-testid="popup-context-btn"]'), 80);
    await waitFor(() => dom.querySelector(".popup-context") !== null, "知识铺垫面板");
    expect(dom.querySelector(".popup-context")?.textContent).toContain("B+ 树和 B 树的区别？");

    // 弹窗内的共享选择器：前置那一行的删除（两步确认）。
    await click(dom.querySelector('[data-testid="popup-links-btn"]'), 80);
    await waitFor(() => dom.querySelector('[data-testid="popup-links"]') !== null, "关联卡片面板");
    await click(dom.querySelector('[data-testid="popup-links"] [data-side="prev"] [data-action="unlink"]'), 80);
    await click(dom.querySelector('[data-testid="popup-links"] [data-action="confirm-remove"]'), 200);

    // 前置没了：知识铺垫面板不再渲染，连顶栏入口也一起消失（context 是异步刷新的）。
    await waitFor(
      () => dom.querySelector('[data-testid="popup-context-btn"]') === null,
      "知识铺垫入口消失",
    );
    expect(dom.querySelector(".popup-context")).toBeNull();
    expect(storedLinks()).not.toContainEqual([C2, C1]);
  }, 20000);
});
