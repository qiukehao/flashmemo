import { mockIPC } from "@tauri-apps/api/mocks";
import type { CardDto } from "./api";

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
      "1. 读未提交（脏读）\n2. 读已提交（不可重复读）\n3. 可重复读（MySQL 默认，==间隙锁==防幻读）\n4. 串行化\n\n%%面试常问：MySQL 默认级别是哪个？答可重复读%%",
    state: "review",
    dueAt: "2026-09-28T00:00:00.000Z",
    needsAttention: false,
    level: 2,
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

function clone(c: CardDto): CardDto {
  return { ...c };
}

function findCard(id: number): CardDto | undefined {
  return cards.find((c) => c.id === id);
}

/** Registers the in-memory command handlers; call once before rendering. */
export function installMockBackend(): void {
  console.info("[mock] 浏览器调试模式：Tauri 命令由内存假数据接管");
  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 80)); // 模拟 IPC 延迟

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
        return pendingSession.length;
      }
      case "preview_intervals":
        return [3, 8, 20];
      case "rate_card": {
        const c = findCard(Number(a.cardId));
        if (c) {
          c.level = Math.min(5, c.level + 1);
          c.needsAttention = false;
        }
        return c ? clone(c) : null;
      }
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
            filter === "new" ? c.level === 0 : filter === "review" ? c.level > 0 : true,
          )
          .map(clone);
      }
      case "import_markdown":
        return { added: 2, updated: 0, conflicts: 0, keptMissing: 0 };
      case "preview_import":
        return { decks: 1, chapters: 1, cards: 2, conflicts: 0, deckNames: ["示例卡包"] };
      case "due_count":
        return cards.length;
      case "get_settings":
        return { ...settings };
      case "set_settings":
        Object.assign(settings, (a.map as MockSettings) ?? {});
        return null;
      default:
        console.warn("[mock] 未实现的命令:", cmd, args);
        return null;
    }
  });
}
