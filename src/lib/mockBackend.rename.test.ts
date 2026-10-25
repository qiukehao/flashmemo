// @vitest-environment jsdom
// mock 的 `rename_deck` 必须镜像真后端 `services::rename_deck` 的契约：
// 空名 / 重名 / 包不存在都要报同样的中文错误（2026-10-25 浏览器模拟发现 mock
// 曾把卡包重命名成空串——真机不可能发生，调试模式却把它放行了）。
// 顺带锁住 deckChain 键迁移：真机 chain_by_order 是 deck 表的列，重命名天然保留。
import { beforeAll, describe, expect, it } from "vitest";

const STORE_KEY = "flashmemo-mock-v1";
const PAST = "2000-01-01T00:00:00.000Z";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let invoke: Invoke;

beforeAll(async () => {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      cards: [
        {
          id: 1,
          deck: "MySQL",
          chapter: "事务",
          title: "卡一",
          contentMd: "内容",
          frontMd: "",
          state: "review",
          dueAt: PAST,
          needsAttention: false,
          level: 1,
          lapses: 0,
        },
        {
          id: 2,
          deck: "Redis",
          chapter: "缓存",
          title: "卡二",
          contentMd: "内容",
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
      deckChain: { MySQL: false },
    }),
  );
  const mod = await import("./mockBackend");
  mod.installMockBackend();
  invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } })
    .__TAURI_INTERNALS__!.invoke;
});

describe("mock rename_deck 镜像 services::rename_deck", () => {
  it("空名与纯空白：报「卡包名不能为空」", async () => {
    await expect(invoke("rename_deck", { oldName: "MySQL", newName: "" })).rejects.toThrow(
      "卡包名不能为空",
    );
    await expect(invoke("rename_deck", { oldName: "MySQL", newName: "   " })).rejects.toThrow(
      "卡包名不能为空",
    );
  });

  it("重名：报「卡包名已存在」", async () => {
    await expect(invoke("rename_deck", { oldName: "MySQL", newName: "Redis" })).rejects.toThrow(
      "卡包名已存在",
    );
  });

  it("包不存在：报「卡包不存在」", async () => {
    await expect(
      invoke("rename_deck", { oldName: "不存在", newName: "X" }),
    ).rejects.toThrow("卡包不存在");
  });

  it("合法重命名：卡片迁移、首尾空白裁掉、deckChain 键跟着走", async () => {
    await invoke("rename_deck", { oldName: "MySQL", newName: "  数据库  " });
    const cards = (await invoke("list_cards", { deck: "数据库" })) as { id: number }[];
    expect(cards.map((c) => c.id)).toEqual([1]);
    // 串联状态经 list_overview.chainByOrder 暴露（没有单独的 get_deck_chain）。
    const overview = (await invoke("list_overview")) as {
      name: string;
      chainByOrder: boolean;
    }[];
    const db = overview.find((d) => d.name === "数据库");
    expect(db, "重命名后的卡包要在总览里").toBeTruthy();
    expect(db!.chainByOrder, "deckChain 的关闭状态要迁到新名下").toBe(false);
  });
});
