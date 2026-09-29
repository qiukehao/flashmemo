import { useCallback, useEffect, useState } from "react";
import { api, type CardDto, type CardLinks, type DeckOverview } from "../lib/api";

const STATE_LABEL: Record<string, string> = {
  suspended: "已删除",
  archived: "已归档",
};

/** 熟练等级 0–5（SPEC §7.3）. */
const LEVEL_LABEL = ["新卡", "刚接触", "能回忆", "基本熟练", "长期维护", "长期维护"];

export function levelLabel(level: number, state: string): string {
  return STATE_LABEL[state] ?? LEVEL_LABEL[Math.min(Math.max(level, 0), 5)];
}

/** Group cards by chapter, preserving first-seen order (backend returns
 *  cards in reading order: chapter order_idx, then insertion). */
function chaptersOf(cards: CardDto[]): [string, CardDto[]][] {
  const map = new Map<string, CardDto[]>();
  for (const c of cards) {
    const list = map.get(c.chapter);
    if (list) list.push(c);
    else map.set(c.chapter, [c]);
  }
  return [...map.entries()];
}

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "due", label: "可复习" },
  { key: "new", label: "新卡" },
  { key: "review", label: "已复习" },
  { key: "archived", label: "已归档" },
];

function fmtDue(iso: string): string {
  const d = new Date(iso);
  const past = d.getTime() <= Date.now();
  if (past) return "随时可复习";
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  const label =
    today ? hhmm : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " " + hhmm;
  return `最早 ${label}`;
}

/** Deck management + search/filter + manual review selection (SPEC §15.2). */
export default function DecksPage() {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDto[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [results, setResults] = useState<CardDto[] | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  // Manual 前置/后置 links of the card being edited (SPEC §11.1).
  const [links, setLinks] = useState<CardLinks | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<CardDto[]>([]);
  const [linkMsg, setLinkMsg] = useState("");

  const flatMode = query.trim() !== "" || filter !== "all";

  const loadOverview = useCallback(() => {
    api
      .listOverview()
      .then(setOverview)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(loadOverview, [loadOverview]);

  // Flat search/filter view (debounced).
  useEffect(() => {
    if (!flatMode) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchCards(query.trim() || null, null, filter)
        .then(setResults)
        .catch((e) => setError(String(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [query, filter, flatMode]);

  async function toggleDeck(name: string) {
    if (openDeck === name) {
      setOpenDeck(null);
      return;
    }
    setOpenDeck(name);
    setError("");
    try {
      setCards(await api.listCards(name));
    } catch (e) {
      setError(String(e));
    }
  }

  function flash(text: string) {
    setMsg(text);
    setError("");
  }

  function toggleSelect(id: number) {
    setSelection((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(list: CardDto[]) {
    setSelection((s) => {
      const allSelected = list.every((c) => s.has(c.id));
      const next = new Set(s);
      for (const c of list) {
        if (allSelected) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });
  }

  async function reviewSelected() {
    setError("");
    try {
      const n = await api.startReview([...selection]);
      flash(`已打开复习弹窗（${n} 张）`);
      setSelection(new Set());
    } catch (e) {
      setError(String(e));
    }
  }

  async function reviewDeck(name: string) {
    setError("");
    try {
      const due = await api.searchCards(null, name, "due");
      if (due.length === 0) {
        setError(`「${name}」暂无到期卡片`);
        return;
      }
      const n = await api.startReview(due.map((c) => c.id));
      flash(`已打开「${name}」复习弹窗（${n} 张到期卡）`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function doRename(oldName: string) {
    setError("");
    try {
      await api.renameDeck(oldName, renameValue);
      flash(`已重命名为「${renameValue}」`);
      setRenaming(null);
      loadOverview();
      if (openDeck === oldName) setOpenDeck(renameValue);
    } catch (e) {
      setError(String(e));
    }
  }

  async function doDeleteDeck(name: string) {
    if (!confirm(`确定删除卡包「${name}」及其全部卡片？此操作不可恢复。`)) return;
    setError("");
    try {
      await api.deleteDeck(name);
      flash(`已删除卡包「${name}」`);
      if (openDeck === name) setOpenDeck(null);
      loadOverview();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doDeleteCard(card: CardDto) {    if (!confirm(`确定删除卡片「${card.title}」？`)) return;
    setError("");
    try {
      await api.deleteCard(card.id);
      flash("卡片已删除");
      refreshCurrent();
    } catch (e) {
      setError(String(e));
    }
  }

  function refreshCurrent() {
    loadOverview();
    if (openDeck) api.listCards(openDeck).then(setCards).catch(() => {});
    if (flatMode) {
      api
        .searchCards(query.trim() || null, null, filter)
        .then(setResults)
        .catch(() => {});
    }
  }

  function startEdit(card: CardDto) {
    setEditing(card.id);
    setEditTitle(card.title);
    setEditContent(card.contentMd);
    setLinks(null);
    setLinkQuery("");
    setLinkResults([]);
    setLinkMsg("");
    api
      .getCardLinks(card.id)
      .then(setLinks)
      .catch(() => {});
  }

  // Debounced card search for the link picker (within the edited card's deck).
  useEffect(() => {
    if (editing == null || !linkQuery.trim()) {
      setLinkResults([]);
      return;
    }
    const editingCard = cards.find((x) => x.id === editing);
    const t = setTimeout(() => {
      api
        .searchCards(linkQuery.trim(), editingCard?.deck ?? null, "all")
        .then((rs) => setLinkResults(rs.filter((r) => r.id !== editing).slice(0, 6)))
        .catch(() => setLinkResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [linkQuery, editing, cards]);

  async function addLink(target: CardDto, asPrev: boolean) {
    if (editing == null) return;
    setLinkMsg("");
    try {
      if (asPrev) await api.addCardLink(target.id, editing);
      else await api.addCardLink(editing, target.id);
      setLinks(await api.getCardLinks(editing));
      setLinkQuery("");
      setLinkResults([]);
    } catch (e) {
      setLinkMsg(String(e));
    }
  }

  async function removeLink(from: number, to: number) {
    if (editing == null) return;
    setLinkMsg("");
    try {
      await api.removeCardLink(from, to);
      setLinks(await api.getCardLinks(editing));
    } catch (e) {
      setLinkMsg(String(e));
    }
  }

  /** SPEC §11.1 卡包级开关: auto-chain by import order. */
  async function toggleChain(o: DeckOverview) {
    setError("");
    try {
      await api.setDeckChain(o.name, !o.chainByOrder);
      flash(`「${o.name}」顺序串联已${o.chainByOrder ? "关闭" : "开启"}`);
      loadOverview();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doSaveEdit() {
    if (editing == null) return;
    setError("");
    try {
      await api.updateCard(editing, editTitle, editContent);
      flash("卡片已保存");
      setEditing(null);
      refreshCurrent();
    } catch (e) {
      setError(String(e));
    }
  }

  /** SPEC §12.2: archived cards come back with their level intact. */
  async function doRestore(card: CardDto) {
    setError("");
    try {
      await api.restoreCard(card.id);
      flash(`「${card.title}」已恢复到复习队列`);
      refreshCurrent();
    } catch (e) {
      setError(String(e));
    }
  }

  function cardRow(c: CardDto, showDeck: boolean) {
    if (editing === c.id) {
      return (
        <div className="card-edit" key={c.id}>
          <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <textarea
            rows={5}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
          />
          <div>
            <button className="btn primary" onClick={() => void doSaveEdit()}>
              保存
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
          {/* 手动前后置关联（SPEC §11.1）：只影响呈现与顺链，不影响调度 */}
          <div className="link-editor">
            <div className="muted small">
              手动关联（复习时「知识铺垫 / 继续下一张」用；同章节顺序串联默认自动）
            </div>
            <div className="link-row">
              <span className="muted small">前置：</span>
              {links?.prev.length
                ? links.prev.map((p) => (
                    <span className="link-chip" key={p.id}>
                      {p.title}
                      <button title="移除" onClick={() => void removeLink(p.id, c.id)}>
                        ×
                      </button>
                    </span>
                  ))
                : <span className="muted small">无</span>}
            </div>
            <div className="link-row">
              <span className="muted small">后置：</span>
              {links?.next.length
                ? links.next.map((n) => (
                    <span className="link-chip" key={n.id}>
                      {n.title}
                      <button title="移除" onClick={() => void removeLink(c.id, n.id)}>
                        ×
                      </button>
                    </span>
                  ))
                : <span className="muted small">无</span>}
            </div>
            <input
              placeholder="搜索本包卡片，添加为前置/后置…"
              value={linkQuery}
              onChange={(e) => setLinkQuery(e.target.value)}
            />
            {linkResults.length > 0 && (
              <div className="link-results">
                {linkResults.map((r) => (
                  <div className="link-result" key={r.id}>
                    <span className="card-title-cell">
                      {r.title}
                      <small className="muted"> {r.chapter}</small>
                    </span>
                    <button className="btn small" onClick={() => void addLink(r, true)}>
                      设为前置
                    </button>
                    <button className="btn small" onClick={() => void addLink(r, false)}>
                      设为后置
                    </button>
                  </div>
                ))}
              </div>
            )}
            {linkMsg && <div className="error small">{linkMsg}</div>}
          </div>
        </div>
      );
    }
    return (
      <div className="deck-card-row" key={c.id}>
        <input
          type="checkbox"
          checked={selection.has(c.id)}
          onChange={() => toggleSelect(c.id)}
        />
        <span className="card-title-cell">
          {c.title}
          {showDeck && <small className="muted"> {c.deck} · {c.chapter}</small>}
        </span>
        <span className="muted small">
          {c.needsAttention && <span className="attention-tag">⚠ 需专项理解 </span>}
          {levelLabel(c.level, c.state)} · {fmtDue(c.dueAt)}
        </span>
        <span className="deck-actions">
          {c.state === "archived" ? (
            <button
              className="btn small primary"
              onClick={() => void doRestore(c)}
              title="恢复后回到轮换队列，熟练等级保留"
            >
              恢复
            </button>
          ) : (
            <button className="btn small" onClick={() => startEdit(c)}>
              编辑
            </button>
          )}
          <button className="btn small danger" onClick={() => void doDeleteCard(c)}>
            删除
          </button>
        </span>
      </div>
    );
  }

  return (
    <section className="page">
      <h1>卡包</h1>
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="🔍 搜索卡片标题或内容…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={selection.size === 0}
          onClick={() => void reviewSelected()}
        >
          复习选中（{selection.size}）
        </button>
        {selection.size > 0 && (
          <button className="btn" onClick={() => setSelection(new Set())}>
            清空选择
          </button>
        )}
      </div>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}

      {flatMode ? (
        <div className="card-block">
          <div className="deck-row">
            <label className="muted small">
              <input
                type="checkbox"
                checked={results !== null && results.length > 0 && results.every((c) => selection.has(c.id))}
                onChange={() => toggleAll(results ?? [])}
              />
              全选结果
            </label>
            <span className="muted small">
              {results === null ? "搜索中…" : `${results.length} 张卡片`}
            </span>
          </div>
          {(results ?? []).map((c) => cardRow(c, true))}
          {results !== null && results.length === 0 && (
            <p className="muted small">没有匹配的卡片</p>
          )}
        </div>
      ) : (
        <>
          {overview.length === 0 && (
            <p className="muted">还没有卡包——先到「导入」或「添加卡片」创建。</p>
          )}
          {overview.map((o) => (
            <div className="card-block" key={o.name}>
              <div className="deck-row">
                <span className="deck-name" onClick={() => void toggleDeck(o.name)} role="button">
                  {openDeck === o.name ? "▾" : "▸"} {o.name}
                </span>
                <span className="muted small">
                  {o.chapterCount} 章 · {o.cardCount} 卡 · 到期 {o.dueCount}
                </span>
                <span className="deck-actions">
                  <button
                    className="btn small"
                    title="按导入顺序自动串联同章节卡片（知识铺垫与顺链续复习）"
                    onClick={() => void toggleChain(o)}
                  >
                    🔗 {o.chainByOrder ? "串联中" : "已关闭"}
                  </button>
                  <button className="btn small" onClick={() => void reviewDeck(o.name)}>
                    复习该包
                  </button>
                  <button
                    className="btn small"
                    onClick={() => {
                      setRenaming(o.name);
                      setRenameValue(o.name);
                    }}
                  >
                    重命名
                  </button>
                  <button className="btn small danger" onClick={() => void doDeleteDeck(o.name)}>
                    删除
                  </button>
                </span>
              </div>
              {renaming === o.name && (
                <div className="form-row">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void doRename(o.name)}
                  />
                  <button className="btn primary" onClick={() => void doRename(o.name)}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setRenaming(null)}>
                    取消
                  </button>
                </div>
              )}
              {openDeck === o.name && (
                <div className="deck-cards">
                  {cards.length > 0 && (
                    <label className="muted small">
                      <input
                        type="checkbox"
                        checked={cards.every((c) => selection.has(c.id))}
                        onChange={() => toggleAll(cards)}
                      />
                      全选本包（{cards.length} 张）
                    </label>
                  )}
                  {/* Group by chapter, preserving the reading order. */}
                  {chaptersOf(cards).map(([chapter, list]) => (
                    <div className="deck-chapter" key={chapter}>
                      <div className="deck-chapter-title">
                        <span>{chapter}</span>
                        <span className="muted small">
                          {list.length} 张
                          <button className="btn small" onClick={() => toggleAll(list)}>
                            全选
                          </button>
                        </span>
                      </div>
                      {list.map((c) => cardRow(c, false))}
                    </div>
                  ))}
                  {cards.length === 0 && <p className="muted small">该卡包暂无卡片</p>}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
