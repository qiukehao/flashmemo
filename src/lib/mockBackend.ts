import { mockIPC } from "@tauri-apps/api/mocks";
import type { CardDto, GoalReason } from "./api";
import { hasMockAttachment, registerMockAttachment } from "./attachments";
import { frontTitleProjection, nonEmptyDecks, parseMarkdown, type ParsedCard } from "./markdownImport";
import { shiftStudyDay, studyDayKey } from "./studyDay";

/**
 * In-memory backend for browser debugging (SPEC 开发工具，非产品功能).
 * Run `npm run dev` and open http://localhost:1420 — every Tauri command the
 * frontend uses is answered here, so bugs can be reproduced in a normal
 * browser with DevTools element picking.
 */

interface MockSettings {
  [key: string]: string;
}

const cards: CardDto[] = [
  {
    id: 1,
    deck: "MySQL",
    chapter: "事务",
    title: "事务的隔离级别有哪些？",
    contentMd:
      "> [!note] 傻瓜讲解\n> 可以把隔离级别想象成四个档位的隐私保护罩：读未提交＝不穿衣服，读已提交＝穿外套，可重复读＝防窥服，串行化＝排队。\n\n> [!NOTE] ✏️ 面试回答\n>\n> 1. 读未提交（脏读）\n> 2. 读已提交（不可重复读）\n> 3. 可重复读（MySQL 默认，==间隙锁==防幻读）\n> 4. 串行化\n\n%%面试常问：MySQL 默认级别是哪个？答可重复读%%",
    state: "review",
    dueAt: "2026-09-28T00:00:00.000Z",
    needsAttention: false,
    level: 2,
    lapses: 0,
  },
  {
    id: 2,
    deck: "MySQL",
    chapter: "索引",
    title: "B+ 树和 B 树的区别？",
    contentMd:
      "- B+ 树**非叶子节点只存索引**，数据全在叶子层\n- 叶子节点用链表相连，适合范围查询\n\n```sql\nSELECT * FROM t WHERE id BETWEEN 1 AND 100;\n```",
    state: "review",
    dueAt: "2026-09-28T00:00:00.000Z",
    needsAttention: false,
    level: 1,
    lapses: 0,
  },
  {
    id: 3,
    deck: "MySQL",
    chapter: "锁",
    title: "InnoDB 有哪些锁？",
    contentMd:
      "| 类型 | 粒度 | 场景 |\n| --- | --- | --- |\n| 记录锁 | 行 | 唯一索引等值命中 |\n| 间隙锁 | 区间 | 防止幻读 |\n| 临键锁 | 行+间隙 | 默认行为 |",
    state: "review",
    dueAt: "2026-09-28T00:00:00.000Z",
    needsAttention: true,
    level: 2,
    lapses: 3,
  },
  {
    id: 4,
    deck: "Redis",
    chapter: "缓存",
    title: "缓存穿透、击穿、雪崩的区别与对策？",
    contentMd:
      "## 穿透\n查不存在的数据 → 布隆过滤器 / 空值缓存\n\n## 击穿\n热点 key 过期 → 互斥锁重建\n\n## 雪崩\n大量 key 同时过期 → 过期时间加随机值\n\n%%这块能讲出来就稳了%%",
    state: "new",
    dueAt: "2026-09-28T00:00:00.000Z",
    needsAttention: false,
    level: 0,
    lapses: 0,
  },
];

const settings: MockSettings = {
  popup_interval_min: "20",
  per_popup: "3",
  study_start: "09:00",
  study_end: "22:30",
  hint_shown_count: "3",
  notify_mode: "popup",
  daily_popup_limit: "40",
  // 与 Rust 默认一致（设置页据此显示当前值）。
  popup_idle_escape_min: "5",
  close_policy: "normal",
};

let nextId = 100;
let imageSeq = 0;
// 关闭策略镜像: 连续未评分关闭计数（简化版）。
let dodgeStreak = 0;
const lastOrigin = "auto";
let examPresets: [number, string, string][] = [];
let nextPresetId = 1;
let pendingSession: number[] | null = null;
const SESSION_KEY = "mockPendingSession";
const STORE_KEY = "flashmemo-mock-v1";

/** 一次评分事件。讲出计数要「按卡去重」，所以必须记下卡号与评分，不能只留时间。 */
interface ReviewEntry {
  at: string;
  cardId: number;
  rating: string;
}

/** 一次「新卡首次评分」事件（真机口径：`review_log.state_before = 'new'`）。
 *  每日新卡上限按它做 24 小时滑窗计数（`db::new_introduced_since`）。 */
interface IntroducedEntry {
  at: string;
  cardId: number;
}

interface MockStore {
  cards: CardDto[];
  settings: MockSettings;
  nextId: number;
  /** Rating events — drives the dashboard stats and the goal counters. */
  reviews: ReviewEntry[];
  /** 新卡首次评分的时间线——每日新卡配额的唯一来源。 */
  introduced: IntroducedEntry[];
  /** Per-card counters (mirror of the Rust scheduler); `speakDays` = distinct
   *  学习日 list, the basis of 达成掌握. */
  streaks: Record<
    string,
    { unknown: number; speak: number; levelUpDay?: string; speakDays?: string[] }
  >;
  /** Manual link edges [from, to] (前置 → 后置). */
  links: [number, number][];
  /** Per-deck auto-chain switches (default on). */
  deckChain: Record<string, boolean>;
}

/** Data survives reloads (and the popup-view navigation) via localStorage. */
function loadStore(): MockStore | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as MockStore) : null;
  } catch {
    return null;
  }
}

/**
 * 浏览器里没有附件目录，所以卡面上的 `attachment:` 引用一律解析不到，全部渲染成
 * `.card-image-missing` 的细条 —— 图片布局（缩放、折叠、间距）在调试模式里就复现不了。
 * 这里给每个还没注册过的引用补一张 **16:9 的占位 SVG**：尺寸与真实截图同量级，
 * 一眼能看出是替身（写着文件名），但布局是真的。
 * 只影响 mock（真机的解析路径见 `attachments::resolveAttachment`）。
 */
const mockPlaceholderCache = new Set<string>();
function ensureMockImagePlaceholders(): void {
  const re = /attachment:([A-Za-z0-9._-]+)/g;
  for (const c of cards) {
    for (const text of [c.frontMd ?? "", c.contentMd ?? ""]) {
      for (const m of text.matchAll(re)) {
        const name = m[1];
        // 已经真有字节（用户在这个浏览器里粘过图）就别盖掉它。
        if (mockPlaceholderCache.has(name) || hasMockAttachment(name)) continue;
        mockPlaceholderCache.add(name);
        registerMockAttachment(name, placeholderSvg(name));
      }
    }
  }
}

function placeholderSvg(name: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">` +
    `<rect width="1200" height="675" fill="#1f2937"/>` +
    `<text x="60" y="330" fill="#e5e7eb" font-family="sans-serif" font-size="44">🖼 调试占位图</text>` +
    `<text x="60" y="400" fill="#94a3b8" font-family="sans-serif" font-size="30">${name}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function saveStore(): void {
  try {
    // 新增/导入的卡也可能带图片引用：每次落盘前补一遍调试占位图。
    ensureMockImagePlaceholders();
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ cards, settings, nextId, reviews, introduced, streaks, links, deckChain }),
    );
  } catch {
    /* quota/private mode: mock data just won't persist */
  }
}

// Restore a previous session (imported notes, edits, settings) if present.
let reviews: ReviewEntry[] = [];
let introduced: IntroducedEntry[] = [];
let streaks: Record<
  string,
  { unknown: number; speak: number; levelUpDay?: string; speakDays?: string[] }
> = {};
let links: [number, number][] = [];
let deckChain: Record<string, boolean> = {};
{
  const saved = loadStore();
  // 显式空数组也是合法状态（首启引导测试种空库；用户在浏览器里删光卡片后
  // 刷新也不该复活演示卡）——只有"没有存档"才落回演示数据。
  if (saved && Array.isArray(saved.cards)) {
    // Normalise cards persisted by older mock versions (fields added later
    // would otherwise be undefined and poison arithmetic, e.g. NaN lapses).
    cards.splice(
      0,
      cards.length,
      ...saved.cards.map((c) => ({
        ...c,
        lapses: c.lapses ?? 0,
        level: c.level ?? 0,
        needsAttention: c.needsAttention ?? false,
        state: c.state ?? "new",
      })),
    );
    Object.assign(settings, saved.settings ?? {});
    nextId = saved.nextId ?? cards.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    // 旧版 mock 的 reviews 只是 ISO 字符串数组——升级成事件（没有卡号/评分的
    // 历史条目按"熟悉"处理，不影响讲出计数）。
    reviews = ((saved.reviews ?? []) as unknown[]).map((r) =>
      typeof r === "string" ? { at: r, cardId: 0, rating: "familiar" } : (r as ReviewEntry),
    );
    streaks = saved.streaks ?? {};
    introduced = saved.introduced ?? [];
    links = saved.links ?? [];
    deckChain = saved.deckChain ?? {};
  }
}

// 恢复出来的卡先补上图片占位图，首屏就能看到真实尺寸的图片布局。
ensureMockImagePlaceholders();

// A browser has no second window: `start_review` navigates the current tab to
// the popup view, and the selection survives the reload via sessionStorage.
try {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    pendingSession = JSON.parse(saved) as number[];
    sessionStorage.removeItem(SESSION_KEY);
  }
} catch {
  /* sessionStorage unavailable: fine, selection is simply not carried over */
}

/** Commands that change data and therefore trigger a localStorage write. */
const MUTATING = new Set([
  "import_markdown",
  "import_sample_deck",
  "get_autostart",
  "export_markdown",
  "set_autostart",
  "add_card",
  "delete_card",
  "delete_deck",
  "rename_deck",
  "update_card",
  "save_card_content",
  "rate_card",
  "skip_card",
  "set_settings",
  "clear_attention",
  "reset_card_progress",
  "restore_card",
  "add_card_link",
  "remove_card_link",
  "set_deck_chain",
]);

/** `get_card` / `list_cards` / `review_queue` / `search_cards` 等读路径都走这里，
 *  所以卡片上任何字段（含需求7 的 `frontMd`）都原样带过，不会被某条命令吃掉。 */
function clone(c: CardDto): CardDto {
  return { ...c };
}

function findCard(id: number): CardDto | undefined {
  return cards.find((c) => c.id === id);
}

/** 每次弹窗卡片数的默认值与上下限——`services::per_popup_size` 的镜像。 */
const PER_POPUP_DEFAULT = 3;
const PER_POPUP_MIN = 1;
const PER_POPUP_MAX = 5;

const clampPerPopup = (n: number): number =>
  Math.min(PER_POPUP_MAX, Math.max(PER_POPUP_MIN, n));

/** `services::per_popup_size`：手改出来的 0 / 99 / 乱码都不能让一次弹窗变成空或无限。 */
function perPopupSize(): number {
  const raw = Number.parseInt(settings.per_popup ?? "", 10);
  return clampPerPopup(Number.isFinite(raw) ? raw : PER_POPUP_DEFAULT);
}

/** 逃避链阈值（`services::DODGE_PENALTY_STREAK`）：连续 3 次「自动弹窗没评分就被关掉」
 *  之后，下一次弹窗只出 1 张。streak 用的就是 `report_popup_session` 维护的那个，
 *  这里不另立计数器。 */
export const DODGE_PENALTY_STREAK = 3;

/** `services::session_size(per_popup, dodge_cap)` 的镜像：惩罚是**封顶不是覆盖**——
 *  只能把一次会话变短，绝不会把它抬到用户设置之上（`sessionSize(1, 3) === 1`）。 */
export function sessionSize(perPopup: number, dodgeCap: number): number {
  const n = clampPerPopup(perPopup);
  return dodgeCap > 0 ? Math.min(n, clampPerPopup(dodgeCap)) : n;
}

/** 当前的逃避封顶值。真机里它是引擎的无锁原子 `session_size_override`（15s tick 写入），
 *  mock 在取队列时按同一个 streak 现算——可观察行为等价。 */
function dodgeCap(): number {
  return dodgeStreak >= DODGE_PENALTY_STREAK ? 1 : 0;
}

/** `services::new_quotas`：每日新卡上限默认 15（SPEC §16）。
 *  每次会话新卡上限（`session_new_limit`，默认 1）**尚未镜像**——mock 的自动弹窗
 *  池不做「≤1 张新卡」的分桶切片，见 `review_queue` 的注释。 */
const NEW_DAILY_DEFAULT = 15;

function newDailyLimit(): number {
  const raw = Number.parseInt(settings.daily_new_limit ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : NEW_DAILY_DEFAULT;
}

/** 近 24 小时「首次评分」的新卡数（真机 `db::new_introduced_since`：
 *  `review_log` 里 `state_before = 'new'` 的行数）。 */
function introducedInLast24h(): number {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return introduced.filter((e) => Date.parse(e.at) > cutoff).length;
}

/** 全局复习计数器 `review_seq` 的近似。真机里它 = `COUNT(card_show_log)`
 *  （一共展示过多少张卡），这里用同一个口径的自增变量镜像，只服务门槛判定；
 *  刷新页面即归零（mock 不持久化它）。 */
let showSeq = 0;

/** mock 卡片可选的调度门槛字段（真机 `next_eligible_seq`，SPEC §7.2）。
 *  `CardDto` 不带它，示例数据也不带——只有显式带上时才参与判定。 */
type GatedCard = CardDto & { nextEligibleSeq?: number };

/**
 * SPEC §14.1「待复习」唯一谓词的 mock 镜像：
 * `state NOT IN ('suspended','archived') AND next_eligible_seq <= review_seq
 * AND due_at <= now`。
 *
 * Rust 侧唯一实现是 `db::due_predicate`，首页「待复习」、托盘、引擎 tick、
 * 今日目标、每包 dueCount、「到期」筛选与弹窗候选池全部由它派生。mock 也必须
 * 只有一个来源，否则浏览器调试模式会给出「数字里有、队列里没有」的假象
 * （此前 `due_count` 数的是全部卡，连归档/暂停都算）。
 *
 * 有意的近似：mock 不跑真实调度，评分不会写 `next_eligible_seq`，所以没有
 * 该字段的卡一律视为门槛已开；`dueAt` 缺失/不可解析时按"已到期"处理（真机
 * 新卡的 `due_at` 就是当前时刻）。
 */
function isDue(c: CardDto, seq: number, now: number): boolean {
  if (c.state === "suspended" || c.state === "archived") return false;
  const gate = (c as GatedCard).nextEligibleSeq;
  if (typeof gate === "number" && gate > seq) return false;
  const due = Date.parse(c.dueAt);
  return !Number.isFinite(due) || due <= now;
}

/** 现在就能进弹窗的候选池——「待复习」就是它的大小（SPEC §14.1）。 */
function dueCards(): CardDto[] {
  const seq = showSeq;
  const now = Date.now();
  return cards.filter((c) => isDue(c, seq, now));
}

/** Immediate linked neighbours (manual links + chapter auto-chain), one hop,
 *  mirroring SPEC §11.4. Archived/suspended cards still count as neighbours
 *  (they satisfy the archive gate); callers filter as needed. */
function neighboursOf(id: number): CardDto[] {
  const card = findCard(id);
  if (!card) return [];
  const ids = new Set<number>();
  for (const [f, t] of links) {
    if (t === id) ids.add(f);
    if (f === id) ids.add(t);
  }
  if (deckChain[card.deck] !== false) {
    const sibs = cards
      .filter((c) => c.deck === card.deck && c.chapter === card.chapter)
      .sort((a, b) => a.id - b.id);
    const pos = sibs.findIndex((c) => c.id === id);
    if (pos > 0) ids.add(sibs[pos - 1].id);
    if (pos >= 0 && pos + 1 < sibs.length) ids.add(sibs[pos + 1].id);
  }
  ids.delete(id);
  return [...ids].map(findCard).filter(Boolean) as CardDto[];
}

/**
 * `goal.rs` 的 JS 镜像（`cadence_interval` / `planned_interval` / `speak_rate` /
 * `speak_budget` / `goal_cadence`）——**只服务浏览器调试模式**，真实后端一律以
 * Rust 为准。这里的取值由 `goalCadence.test.ts` 用 Rust 单测的同一组数字钉住，
 * Rust 改了公式这边会先红。
 */
const INTERVAL_FLOOR_MIN = 3;
const INTERVAL_CEILING_MIN = 60;
const BUDGET_CAP_MULTIPLIER = 4;
const PLAN_SPEEDUP_FACTOR = 0.5;

function cadenceInterval(minutes: number, remaining: number, perPopup: number): number {
  const popups = Math.max(1, Math.ceil(remaining / Math.max(1, perPopup)));
  const base = Math.round(minutes / popups);
  return Math.min(INTERVAL_CEILING_MIN, Math.max(INTERVAL_FLOOR_MIN, base));
}

export function plannedGoalInterval(
  startMin: number,
  endMin: number,
  target: number,
  perPopup: number,
): number | null {
  if (target <= 0 || endMin <= startMin) return null;
  return cadenceInterval(endMin - startMin, target, perPopup);
}

/** `goal::speak_rate`：先验平滑后夹进 [0.25, 0.9]。 */
export function speakRate(speaks: number, draws: number): number {
  const p = (speaks + 2) / (draws + 5);
  return Math.min(0.9, Math.max(0.25, p));
}

/** `goal::speak_budget`：讲出 N 张大约要复习多少张，夹进 [N, 4N]。 */
export function speakBudget(target: number, rate: number): number {
  if (target <= 0) return 0;
  const need = Math.ceil(target / rate);
  return Math.min(Math.max(need, target), target * BUDGET_CAP_MULTIPLIER);
}

/** `goal::goal_cadence` 的镜像。 */
export function goalCadence(i: {
  mode: "review" | "speak";
  target: number;
  done: number;
  reviewedInWindow: number;
  budget: number | null;
  speakRate: number;
  poolLeft: number;
  perPopup: number;
  nowMin: number;
  startMin: number;
  endMin: number;
  plannedInterval: number;
}): { interval: number | null; reason: GoalReason } {
  if (i.target <= 0) return { interval: null, reason: "off" };
  if (i.nowMin < i.startMin || i.nowMin > i.endMin)
    return { interval: null, reason: "outsideWindow" };
  if (i.done >= i.target) return { interval: null, reason: "reached" };
  if (i.mode === "speak" && i.poolLeft <= 0) return { interval: null, reason: "poolExhausted" };

  let remaining: number;
  if (i.mode === "review") {
    remaining = i.target - i.done;
  } else {
    const stillNeed = Math.ceil((i.target - i.done) / i.speakRate);
    remaining = i.budget == null ? stillNeed : Math.min(stillNeed, i.budget - i.reviewedInWindow);
  }
  if (remaining <= 0) return { interval: null, reason: "budgetSpent" };

  const popups = Math.max(1, Math.ceil(remaining / Math.max(1, i.perPopup)));
  const raw = Math.round((i.endMin - i.nowMin) / popups);
  const floor = Math.max(
    INTERVAL_FLOOR_MIN,
    Math.round(i.plannedInterval * PLAN_SPEEDUP_FACTOR),
  );
  const capped = raw < floor;
  return {
    interval: Math.min(INTERVAL_CEILING_MIN, Math.max(floor, raw)),
    reason: capped ? "cappedAtPlan" : "onPace",
  };
}

function parseHhmm(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Registers the in-memory command handlers; call once before rendering. */
export function installMockBackend(): void {
  console.info(
    "[mock] 浏览器调试模式：数据保存在 localStorage，刷新不丢。\n" +
      "重置示例数据：localStorage.removeItem('flashmemo-mock-v1') 后刷新页面。",
  );
  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 80)); // 模拟 IPC 延迟
    const result = await handleCommand(cmd, a);
    if (MUTATING.has(cmd)) saveStore();
    return result;
  });
}

/** 内置示例卡包（镜像 src-tauri/assets/sample-deck.md，首启引导按钮用）。 */
const SAMPLE_DECK_MD = `# 面试八股 · 示例

## MySQL

### 事务的隔离级别有哪些？

> [!note] 傻瓜讲解
> 把隔离级别想象成四个档位的隐私保护罩。

### B+ 树和 B 树的区别？

- B 树每个节点都存数据，B+ 树只有叶子节点存
- B+ 树叶子之间有双向链表，范围查询更快

## Redis

### 缓存穿透、击穿、雪崩的区别与对策？

穿透＝查不存在的数据；击穿＝热点 key 过期；雪崩＝一大片同时过期。

## 网络

### 从输入 URL 到页面展示，发生了什么？

> [!question]
> 按 DNS → TCP → TLS → HTTP → 渲染的主线讲一遍。

DNS 解析 → TCP 握手 → TLS → HTTP → 渲染。
`;

/** 浏览器里没有启动项可写：开关只在内存里翻转，UI 流程照走。 */
let mockAutostart = false;

async function handleCommand(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "review_queue": {
      // 显式卡表（手动「复习选中」/ 学新卡 / 组卷 / 托盘「立即复习」）整份服务，
      // 一张不少；只有自动弹窗才走 `session_size(每次弹窗卡片数, 逃避封顶)`
      // ——SPEC §7.4：惩罚是封顶不是覆盖，且只作用于自动弹窗。
      // 已知近似（未镜像）：真机自动弹窗还有「≤1 张新卡」的会话分桶切片
      // （`session_new_limit`，默认 1），mock 只按池的顺序取前 N 张，不做分桶。
      const batch = pendingSession
        ? (pendingSession.map(findCard).filter(Boolean) as CardDto[])
        : dueCards().slice(
            0,
            Number(a.limit ?? a.dueLimit ?? sessionSize(perPopupSize(), dodgeCap())),
          );
      pendingSession = null;
      return batch.map(clone);
    }
    case "due_queue":
      return dueCards()
        .slice(0, Number(a.limit ?? perPopupSize()))
        .map(clone);
    case "start_review": {
      pendingSession = (a.cardIds as number[]) ?? [];
      // Swap to the popup view in this same tab (Tauri would open a window).
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(pendingSession));
      } catch {
        /* ignore */
      }
      window.location.search = "?window=popup";
      return pendingSession.length;
    }
    case "start_new_review": {
      // 学新卡 = 显式会话：不吃「每次会话新卡上限」，但每日上限照旧
      // （`services::new_cards_queue`，默认每日 15 张 = SPEC §16）。
      const daily = newDailyLimit();
      if (daily === 0) throw new Error("每日新卡上限为 0，请到设置中开启新卡引入");
      const quota = Math.max(0, daily - introducedInLast24h());
      if (quota === 0) throw new Error(`今日新卡已学完（每日上限 ${daily} 张），明天再来`);
      // 真机 `db::new_candidates` = `pool("c.reps = 0 AND c.level = 0")`——即
      // 「待复习池里的 level 0 卡」，不是"state 恰好等于 new"。
      pendingSession = dueCards()
        .filter((c) => c.level === 0)
        .slice(0, quota)
        .map((c) => c.id);
      if (pendingSession.length === 0) {
        throw new Error("没有待学习的新卡，先去添加或导入几张吧");
      }
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(pendingSession));
      } catch {
        /* ignore */
      }
      window.location.search = "?window=popup";
      return pendingSession.length;
    }
    case "compose_exam": {
      const parts = (a.parts as { deck: string; count: number }[]) ?? [];
      const includeDue = Boolean(a.includeDue);
      const random = String(a.strategy) === "random";
      const picked: number[] = [];
      if (includeDue) {
        for (const c of cards) {
          if (c.state === "review" && c.level >= 1 && c.level <= 2) picked.push(c.id);
        }
      }
      for (const part of parts) {
        const pool = cards.filter(
          (c) => c.deck === part.deck && c.state !== "suspended" && c.state !== "archived",
        );
        const ordered = random
          ? [...pool].sort(() => Math.random() - 0.5)
          : [...pool].sort((x, y) => x.level - y.level);
        for (const c of ordered.slice(0, Math.max(0, Number(part.count) || 0))) {
          if (!picked.includes(c.id)) picked.push(c.id);
        }
      }
      if (picked.length === 0) {
        throw new Error("组卷结果为空：所选卡包里没有可用卡片，先导入或添加几张吧");
      }
      pendingSession = picked;
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(picked));
      } catch {
        /* ignore */
      }
      window.location.search = "?window=popup";
      return picked.length;
    }
    case "save_exam_preset": {
      const name = String(a.name ?? "").trim();
      if (!name) throw new Error("预设名称不能为空");
      const existing = examPresets.find(([, n]) => n === name);
      if (existing) {
        existing[2] = String(a.configJson ?? "{}");
        return existing[0];
      }
      const id = nextPresetId++;
      examPresets.push([id, name, String(a.configJson ?? "{}")]);
      return id;
    }
    case "list_exam_presets":
      return examPresets.map(([id, name, cfg]) => [id, name, cfg]);
    case "delete_exam_preset": {
      const before = examPresets.length;
      examPresets = examPresets.filter(([id]) => id !== Number(a.id));
      return examPresets.length !== before;
    }
    case "preview_intervals":
      return [3, 8, 20];
    case "rate_card": {
      const c = findCard(Number(a.cardId));
      const rating = String(a.rating ?? "familiar");
      const at = new Date().toISOString();
      reviews.push({ at, cardId: Number(a.cardId) || 0, rating });
      if (c) {
        // 真机把「新卡首次评分」记进 review_log（`state_before='new'`），每日新卡
        // 配额就是按它做 24h 滑窗计数（`db::new_introduced_since`）。
        if (c.state === "new") introduced.push({ at, cardId: c.id });
        const s = (streaks[c.id] ??= { unknown: 0, speak: 0 });
        if (rating === "unknown") {
          c.lapses += 1;
          s.unknown += 1;
          s.speak = 0;
          // Rust 侧任何非「可以讲出来」都会清空 speak_days（掌握连击回到起点）。
          s.speakDays = [];
          // Mirror the 2026-10-04 rules: an Unknown never promotes, and from
          // level 3 up it is a real forgetting event (drop to 1).
          c.level = c.level >= 3 ? 1 : Math.max(0, c.level - 1);
          if (s.unknown >= 3) {
            c.needsAttention = true;
            // SPEC §11.4: the ⚠ propagates to immediate linked neighbours.
            for (const n of neighboursOf(c.id)) {
              if (n.state !== "suspended" && n.state !== "archived") n.needsAttention = true;
            }
          }
        } else if (rating === "speakable") {
          s.speak += 1;
          s.unknown = 0;
          // First-rating ace skips the bottom rung (0 → 2); 每天最多升 1 级 —
          // a second speakable the same day holds the level (streak still grows).
          const today = studyDayKey();
          if (s.levelUpDay !== today) {
            c.level = c.level === 0 ? 2 : Math.min(5, c.level + 1);
            s.levelUpDay = today;
          }
          c.needsAttention = false;
          // speak_days 按学习日去重（Rust `append_day`）——同一天连答三次只加一天。
          const days = new Set(s.speakDays ?? []);
          days.add(today);
          s.speakDays = [...days].sort();
          // Mirror the Rust auto-archive rule (threshold 3, switch on) and the
          // chain gate: neighbours must have mastered it too.
          const archiveOn = (settings.archive_enabled ?? "1") !== "0";
          const threshold = Number.parseInt(settings.archive_threshold ?? "3", 10) || 3;
          if (archiveOn && s.speak >= threshold && days.size >= threshold) {
            const gateOk = neighboursOf(c.id).every(
              (n) =>
                n.state === "suspended" ||
                n.state === "archived" ||
                (streaks[n.id]?.speak ?? 0) >= threshold,
            );
            if (gateOk) {
              c.state = "archived";
              s.speak = 0;
            }
          }
        } else {
          s.unknown = 0;
          s.speak = 0;
          s.speakDays = [];
          c.level = Math.max(1, c.level);
        }
        // 真机 `services::rate`：评分后状态一律变 `review`（归档分支除外）——
        // 新卡评过一次就不再是"新卡"，学新卡列表与每日配额都依赖这一点。
        if (c.state !== "archived") c.state = "review";
      }
      return c ? clone(c) : null;
    }
    case "get_stats": {
      // 学习日（凌晨 4 点分界）——与 Rust db::study_day_of 同一口径，
      // 否则统计卡与今日目标在凌晨 0–4 点会显示不同的数字。
      const today = studyDayKey();
      const byDay = new Map<string, number>();
      for (const r of reviews) {
        const d = studyDayKey(r.at);
        byDay.set(d, (byDay.get(d) ?? 0) + 1);
      }
      const last7: number[] = [];
      for (let back = 6; back >= 0; back--) {
        last7.push(byDay.get(shiftStudyDay(today, -back)) ?? 0);
      }
      let streak = 0;
      {
        let cursor = today;
        if ((byDay.get(cursor) ?? 0) === 0) cursor = shiftStudyDay(cursor, -1);
        while ((byDay.get(cursor) ?? 0) > 0) {
          streak += 1;
          cursor = shiftStudyDay(cursor, -1);
        }
      }
      const live = cards.filter((c) => c.state !== "suspended" && c.state !== "archived");
      const dist = [0, 0, 0, 0, 0, 0];
      for (const c of live) dist[Math.min(Math.max(c.level, 0), 5)] += 1;
      return {
        todayReviewed: byDay.get(today) ?? 0,
        dueCount: dueCards().length,
        totalCards: cards.filter((c) => c.state !== "suspended").length,
        streakDays: streak,
        levelDistribution: dist,
        last7Days: last7,
        reviewHeatmap: [...byDay.entries()].map(([date, count]) => ({ date, count })),
        attentionCount: cards.filter((c) => c.needsAttention && c.state !== "suspended").length,
        archivedCount: cards.filter((c) => c.state === "archived").length,
      };
    }
    case "list_attention_cards":
      return cards
        .filter((c) => c.needsAttention && c.state !== "suspended")
        .sort((x, y) => y.lapses - x.lapses)
        .map(clone);
    case "clear_attention": {
      const c = findCard(Number(a.cardId));
      if (c) c.needsAttention = false;
      return c ? clone(c) : null;
    }
    case "reset_card_progress": {
      const c = findCard(Number(a.cardId));
      if (c) {
        c.state = "review";
        c.level = 1;
        c.lapses = 0;
        c.needsAttention = false;
        streaks[c.id] = { unknown: 0, speak: 0 };
      }
      return c ? clone(c) : null;
    }
      case "restore_card": {
        const c = findCard(Number(a.cardId));
        if (c && c.state === "archived") c.state = "review";
        return c ? clone(c) : null;
      }
      case "backup_now":
        return "（浏览器调试模式：数据都在 localStorage，不生成真实备份文件）";
      case "ai_window_show":
      case "ai_window_attach":
      case "ai_window_resize":
      case "ai_window_hide":
      case "ai_fill_question":
        return null; // 浏览器调试模式没有原生 Webview，AI 页面显示占位说明
      case "show_main_with_ai":
        // Browser has a single tab: jump back to the main view so the user
        // sees it (the real command also opens the AI window).
        if (!location.search.includes("window=main")) {
          window.location.search = "?window=main";
        }
        return null;
      case "edit_card_in_main": {
        // Mirror of the real jump-to-edit (§11.2): hand the card id to the
        // main view via sessionStorage, then switch views. The mock has no
        // second window, so there is no popup to hide/restore.
        sessionStorage.setItem("mockEditCardId", String(Number(a.cardId)));
        if (!location.search.includes("window=main")) {
          window.location.search = "?window=main";
        }
        return null;
      }
      case "get_card": {
        const c = findCard(Number(a.cardId));
        return c ? clone(c) : null;
      }
      case "get_card_context": {
        const id = Number(a.cardId);
        const card = findCard(id);
        if (!card) return { requires: [], next: null, nextEligible: false };
        const chained = deckChain[card.deck] !== false;
        const siblings = cards
          .filter((c) => c.chapter === card.chapter && c.state !== "suspended")
          .sort((x, y) => x.id - y.id);
        const pos = siblings.findIndex((c) => c.id === id);
        const requires = [
          ...links.filter(([, to]) => to === id).map(([from]) => findCard(from)).filter(Boolean),
        ] as CardDto[];
        const manualNext = links.find(([from]) => from === id)?.[1];
        let next: CardDto | null = null;
        if (manualNext != null) next = findCard(manualNext) ?? null;
        else if (chained && pos >= 0 && pos + 1 < siblings.length) next = siblings[pos + 1];
        const autoPrev = chained && pos > 0 ? siblings[pos - 1] : null;
        if (autoPrev && !requires.some((c) => c.id === autoPrev.id)) requires.push(autoPrev);
        const eligible = !!next && next.state !== "archived" && next.state !== "suspended";
        return { requires: requires.map(clone), next: next ? clone(next) : null, nextEligible: eligible };
      }
      case "get_card_links": {
        const id = Number(a.cardId);
        return {
          prev: links
            .filter(([, to]) => to === id)
            .map(([from]) => findCard(from))
            .filter(Boolean)
            .map((c) => clone(c as CardDto)),
          next: links
            .filter(([from]) => from === id)
            .map(([, to]) => findCard(to))
            .filter(Boolean)
            .map((c) => clone(c as CardDto)),
        };
      }
      case "add_card_link": {
        const from = Number(a.fromId);
        const to = Number(a.toId);
        if (from === to) throw new Error("不能把卡片连到它自己");
        const reaches = (start: number, target: number): boolean => {
          const seen = new Set<number>();
          const queue = [start];
          while (queue.length) {
            const cur = queue.pop()!;
            if (cur === target) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const [f, t] of links) if (f === cur) queue.push(t);
          }
          return false;
        };
        if (reaches(to, from)) throw new Error("这两张卡之间已存在链条，会形成环");
        if (!links.some(([f, t]) => f === from && t === to)) links.push([from, to]);
        return null;
      }
      case "remove_card_link": {
        const from = Number(a.fromId);
        const to = Number(a.toId);
        links = links.filter(([f, t]) => !(f === from && t === to));
        return null;
      }
      case "set_deck_chain": {
        deckChain[String(a.deck)] = Boolean(a.enabled);
        return null;
      }
    case "skip_card": {
      const c = findCard(Number(a.cardId));
      return c ? clone(c) : null;
    }
    case "mark_card_shown":
      // 全局计数器 review_seq（真机 = COUNT(card_show_log)）——门槛判定的唯一来源。
      showSeq += 1;
      return null;
    case "save_card_content": {
      const c = findCard(Number(a.cardId));
      if (c) c.contentMd = String(a.contentMd ?? "");
      return c ? clone(c) : null;
    }
    case "update_card": {
      const c = findCard(Number(a.cardId));
      if (c) {
        c.title = String(a.title ?? c.title);
        c.contentMd = String(a.contentMd ?? c.contentMd);
        // 需求7：题面只在显式传了 `frontMd` 时改写（编辑器不传就不动它）。
        if (a.frontMd !== undefined && a.frontMd !== null) c.frontMd = String(a.frontMd);
      }
      return c ? clone(c) : null;
    }
    case "add_card": {
      const deck = String(a.deck ?? "未命名");
      const chapter = String(a.chapter ?? "未分类");
      const frontMd = String(a.frontMd ?? "");
      // 与真机 services::add_card_with_front 对齐：标题留空则由题面投影生成，
      // 并在同章节内去重（纯图片题面投影成 🖼，两张就会撞 UNIQUE）。
      const base = String(a.title ?? "").trim() || frontTitleProjection(frontMd);
      if (!base) throw new Error("卡片标题不能为空");
      let title = base;
      for (let n = 2; cards.some((c) => c.deck === deck && c.chapter === chapter && c.title === title); n += 1) {
        title = `${base} #${n}`;
      }
      const card: CardDto = {
        id: nextId++,
        deck,
        chapter,
        title,
        contentMd: String(a.contentMd ?? ""),
        // 需求7 / SPEC §5.2：普通卡的题面是空串（正面回退到 title），
        // 题面卡由调用方传 frontMd。
        frontMd,
        state: "new",
        dueAt: new Date().toISOString(),
        needsAttention: false,
        level: 0,
        lapses: 0,
      };
      cards.push(card);
      return clone(card);
    }
    case "delete_card": {
      const i = cards.findIndex((c) => c.id === Number(a.cardId));
      if (i >= 0) cards.splice(i, 1);
      return null;
    }
    case "delete_deck": {
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i].deck === a.name) cards.splice(i, 1);
      }
      return null;
    }
    case "rename_deck": {
      // 镜像 services::rename_deck 的契约：空名/重名/包不存在都报中文错误，
      // 否则浏览器调试模式会放行真机必然拒绝的操作（如把卡包改名成空串）。
      const newName = String(a.newName ?? "").trim();
      if (!newName) throw new Error("卡包名不能为空");
      const oldName = String(a.oldName ?? "");
      if (!cards.some((c) => c.deck === oldName)) throw new Error("卡包不存在");
      if (newName !== oldName && cards.some((c) => c.deck === newName))
        throw new Error("卡包名已存在");
      for (const c of cards) {
        if (c.deck === oldName) c.deck = newName;
      }
      if (oldName in deckChain) {
        deckChain[newName] = deckChain[oldName];
        delete deckChain[oldName];
      }
      return null;
    }
    case "list_cards":
      return cards.filter((c) => c.deck === a.deck).map(clone);
    case "list_overview": {
      const byDeck = new Map<string, { chapters: Set<string>; count: number; due: number }>();
      // 每包 dueCount = 同一个谓词，所以各包之和必然 = 首页「待复习」（SPEC §14.1）。
      const dueIds = new Set(dueCards().map((c) => c.id));
      for (const c of cards) {
        const entry = byDeck.get(c.deck) ?? { chapters: new Set(), count: 0, due: 0 };
        entry.chapters.add(c.chapter);
        entry.count += 1;
        if (dueIds.has(c.id)) entry.due += 1;
        byDeck.set(c.deck, entry);
      }
      return [...byDeck.entries()].map(([name, v]) => ({
        name,
        chapterCount: v.chapters.size,
        cardCount: v.count,
        dueCount: v.due,
        chainByOrder: deckChain[name] !== false,
      }));
    }
    case "search_cards": {
      const q = String(a.query ?? "").toLowerCase();
      const deck = a.deck ? String(a.deck) : null;
      const filter = String(a.filter ?? "all");
      // 「到期」筛选与首页数字同源（归档卡有自己的筛选项，见 SPEC §15.2）。
      const seq = showSeq;
      const now = Date.now();
      const matchesFilter = (c: CardDto): boolean => {
        switch (filter) {
          case "new":
            return c.level === 0;
          case "due":
            return isDue(c, seq, now);
          case "review":
            return c.level > 0 && c.state !== "archived";
          case "archived":
            return c.state === "archived";
          default:
            return true;
        }
      };
      return cards
        // 真机的搜索基线是 `WHERE c.state != 'suspended'`（db::search_cards）：
        // 暂停卡在任何筛选项里都不出现（归档卡只在 archived 里出现）。
        .filter((c) => c.state !== "suspended")
        .filter((c) => (deck ? c.deck === deck : true))
        .filter((c) =>
          q
            ? c.title.toLowerCase().includes(q) ||
              c.contentMd.toLowerCase().includes(q) ||
              // 需求7：题面卡的内容在 frontMd 里，按题干也搜得到（db::search_cards 同款）。
              (c.frontMd ?? "").toLowerCase().includes(q)
            : true,
        )
        .filter(matchesFilter)
        .map(clone);
    }
    case "export_markdown":
      // 浏览器写不了盘：报告当前库规模，导出按钮本身在 UI 层已拦截提示。
      return {
        decks: new Set(cards.map((c) => c.deck)).size,
        cards: cards.filter((c) => c.state !== "suspended").length,
      };
    case "get_autostart":
      return mockAutostart;
    case "set_autostart":
      mockAutostart = Boolean(a.enabled);
      return mockAutostart;
    case "import_sample_deck":
      // 与 Rust include_str! 的 sample-deck.md 同源镜像（浏览器模式走通流程）。
      return handleCommand("import_markdown", {
        files: [{ name: "示例卡包.md", content: SAMPLE_DECK_MD }],
      });
    case "import_markdown": {
      // Real parse (TS mirror of parser.rs) so import flows are testable in
      // the browser; cards are appended to the in-memory store.
      const files = (a.files as { name: string; content: string }[]) ?? [];
      let added = 0;
      for (const f of files) {
        const stem = f.name.replace(/\.[^.]+$/, "");
        for (const deck of nonEmptyDecks(parseMarkdown(f.content, stem))) {
          for (const ch of deck.chapters) {
            for (const c of ch.cards) {
              cards.push({
                id: nextId++,
                deck: deck.name,
                chapter: ch.name,
                title: c.title,
                contentMd: c.contentMd,
                // 需求7：题面卡（`### ` 之外的块级卡）整块内容进 frontMd，title 只是
                // 单行投影。TS 解析器镜像还没有该字段时读不到，`?? ""` 就是普通卡
                // 的真机口径（parser.rs: `h3_card_has_empty_front_md`）。
                frontMd: (c as ParsedCard & { frontMd?: string }).frontMd ?? "",
                state: "new",
                dueAt: new Date().toISOString(),
                needsAttention: false,
                level: 0,
                lapses: 0,
              });
              added += 1;
            }
          }
        }
      }
      return { added, updated: 0, conflicts: 0, keptMissing: 0 };
    }
    case "preview_import": {
      const files = (a.files as { name: string; content: string }[]) ?? [];
      let decksCount = 0;
      let chapters = 0;
      let cardCount = 0;
      const deckNames: string[] = [];
      for (const f of files) {
        const stem = f.name.replace(/\.[^.]+$/, "");
        for (const deck of nonEmptyDecks(parseMarkdown(f.content, stem))) {
          decksCount += 1;
          deckNames.push(deck.name);
          chapters += deck.chapters.length;
          cardCount += deck.chapters.reduce((n, ch) => n + ch.cards.length, 0);
        }
      }
      return { decks: decksCount, chapters, cards: cardCount, conflicts: 0, deckNames };
    }
    case "activity_status":
      return {
        enabled: (settings.activity_enabled ?? "0") === "1",
        category: "neutral",
        continuousSecs: 0,
        process: "",
        title: "",
        matched: null,
        idle: false,
      };
    case "close_context":
      return {
        strict: (settings.close_policy ?? "normal") === "strict",
        dodgeStreak: dodgeStreak,
        noCloseFirstN: Math.min(Number.parseInt(settings.no_close_first_n ?? "0", 10) || 0, 10),
      };
    case "report_popup_session": {
      if (String(a.reason) === "closed" && Number(a.rated ?? 0) === 0 && lastOrigin === "auto") {
        dodgeStreak += 1;
      } else if (Number(a.rated ?? 0) > 0) {
        dodgeStreak = 0;
      }
      return null;
    }
    // 离手逃离的交互心跳：浏览器调试模式下没有引擎，收下即可。
    case "popup_activity":
      return null;
    case "goal_status": {
      const today = studyDayKey();
      const todayReviews = reviews.filter((r) => studyDayKey(r.at) === today);
      const reviewedToday = todayReviews.length;
      // 讲出：今天有过「可以讲出来」评分的卡，按卡去重。
      const spokenIds = new Set(
        todayReviews.filter((r) => r.rating === "speakable").map((r) => r.cardId),
      );
      const spokenToday = spokenIds.size;
      const target = Number.parseInt(settings.goal_target ?? "0", 10) || 0;
      const enabled = (settings.goal_enabled ?? "0") === "1";
      const mode: "review" | "speak" =
        (settings.goal_mode ?? "review") === "speak" ? "speak" : "review";
      const start = settings.goal_start ?? "19:00";
      const end = settings.goal_end ?? "22:00";
      const perPopup = perPopupSize();
      const archiveThreshold = Number.parseInt(settings.archive_threshold ?? "3", 10) || 3;
      // poolLeft 镜像的是 `db::pushable_pool_left`：只按状态过滤（+ 今天没讲出过），
      // 不看 due_at / 计数器门槛——与 dueCount 不是同一个集合，别合并。
      const liveCards = cards.filter((c) => c.state !== "suspended" && c.state !== "archived");
      const poolLeft = liveCards.filter((c) => !spokenIds.has(c.id)).length;
      const masteredToday = cards.filter((c) => {
        const days = streaks[c.id]?.speakDays ?? [];
        return days.includes(today) && days.length >= archiveThreshold;
      }).length;
      const done = mode === "speak" ? spokenToday : reviewedToday;
      const met = target > 0 && (done >= target || (mode === "speak" && poolLeft <= 0));

      // 讲出率：近 14 个学习日；分母排除"该卡今天已经讲出来过之后"的展示。
      const cutoff = shiftStudyDay(today, -13);
      const spokeSeen = new Set<string>();
      let speaks = 0;
      let draws = 0;
      for (const r of [...reviews].sort((a, b) => a.at.localeCompare(b.at))) {
        const day = studyDayKey(r.at);
        if (day < cutoff) continue;
        const key = `${r.cardId}|${day}`;
        if (spokeSeen.has(key)) continue;
        draws += 1;
        if (r.rating === "speakable") {
          speaks += 1;
          spokeSeen.add(key);
        }
      }
      const rate = speakRate(speaks, draws);
      const budget = mode === "speak" && target > 0 ? speakBudget(target, rate) : null;

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const sb = parseHhmm(start);
      const eb = parseHhmm(end);
      let intervalMin: number | null = null;
      let plannedIntervalMin: number | null = null;
      let reason: GoalReason = "off";
      let beforeWindow = false;
      let budgetLeft: number | null = null;
      if (sb && eb) {
        const startMin = sb[0] * 60 + sb[1];
        const endMin = eb[0] * 60 + eb[1];
        beforeWindow = nowMin < startMin;
        plannedIntervalMin = plannedGoalInterval(startMin, endMin, target, perPopup);
        const reviewedInWindow = todayReviews.filter((r) => {
          const d = new Date(r.at);
          return d.getHours() * 60 + d.getMinutes() >= startMin;
        }).length;
        budgetLeft = budget == null ? null : Math.max(0, budget - reviewedInWindow);
        const out = goalCadence({
          mode,
          target: enabled ? target : 0,
          done,
          reviewedInWindow,
          budget,
          speakRate: rate,
          poolLeft,
          perPopup,
          nowMin,
          startMin,
          endMin,
          plannedInterval: plannedIntervalMin ?? INTERVAL_CEILING_MIN,
        });
        intervalMin = out.interval;
        reason = out.reason;
      }
      return {
        enabled,
        mode,
        target,
        done,
        reviewedToday,
        spokenToday,
        masteredToday,
        dueCount: dueCards().length,
        perPopup,
        start,
        end,
        met,
        speakRate: rate,
        budget,
        budgetLeft,
        poolLeft,
        intervalMin,
        plannedIntervalMin,
        reason,
        beforeWindow,
      };
    }
    case "due_count":
      // 首页「待复习」/ 托盘 / 引擎 tick 共用的那个数——只有一个来源（SPEC §14.1）。
      return dueCards().length;
    case "get_settings":
      return { ...settings };
    case "set_settings":
      Object.assign(settings, (a.map as MockSettings) ?? {});
      return null;
    // SPEC §5.4 attachments. A browser has no filesystem: pasted/selected bytes
    // stay in memory as data URLs and `attachment:` refs resolve from that map,
    // so the whole image flow (insert → render → round-trip) stays debuggable.
    case "attachment_dir":
      return "";
    case "save_attachment": {
      const data = String(a.data ?? "");
      const mime = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(data)?.[1] ?? "image/png";
      const ext =
        (a.ext as string | null) ?? mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const name = `mock-${Date.now().toString(36)}-${imageSeq++}.${ext}`;
      registerMockAttachment(name, data);
      return `attachment:${name}`;
    }
    case "save_attachment_file":
    case "read_markdown_files":
      throw new Error("浏览器调试模式没有本地文件访问权限（请在 Tauri 应用中操作）");
    default:
      console.warn("[mock] 未实现的命令:", cmd, a);
      return null;
  }
}
