// @vitest-environment jsdom
// Bug1 / F5（t5）：SPEC §14.1 的「待复习」在浏览器调试模式里也只能**有一个来源**。
// 本文件不看实现，只看四个数字与「立即复习」实际拿到的卡：
//   首页 get_stats.dueCount / due_count / goal_status.dueCount / 各包 dueCount 之和
// 必须相等，且弹窗队列只能是这个池的子集——归档、暂停、未到期、计数器门槛没开的
// 卡两边都不算。
//
// 修复前的反例（本文件前两个用例在修复前必然红）：mock 的 `due_count` 返回的是
// `cards.length`（连归档/暂停都算），`review_queue` 直接取前 N 张，所以"数字里有、
// 队列里没有"和"队列里有归档卡、数字里没有"会同时出现。
import { beforeAll, describe, expect, it } from "vitest";

const STORE_KEY = "flashmemo-mock-v1";
/** 远在过去 / 远在未来：判定只看与 now 的大小关系，测试不依赖机器时钟。 */
const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

interface SeedCard {
  id: number;
  deck: string;
  chapter: string;
  title: string;
  contentMd: string;
  state: string;
  dueAt: string;
  needsAttention: boolean;
  level: number;
  lapses: number;
  /** 真机字段 `next_eligible_seq`（mock 卡片可选带上，见 mockBackend 的说明）。 */
  nextEligibleSeq?: number;
}

function card(
  id: number,
  deck: string,
  chapter: string,
  state: string,
  dueAt: string,
  nextEligibleSeq?: number,
): SeedCard {
  return {
    id,
    deck,
    chapter,
    title: `${deck}·${chapter} #${id}`,
    contentMd: "内容",
    state,
    dueAt,
    needsAttention: false,
    // 与真机一致：`state='new'` 的卡必然是 level 0（`reps=0 AND level=0` 才是新卡）。
    level: state === "new" ? 0 : 1,
    lapses: 0,
    ...(nextEligibleSeq == null ? {} : { nextEligibleSeq }),
  };
}

/** 6 张卡：1、2 正常待复习；3 归档；4 暂停；5 未到期；6 计数器门槛没开。 */
const SEED: SeedCard[] = [
  card(1, "MySQL", "事务", "review", PAST),
  card(2, "MySQL", "索引", "new", PAST),
  card(3, "MySQL", "锁", "archived", PAST),
  card(4, "Redis", "缓存", "suspended", PAST),
  card(5, "Redis", "持久化", "review", FUTURE),
  card(6, "Redis", "集群", "review", PAST, 2),
];

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let invoke: Invoke;
/** 纯逻辑镜像（`services::session_size` / `DODGE_PENALTY_STREAK`），同样从
 *  动态导入拿——静态 import 会在种数据之前把模块求值掉。 */
let sessionSize: (perPopup: number, dodgeCap: number) => number;
let DODGE_PENALTY_STREAK: number;

beforeAll(async () => {
  // 先种数据再导入：mockBackend 在模块加载时把 localStorage 里的卡片读进内存，
  // 这样示例卡（固定日期）不会让本文件的期望值随机器时钟漂移。
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      cards: SEED,
      settings: { per_popup: "3" },
      nextId: 900,
      reviews: [],
      streaks: {},
      links: [],
      deckChain: {},
    }),
  );
  const mod = await import("./mockBackend");
  mod.installMockBackend();
  sessionSize = mod.sessionSize;
  DODGE_PENALTY_STREAK = mod.DODGE_PENALTY_STREAK;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } })
    .__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  invoke = internals.invoke;
});

const ids = (list: unknown): number[] => (list as { id: number }[]).map((c) => c.id);
const count = () => invoke("due_count") as Promise<number>;

describe("「待复习」在 mock 里只有一个来源（SPEC §14.1 / Bug1）", () => {
  it("首页数字、due_count、今日目标、各包之和是同一个数", async () => {
    const stats = (await invoke("get_stats")) as { dueCount: number };
    const goal = (await invoke("goal_status")) as { dueCount: number };
    const overview = (await invoke("list_overview")) as { dueCount: number }[];
    const perDeckSum = overview.reduce((n, o) => n + o.dueCount, 0);

    // 归档(3)/暂停(4)/未到期(5)/门槛没开(6) 都不算，池里只剩 1、2。
    expect(stats.dueCount).toBe(2);
    expect(await count()).toBe(2);
    expect(goal.dueCount).toBe(2);
    expect(perDeckSum).toBe(2);
  });

  it("「立即复习」拿到的卡是这个数字的子集，归档/暂停卡两边都不算", async () => {
    const queue = ids(await invoke("review_queue"));
    const due = await count();

    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThanOrEqual(due);
    expect(queue).toEqual([1, 2]);
    for (const bad of [3, 4, 5, 6]) expect(queue).not.toContain(bad);
  });

  it("due_queue 与「到期」筛选同样只给这个池，归档只出现在自己的筛选项里", async () => {
    expect(ids(await invoke("due_queue", { limit: 99 }))).toEqual([1, 2]);
    expect(ids(await invoke("search_cards", { filter: "due" }))).toEqual([1, 2]);
    expect(ids(await invoke("search_cards", { filter: "archived" }))).toEqual([3]);
  });

  it("计数器门槛没开就不算待复习，展示计数走完才放行（next_eligible_seq）", async () => {
    expect(await count()).toBe(2);

    await invoke("mark_card_shown", { cardId: 1 });
    expect(await count()).toBe(2); // seq=1，卡 6 的门槛是 2，仍被挡

    await invoke("mark_card_shown", { cardId: 2 });
    expect(await count()).toBe(3); // seq=2 → 卡 6 进池
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);
  });

  it("一次弹窗 = min(设置里的 N, 池)，且 goal_status.perPopup 是同一个 N（SPEC §7.4）", async () => {
    await invoke("set_settings", { map: { per_popup: "5" } });
    expect(((await invoke("goal_status")) as { perPopup: number }).perPopup).toBe(5);
    // 池只有 3 张：给满池，不补空、也不静默降级成别的张数。
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);

    // 越界与乱码被夹回 1..5，两边仍是同一个 N。
    await invoke("set_settings", { map: { per_popup: "99" } });
    expect(((await invoke("goal_status")) as { perPopup: number }).perPopup).toBe(5);
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);

    await invoke("set_settings", { map: { per_popup: "abc" } });
    expect(((await invoke("goal_status")) as { perPopup: number }).perPopup).toBe(3);
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);
  });
});

// 以下用例承接上面的会话状态（showSeq=2，所以池是 1、2、6），按声明顺序执行。
describe("逃避惩罚的封顶（SPEC §7.4 / §7.9）", () => {
  it("sessionSize 与 Rust 的 session_size 同一组断言：封顶不是覆盖", () => {
    expect(DODGE_PENALTY_STREAK).toBe(3);
    expect(sessionSize(4, 0)).toBe(4); // 无惩罚：用户设置说了算
    expect(sessionSize(4, 1)).toBe(1); // 惩罚把一次会话封到 1 张
    expect(sessionSize(1, 3)).toBe(1); // 封顶不抬升：绝不会把 1 张变成 3 张
    expect(sessionSize(9, 0)).toBe(5); // 夹到 1..5
    expect(sessionSize(0, 0)).toBe(1); // 永远不是 0 张
  });

  it("连续 3 次未评分关闭后自动弹窗只出 1 张，有评分就回落", async () => {
    await invoke("set_settings", { map: { per_popup: "3" } });
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);

    for (let i = 0; i < DODGE_PENALTY_STREAK; i++) {
      await invoke("report_popup_session", { reason: "closed", rated: 0, origin: "auto" });
    }
    expect(((await invoke("close_context")) as { dodgeStreak: number }).dodgeStreak).toBeGreaterThanOrEqual(
      DODGE_PENALTY_STREAK,
    );
    expect(ids(await invoke("review_queue"))).toEqual([1]); // 封到 1 张

    // streak 只统计未评分关闭：一次真实评分即回落。
    await invoke("report_popup_session", { reason: "completed", rated: 1, origin: "auto" });
    expect(((await invoke("close_context")) as { dodgeStreak: number }).dodgeStreak).toBe(0);
    expect(ids(await invoke("review_queue"))).toEqual([1, 2, 6]);
  });

  it("封顶只作用于自动弹窗：显式卡表（复习选中/组卷）一张不少", async () => {
    for (let i = 0; i < DODGE_PENALTY_STREAK; i++) {
      await invoke("report_popup_session", { reason: "closed", rated: 0, origin: "auto" });
    }
    // 显式卡表里故意放归档卡 3 与暂停卡 4：手动入口按用户点选整份服务，
    // 不套 due 谓词、也不套封顶（真机同样如此）。
    // 注：`start_review` 在浏览器 mock 里靠切换 URL 打开弹窗视图，jsdom 会打一行
    // "Not implemented: navigation to another Document" —— 预期噪音，不是失败。
    await invoke("start_review", { cardIds: [3, 4] });
    expect(ids(await invoke("review_queue"))).toEqual([3, 4]);

    await invoke("report_popup_session", { reason: "completed", rated: 1, origin: "auto" });
    expect(((await invoke("close_context")) as { dodgeStreak: number }).dodgeStreak).toBe(0);
  });
});

describe("需求7 题面字段（frontMd）的透传", () => {
  it("题面在所有读路径上原样带过，背面保存不会清掉它", async () => {
    const front = "![架构图](attachment:x.png)\n下面这句话是什么？";
    const updated = (await invoke("update_card", { cardId: 1, frontMd: front })) as {
      frontMd?: string;
    };
    expect(updated.frontMd).toBe(front);

    expect(((await invoke("get_card", { cardId: 1 })) as { frontMd?: string }).frontMd).toBe(front);
    const listed = (await invoke("list_cards", { deck: "MySQL" })) as {
      id: number;
      frontMd?: string;
    }[];
    expect(listed.find((c) => c.id === 1)?.frontMd).toBe(front);
    const queue = (await invoke("review_queue")) as { id: number; frontMd?: string }[];
    expect(queue.find((c) => c.id === 1)?.frontMd).toBe(front);

    // 搜索要能按题干命中（真机 db::search_cards 也搜 front_md）。
    expect(ids(await invoke("search_cards", { query: "架构图" }))).toEqual([1]);

    // 弹窗里的背面自动保存只动 contentMd，不能顺手把题面抹掉。
    await invoke("save_card_content", { cardId: 1, contentMd: "改过的背面" });
    expect(((await invoke("get_card", { cardId: 1 })) as { frontMd?: string }).frontMd).toBe(front);
    // 不传 frontMd 的编辑也不动题面。
    await invoke("update_card", { cardId: 1, title: "改了标题", contentMd: "改过的背面" });
    expect(((await invoke("get_card", { cardId: 1 })) as { frontMd?: string }).frontMd).toBe(front);
  });

  it("搜索基线：暂停卡在任何筛选项里都不出现（真机 WHERE state != 'suspended'）", async () => {
    const all = ids(await invoke("search_cards", { filter: "all" }));
    expect(all).toContain(1);
    expect(all).not.toContain(4); // 卡 4 是 suspended
    expect(ids(await invoke("search_cards", { filter: "new" }))).not.toContain(4);
    expect(ids(await invoke("search_cards", { filter: "review" }))).not.toContain(4);
  });

  it("新建卡：普通卡题面是空串（正面回退 title），显式传了就带上", async () => {
    const plain = (await invoke("add_card", {
      deck: "MySQL",
      chapter: "事务",
      title: "普通卡",
      contentMd: "背面",
    })) as { frontMd?: string };
    expect(plain.frontMd).toBe("");

    const rich = (await invoke("add_card", {
      deck: "MySQL",
      chapter: "事务",
      title: "题面卡",
      contentMd: "背面",
      frontMd: "![图](attachment:y.png)",
    })) as { frontMd?: string };
    expect(rich.frontMd).toBe("![图](attachment:y.png)");
  });

  // SPEC §5.2 rule 13 / services::add_card_with_front 的镜像：标题可留空（由题面
  // 投影生成），同章节重名自动加后缀（纯图片题面投影成 🖼，两张就会撞 UNIQUE）。
  it("新建卡：标题留空由题面投影生成，重名自动加后缀", async () => {
    const derived = (await invoke("add_card", {
      deck: "刷题",
      chapter: "LeetCode",
      title: "  ",
      contentMd: "",
      frontMd: "![题面](attachment:p.png)\n这题怎么解？",
    })) as { title: string; frontMd?: string };
    expect(derived.title).toBe("🖼 · 这题怎么解？");
    expect(derived.frontMd).toBe("![题面](attachment:p.png)\n这题怎么解？");

    const first = (await invoke("add_card", {
      deck: "刷题",
      chapter: "LeetCode",
      title: "",
      contentMd: "",
      frontMd: "![图](attachment:a.png)",
    })) as { title: string };
    const second = (await invoke("add_card", {
      deck: "刷题",
      chapter: "LeetCode",
      title: "",
      contentMd: "",
      frontMd: "![图](attachment:b.png)",
    })) as { title: string };
    expect(first.title).toBe("🖼");
    expect(second.title).toBe("🖼 #2");

    await expect(
      invoke("add_card", { deck: "刷题", chapter: "LeetCode", title: "", contentMd: "", frontMd: "" }),
    ).rejects.toThrow(/标题不能为空/);
  });

  it("rule 13 浏览器导入镜像：`> [!question]` 拆成题面 + 背面", async () => {    const res = (await invoke("import_markdown", {
      files: [
        {
          name: "刷题.md",
          content:
            "# 刷题包\n\n## LC\n\n### LC146 LRU 缓存\n> [!question]\n> 设计 LRU 数据结构\n> ![题面](lc146.png)\n\n思路：哈希表 + 双向链表\n",
        },
      ],
    })) as { added: number };
    expect(res.added).toBe(1);

    const cards = (await invoke("list_cards", { deck: "刷题包" })) as {
      title: string;
      frontMd?: string;
      contentMd?: string;
    }[];
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("LC146 LRU 缓存");
    expect(cards[0].frontMd).toBe("设计 LRU 数据结构\n![题面](lc146.png)");
    expect(cards[0].contentMd).toBe("思路：哈希表 + 双向链表");
  });

  // 浏览器没有附件目录：卡面里的 `attachment:` 若不补占位图，就会全渲染成"图片未找到"
  // 细条，图片布局（缩放/折叠/间距）在调试模式里复现不了。
  it("浏览器调试：卡面里的 attachment: 引用补成 16:9 占位图", async () => {
    await invoke("import_markdown", {
      files: [
        {
          name: "图包.md",
          content: "# 图包\n\n## C\n\n### 卡\n> [!question]\n> ![题](attachment:debug-shot.png)\n\n答案\n",
        },
      ],
    });
    const { resolveAttachment } = await import("./attachments");
    expect(resolveAttachment("attachment:debug-shot.png")).toMatch(/^data:image\/svg\+xml/);
    // 卡片里没出现过的引用不补（避免给真机的"图片丢失"占位制造假象）。
    expect(resolveAttachment("attachment:never-referenced.png")).toBeNull();
  });
});

// t17 已把 `markdownImport.ts` 镜像成 parser.rs 的 §5.2 rule 10/11/12，所以这条
// 从"缺口特征化"翻转成"与真机逐字节一致"的断言（真机口径见
// parser.rs::tests::chapter_without_h3_becomes_front_card）。
describe("需求7 浏览器导入镜像（rule 10）与真机一致", () => {
  it("无 ### 的非空章节在 mock 里也产 1 张题面卡（title=单行投影、背面空）", async () => {
    const res = (await invoke("import_markdown", {
      files: [
        {
          name: "题面.md",
          content: "# D\n\n## 题面章\n\n![架构图](attachment:abc.png)\n下面这句话是什么？\n",
        },
      ],
    })) as { added: number };

    expect(res.added).toBe(1);
    const overview = (await invoke("list_overview")) as { name: string }[];
    expect(overview.map((o) => o.name)).toContain("D");

    // 三个字段与真机 parser.rs 用例的期望逐字节一致。
    const cards = (await invoke("list_cards", { deck: "D" })) as {
      title: string;
      frontMd?: string;
      contentMd?: string;
    }[];
    expect(cards).toHaveLength(1);
    expect(cards[0].frontMd).toBe("![架构图](attachment:abc.png)\n下面这句话是什么？");
    expect(cards[0].contentMd).toBe(""); // 背面留空（复习时自己写答案）
    expect(cards[0].title).toBe("🖼 · 下面这句话是什么？"); // 单行投影
  });
});

// 真机口径：`services::rate` 评分后状态一律转 `review`（归档分支除外），并把
// 「新卡首次评分」记进 review_log（`state_before='new'`）；每日新卡配额
// （`new_cards_queue`）就是按它做 24h 滑窗计数。默认每日 15 张（SPEC §16）。
describe("学新卡配额与评分后的状态（services::rate / new_cards_queue 的镜像）", () => {
  it("学新卡按每日上限发卡（默认 15），评过的新卡立刻不再是新卡", async () => {
    await invoke("set_settings", { map: { daily_new_limit: "15", session_new_limit: "1" } });
    const newIds = ids(await invoke("search_cards", { filter: "new" }));
    expect(newIds.length).toBeGreaterThan(0);

    const count = (await invoke("start_new_review")) as number;
    // 池比上限小就给满池（不补空、也不被「每次会话 1 张」限制）。
    expect(count).toBe(Math.min(newIds.length, 15));
    await invoke("review_queue"); // 消费掉这次显式会话，别影响后面的用例

    await invoke("rate_card", { cardId: newIds[0], rating: "familiar" });
    const after = (await invoke("get_card", { cardId: newIds[0] })) as { state: string };
    expect(after.state).toBe("review");
    expect(ids(await invoke("search_cards", { filter: "new" }))).not.toContain(newIds[0]);
  });

  it("每日配额用完 / 上限为 0 时给明确错误（与真机同文案）", async () => {
    // 上一条用例已评过一张新卡 → 24h 滑窗计数 ≥1，把上限压到 1 就是"已学完"。
    await invoke("set_settings", { map: { daily_new_limit: "1" } });
    await expect(invoke("start_new_review")).rejects.toThrow(/今日新卡已学完/);

    await invoke("set_settings", { map: { daily_new_limit: "0" } });
    await expect(invoke("start_new_review")).rejects.toThrow(/每日新卡上限为 0/);

    await invoke("set_settings", { map: { daily_new_limit: "15" } });
  });
});
