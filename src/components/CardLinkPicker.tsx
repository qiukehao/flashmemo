import { useCallback, useEffect, useState } from "react";
import { api, type CardDto, type CardLinks, errText } from "../lib/api";

/**
 * 共享的「链接卡片选择器」（SPEC §11.1）：主窗口卡片编辑器与复习弹窗用同一套
 * 增删/改绑逻辑，避免两处各写一份、语义漂移。
 *
 * 三条约束：
 * 1. 只有**手动边**可编辑。自动邻居（同章节按导入顺序串联）不是边，删不掉，
 *    界面也不能假装能删 —— 见 `partitionRequires` / `nextLinkSource`。
 * 2. 删除一律两步（点「×」→ 点「确认取消」）：复习时误触会悄悄改掉自己的知识链。
 * 3. 每次改动后回拉 `get_card_links`，由调用方决定怎么刷新上下文。
 */

export type LinkSide = "prev" | "next";

/** 「在 card 的 side 上放 target」翻译成数据层的有向边 (from → to)。 */
export function linkPairFor(cardId: number, side: LinkSide, target: number): [number, number] {
  return side === "prev" ? [target, cardId] : [cardId, target];
}

/** 手动边上的卡片 id —— 只有这些能被取消/改绑。 */
export function manualIds(links: CardLinks | null, side: LinkSide): Set<number> {
  const list = side === "prev" ? links?.prev : links?.next;
  return new Set((list ?? []).map((c) => c.id));
}

/**
 * SPEC §11.2 的「知识铺垫」列表是后端合并后的结果：手动前置 + 同章节自动前置
 * （去重、手动在前）。这里把两者分开，界面才能对自动邻居显示「自动」而不是
 * 一个点了没用的删除按钮。
 */
export function partitionRequires(
  requires: CardDto[],
  links: CardLinks | null,
): { manual: CardDto[]; auto: CardDto[] } {
  const manual = manualIds(links, "prev");
  return {
    manual: requires.filter((c) => manual.has(c.id)),
    auto: requires.filter((c) => !manual.has(c.id)),
  };
}

/** 后置卡是手动边来的（可取消）还是章节顺序自动来的（没有边可取消）。 */
export function nextLinkSource(
  next: CardDto | null,
  links: CardLinks | null,
): "manual" | "chapter" | null {
  if (!next) return null;
  return manualIds(links, "next").has(next.id) ? "manual" : "chapter";
}

/**
 * 顶栏 🔗 上的红点是否亮（2026-10-07 需求，2026-10-09 修正）。
 *
 * 只看**手动前置/后置边**：🔗 面板列的就是这一份，红点必须和面板内容一致，
 * 否则会出现「🔗 里写着前置/后置都是『无』，红点却亮着」。同章节自动串联的
 * 邻居出现在 📚 知识铺垫里，由那个入口自身的有无表达——把它算进红点会让
 * 默认开启串联的卡包几乎每张卡都常亮（用户反馈）。
 */
export function hasManualLinks(links: CardLinks | null): boolean {
  return (links?.prev.length ?? 0) > 0 || (links?.next.length ?? 0) > 0;
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MAX = 6;

export interface CardLinkPickerProps {
  /** 正在编辑关联的卡：新边的一端永远是它。 */
  cardId: number;
  /** 搜索范围（同卡包，SPEC §11.1）。 */
  deck: string;
  /** 当前手动边（`api.getCardLinks` 原样）。null = 还没加载完。 */
  links: CardLinks | null;
  /** 每次成功改动后拿到最新手动边。 */
  onLinks: (links: CardLinks) => void;
  /** 弹窗用的紧凑形态：默认收起搜索框。 */
  compact?: boolean;
  /** 紧凑形态下直接展开搜索框。 */
  defaultOpen?: boolean;
  /** 候选来源的注入点（默认查同卡包）；测试与主窗口可换成自己的检索。 */
  search?: (query: string) => Promise<CardDto[]>;
}

export default function CardLinkPicker({
  cardId,
  deck,
  links,
  onLinks,
  compact = false,
  defaultOpen = false,
  search,
}: CardLinkPickerProps) {
  const [open, setOpen] = useState(defaultOpen || !compact);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CardDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  /** 防误触：待确认的删除（点「×」之后、点「确认取消」之前）。 */
  const [pendingRemove, setPendingRemove] = useState<{ side: LinkSide; id: number } | null>(null);
  /** 改绑中间态：先撤掉这条边，再建用户选中的新边。 */
  const [rebind, setRebind] = useState<{ side: LinkSide; id: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      const run = search ? search(q) : api.searchCards(q, deck, "all");
      void run
        .then((found) => {
          if (alive) setResults(found.filter((c) => c.id !== cardId).slice(0, SEARCH_MAX));
        })
        .catch(() => {
          if (alive) setResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, query, search, deck, cardId]);

  const refresh = useCallback(async () => {
    try {
      onLinks(await api.getCardLinks(cardId));
    } catch (e) {
      setMsg(errText(e));
    }
  }, [cardId, onLinks]);

  const remove = useCallback(
    async (side: LinkSide, target: number) => {
      setBusy(true);
      setMsg("");
      try {
        const [from, to] = linkPairFor(cardId, side, target);
        await api.removeCardLink(from, to);
        await refresh();
        setPendingRemove(null);
      } catch (e) {
        setMsg(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [cardId, refresh],
  );

  const add = useCallback(
    async (side: LinkSide, target: CardDto) => {
      setBusy(true);
      setMsg("");
      try {
        // 改绑：同一侧已经在等着换 —— 先撤旧边再建新边（防环由后端兜住）。
        if (rebind && rebind.side === side) {
          const [from, to] = linkPairFor(cardId, side, rebind.id);
          await api.removeCardLink(from, to);
        }
        const [from, to] = linkPairFor(cardId, side, target.id);
        await api.addCardLink(from, to);
        await refresh();
        setRebind((r) => (r && r.side === side ? null : r));
        setQuery("");
        setResults([]);
        if (compact) setOpen(false);
      } catch (e) {
        setMsg(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [cardId, rebind, refresh, compact],
  );

  function chip(side: LinkSide, card: CardDto) {
    const key = `${side}-${card.id}`;
    const confirming = pendingRemove?.side === side && pendingRemove.id === card.id;
    const rebinding = rebind?.side === side && rebind.id === card.id;
    return (
      <span
        className={`link-chip${rebinding ? " rebinding" : ""}`}
        data-side={side}
        data-card-id={card.id}
        key={key}
      >
        <span className="link-chip-title" title={card.title}>
          {card.title}
        </span>
        {confirming ? (
          <>
            <button
              type="button"
              className="link-chip-confirm"
              data-action="confirm-remove"
              disabled={busy}
              onClick={() => void remove(side, card.id)}
            >
              确认取消
            </button>
            <button
              type="button"
              className="link-chip-cancel"
              data-action="cancel-remove"
              onClick={() => setPendingRemove(null)}
            >
              再想想
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="link-chip-btn"
              data-action="rebind"
              title="换成另一张卡"
              onClick={() => {
                setRebind({ side, id: card.id });
                setOpen(true);
              }}
            >
              改绑
            </button>
            <button
              type="button"
              className="link-chip-btn danger"
              data-action="unlink"
              title="取消这条关联"
              onClick={() => setPendingRemove({ side, id: card.id })}
            >
              ×
            </button>
          </>
        )}
      </span>
    );
  }

  function row(side: LinkSide, label: string, cards: CardDto[]) {
    return (
      <div className="link-row" data-row={side}>
        <span className="muted small">{label}</span>
        {cards.length ? cards.map((c) => chip(side, c)) : <span className="muted small">无</span>}
      </div>
    );
  }

  const prev = links?.prev ?? [];
  const next = links?.next ?? [];

  return (
    <div className={`link-editor${compact ? " compact" : ""}`} data-testid="card-link-picker">
      {row("prev", "前置：", prev)}
      {row("next", "后置：", next)}

      {!open ? (
        <button
          type="button"
          className="link-add-toggle"
          data-action="open-search"
          onClick={() => setOpen(true)}
        >
          ＋ 关联卡片
        </button>
      ) : (
        <>
          <input
            className="link-search"
            data-testid="card-link-search"
            placeholder={
              rebind
                ? rebind.side === "prev"
                  ? "选一张卡替换为新的前置…"
                  : "选一张卡替换为新的后置…"
                : "搜索本包卡片，添加为前置/后置…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {rebind && (
            <div className="link-rebind-hint" data-testid="card-link-rebind-hint">
              <span>改绑中：选择新卡片后会先撤掉原来的关联</span>
              <button type="button" className="btn small" onClick={() => setRebind(null)}>
                放弃改绑
              </button>
            </div>
          )}
          {results.length > 0 && (
            <div className="link-results">
              {results.map((r) => (
                <div className="link-result" key={r.id}>
                  <span className="card-title-cell">
                    {r.title}
                    <small className="muted"> {r.chapter}</small>
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    data-action="link-prev"
                    disabled={busy}
                    onClick={() => void add("prev", r)}
                  >
                    设为前置
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    data-action="link-next"
                    disabled={busy}
                    onClick={() => void add("next", r)}
                  >
                    设为后置
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {msg && <div className="error small">{msg}</div>}
    </div>
  );
}

/**
 * 「继续下一张」旁边的关联动作（SPEC §11.2）：手动后置可以就地取消（两步确认），
 * 章节顺序自动来的那条只说明来源 —— 它没有边可删，给个假按钮只会让人以为点了
 * 没用（要断就得到主窗口关掉该卡包的串联开关）。
 */
export function NextLinkActions({
  cardId,
  next,
  links,
  onRemoved,
}: {
  cardId: number;
  next: CardDto;
  links: CardLinks | null;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const source = nextLinkSource(next, links);

  // 手动边还没拉回来之前不做任何断言（可能只是慢一拍）。
  if (links == null) return null;
  if (source === "chapter") {
    return (
      <span
        className="popup-link-auto"
        data-testid="popup-link-auto"
        title="同章节按导入顺序自动串联（SPEC §11.1）；要断开请到主窗口关掉该卡包的串联开关"
      >
        同章节自动串联
      </span>
    );
  }
  if (source !== "manual") return null;

  const confirmRemove = async () => {
    setBusy(true);
    setMsg("");
    try {
      const [from, to] = linkPairFor(cardId, "next", next.id);
      await api.removeCardLink(from, to);
      setConfirming(false);
      onRemoved();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <span className="popup-link-confirm" data-testid="popup-link-confirm">
        <span>取消与「{next.title}」的关联？</span>
        <button
          type="button"
          className="btn small"
          data-action="confirm-unlink-next"
          disabled={busy}
          onClick={() => void confirmRemove()}
        >
          确认取消
        </button>
        <button
          type="button"
          className="btn small"
          data-action="cancel-unlink-next"
          onClick={() => setConfirming(false)}
        >
          再想想
        </button>
        {msg && <span className="error small">{msg}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="popup-link-unlink"
      data-action="unlink-next"
      title="取消这条手动关联（只影响呈现与续复习，不改调度）"
      onClick={() => setConfirming(true)}
    >
      取消关联
    </button>
  );
}
