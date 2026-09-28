import { useEffect, useState } from "react";
import { api, type CardDto, type DeckOverview } from "../lib/api";

const STATE_LABEL: Record<string, string> = {
  new: "新卡",
  learning: "学习中",
  review: "复习中",
  relearning: "重学",
  suspended: "已删除",
  archived: "已归档",
};

function fmtDue(iso: string): string {
  const d = new Date(iso);
  const past = d.getTime() <= Date.now();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  const label =
    (today ? "" : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " ") +
    hhmm;
  return past ? `已到期 ${label}` : label;
}

/** Deck management: rename / delete decks, edit / delete cards (SPEC §15.2). */
export default function DecksPage() {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDto[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  function loadOverview() {
    api
      .listOverview()
      .then(setOverview)
      .catch((e) => setError(String(e)));
  }

  useEffect(loadOverview, []);

  async function toggle(name: string) {
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

  async function doDeleteCard(card: CardDto) {
    if (!confirm(`确定删除卡片「${card.title}」？`)) return;
    setError("");
    try {
      await api.deleteCard(card.id);
      flash("卡片已删除");
      if (openDeck) setCards(await api.listCards(openDeck));
      loadOverview();
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(card: CardDto) {
    setEditing(card.id);
    setEditTitle(card.title);
    setEditContent(card.contentMd);
  }

  async function doSaveEdit() {
    if (editing == null) return;
    setError("");
    try {
      await api.updateCard(editing, editTitle, editContent);
      flash("卡片已保存");
      setEditing(null);
      if (openDeck) setCards(await api.listCards(openDeck));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="page">
      <h1>卡包</h1>
      {msg && <p className="ok">{msg}</p>}
      {overview.length === 0 && (
        <p className="muted">还没有卡包——先到「导入」或「添加卡片」创建。</p>
      )}
      {overview.map((o) => (
        <div className="card-block" key={o.name}>
          <div className="deck-row">
            <span className="deck-name" onClick={() => void toggle(o.name)} role="button">
              {openDeck === o.name ? "▾" : "▸"} {o.name}
            </span>
            <span className="muted small">
              {o.chapterCount} 章 · {o.cardCount} 卡 · 到期 {o.dueCount}
            </span>
            <span className="deck-actions">
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
              {cards.map((c) =>
                editing === c.id ? (
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
                  </div>
                ) : (
                  <div className="deck-card-row" key={c.id}>
                    <span>{c.title}</span>
                    <span className="muted small">
                      {STATE_LABEL[c.state] ?? c.state} · {fmtDue(c.dueAt)}
                    </span>
                    <span className="deck-actions">
                      <button className="btn small" onClick={() => startEdit(c)}>
                        编辑
                      </button>
                      <button className="btn small danger" onClick={() => void doDeleteCard(c)}>
                        删除
                      </button>
                    </span>
                  </div>
                ),
              )}
              {cards.length === 0 && <p className="muted small">该卡包暂无卡片</p>}
            </div>
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
