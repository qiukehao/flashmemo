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
  const label = today ? hhmm : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " " + hhmm;
  return past ? `已到期 ${label}` : label;
}

/** Read-only deck preview (full management lands in M2, SPEC §15.2). */
export default function DecksPage() {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDto[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listOverview()
      .then(setOverview)
      .catch((e) => setError(String(e)));
  }, []);

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

  return (
    <section className="page">
      <h1>卡包</h1>
      {overview.length === 0 && (
        <p className="muted">还没有卡包——先到「导入」或「添加卡片」创建。</p>
      )}
      {overview.map((o) => (
        <div className="card-block" key={o.name}>
          <div
            className="deck-row"
            onClick={() => void toggle(o.name)}
            role="button"
          >
            <span className="deck-name">{openDeck === o.name ? "▾" : "▸"} {o.name}</span>
            <span className="muted">
              {o.chapterCount} 章 · {o.cardCount} 卡 · 到期 {o.dueCount}
            </span>
          </div>
          {openDeck === o.name && (
            <div className="deck-cards">
              {cards.map((c) => (
                <div className="deck-card-row" key={c.id}>
                  <span>{c.title}</span>
                  <span className="muted small">
                    {STATE_LABEL[c.state] ?? c.state} · {fmtDue(c.dueAt)}
                  </span>
                </div>
              ))}
              {cards.length === 0 && <p className="muted small">该卡包暂无卡片</p>}
            </div>
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
