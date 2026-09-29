import { mockIPC } from "@tauri-apps/api/mocks";
import type { CardDto } from "./api";
import { nonEmptyDecks, parseMarkdown } from "./markdownImport";

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
  popup_interval_min: "5",
  per_popup: "3",
  study_start: "09:00",
  study_end: "22:30",
  hint_shown_count: "3",
  notify_mode: "popup",
};

let nextId = 100;
let pendingSession: number[] | null = null;
const SESSION_KEY = "mockPendingSession";
const STORE_KEY = "flashmemo-mock-v1";

interface MockStore {
  cards: CardDto[];
  settings: MockSettings;
  nextId: number;
  /** ISO timestamps of ratings — drives the dashboard stats. */
  reviews: string[];
  /** Per-card consecutive-rating counters (mirror of the Rust scheduler). */
  streaks: Record<string, { unknown: number; speak: number }>;
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

function saveStore(): void {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ cards, settings, nextId, reviews, streaks }),
    );
  } catch {
    /* quota/private mode: mock data just won't persist */
  }
}

// Restore a previous session (imported notes, edits, settings) if present.
let reviews: string[] = [];
let streaks: Record<string, { unknown: number; speak: number }> = {};
{
  const saved = loadStore();
  if (saved?.cards?.length) {
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
    reviews = saved.reviews ?? [];
    streaks = saved.streaks ?? {};
  }
}

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
]);

function clone(c: CardDto): CardDto {
  return { ...c };
}

function findCard(id: number): CardDto | undefined {
  return cards.find((c) => c.id === id);
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

async function handleCommand(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "review_queue": {
      const batch = pendingSession
        ? (pendingSession.map(findCard).filter(Boolean) as CardDto[])
        : cards.slice(0, Number(a.limit ?? a.dueLimit ?? 3));
      pendingSession = null;
      return batch.map(clone);
    }
    case "due_queue":
      return cards.slice(0, Number(a.limit ?? 3)).map(clone);
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
    case "preview_intervals":
      return [3, 8, 20];
    case "rate_card": {
      const c = findCard(Number(a.cardId));
      const rating = String(a.rating ?? "familiar");
      reviews.push(new Date().toISOString());
      if (c) {
        const s = (streaks[c.id] ??= { unknown: 0, speak: 0 });
        if (rating === "unknown") {
          c.lapses += 1;
          s.unknown += 1;
          s.speak = 0;
          c.level = Math.max(1, c.level - 1);
          if (s.unknown >= 3) c.needsAttention = true;
        } else if (rating === "speakable") {
          s.speak += 1;
          s.unknown = 0;
          c.level = Math.min(5, c.level + 1);
          c.needsAttention = false;
          // Mirror the Rust auto-archive rule (threshold 3, switch on).
          const archiveOn = (settings.archive_enabled ?? "1") !== "0";
          const threshold = Number.parseInt(settings.archive_threshold ?? "3", 10) || 3;
          if (archiveOn && s.speak >= threshold) {
            c.state = "archived";
            s.speak = 0;
          }
        } else {
          s.unknown = 0;
          s.speak = 0;
          c.level = Math.max(1, c.level);
        }
      }
      return c ? clone(c) : null;
    }
    case "get_stats": {
      const dayOf = (iso: string) => new Date(iso).toLocaleDateString("sv"); // YYYY-MM-DD local
      const today = new Date().toLocaleDateString("sv");
      const byDay = new Map<string, number>();
      for (const iso of reviews) {
        const d = dayOf(iso);
        byDay.set(d, (byDay.get(d) ?? 0) + 1);
      }
      const last7: number[] = [];
      let streak = 0;
      const cursor = new Date();
      for (let back = 6; back >= 0; back--) {
        const d = new Date();
        d.setDate(cursor.getDate() - back);
        last7.push(byDay.get(d.toLocaleDateString("sv")) ?? 0);
      }
      {
        const d = new Date();
        if ((byDay.get(d.toLocaleDateString("sv")) ?? 0) === 0) d.setDate(d.getDate() - 1);
        while ((byDay.get(d.toLocaleDateString("sv")) ?? 0) > 0) {
          streak += 1;
          d.setDate(d.getDate() - 1);
        }
      }
      const live = cards.filter((c) => c.state !== "suspended" && c.state !== "archived");
      const dist = [0, 0, 0, 0, 0, 0];
      for (const c of live) dist[Math.min(Math.max(c.level, 0), 5)] += 1;
      return {
        todayReviewed: byDay.get(today) ?? 0,
        dueCount: live.length,
        totalCards: cards.filter((c) => c.state !== "suspended").length,
        streakDays: streak,
        levelDistribution: dist,
        last7Days: last7,
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
    case "skip_card": {
      const c = findCard(Number(a.cardId));
      return c ? clone(c) : null;
    }
    case "mark_card_shown":
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
      }
      return c ? clone(c) : null;
    }
    case "add_card": {
      const card: CardDto = {
        id: nextId++,
        deck: String(a.deck ?? "未命名"),
        chapter: String(a.chapter ?? "未分类"),
        title: String(a.title ?? ""),
        contentMd: String(a.contentMd ?? ""),
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
      for (const c of cards) {
        if (c.deck === a.oldName) c.deck = String(a.newName ?? c.deck);
      }
      return null;
    }
    case "list_cards":
      return cards.filter((c) => c.deck === a.deck).map(clone);
    case "list_overview": {
      const byDeck = new Map<string, { chapters: Set<string>; count: number }>();
      for (const c of cards) {
        const entry = byDeck.get(c.deck) ?? { chapters: new Set(), count: 0 };
        entry.chapters.add(c.chapter);
        entry.count += 1;
        byDeck.set(c.deck, entry);
      }
      return [...byDeck.entries()].map(([name, v]) => ({
        name,
        chapterCount: v.chapters.size,
        cardCount: v.count,
        dueCount: v.count,
      }));
    }
    case "search_cards": {
      const q = String(a.query ?? "").toLowerCase();
      const deck = a.deck ? String(a.deck) : null;
      const filter = String(a.filter ?? "all");
      return cards
        .filter((c) => (deck ? c.deck === deck : true))
        .filter((c) =>
          q ? c.title.toLowerCase().includes(q) || c.contentMd.toLowerCase().includes(q) : true,
        )
      .filter((c) =>
        filter === "new"
          ? c.level === 0
          : filter === "review"
            ? c.level > 0 && c.state !== "archived"
            : filter === "archived"
              ? c.state === "archived"
              : true,
      )
      .map(clone);
    }
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
    case "due_count":
      return cards.length;
    case "get_settings":
      return { ...settings };
    case "set_settings":
      Object.assign(settings, (a.map as MockSettings) ?? {});
      return null;
  default:
    console.warn("[mock] 未实现的命令:", cmd, a);
    return null;
  }
}
