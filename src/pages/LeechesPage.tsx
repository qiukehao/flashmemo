import { useCallback, useEffect, useState } from "react";
import { api, type CardDto } from "../lib/api";

const LEVEL_NAMES = ["新卡", "刚接触", "能回忆", "基本熟练", "长期维护", "长期维护"];

/** 疑难卡片（SPEC §12.1）: consecutive-Unknown cards that need deliberate work. */
export default function LeechesPage({ onBack }: { onBack: () => void }) {
  const [cards, setCards] = useState<CardDto[]>([]);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .listAttentionCards()
      .then(setCards)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  async function clearOne(card: CardDto) {
    try {
      await api.clearAttention(card.id);
      setMsg(`已解除「${card.title}」的重点标记`);
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function resetOne(card: CardDto) {
    if (!confirm(`重置「${card.title}」的复习进度？（回到刚接触，遗忘计数清零）`)) return;
    try {
      await api.resetCardProgress(card.id);
      setMsg(`已重置「${card.title}」`);
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="page">
      <button className="page-back btn" onClick={onBack}>
        ← 返回首页
      </button>
      <h1>疑难卡</h1>
      <p className="muted small">
        连续多次评「不了解」的卡片会自动出现在这里。建议先补强理解或拆分卡片，再解除标记或重置进度。
      </p>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
      {cards.length === 0 && <p className="muted">目前没有疑难卡，保持住 🎉</p>}
      {cards.map((c) => (
        <div className="card-block" key={c.id}>
          <div className="deck-row">
            <span className="card-title-cell">
              {c.title}
              <small className="muted"> {c.deck} · {c.chapter}</small>
            </span>
            <span className="muted small">
              遗忘 {c.lapses} 次 · {LEVEL_NAMES[Math.min(Math.max(c.level, 0), 5)]}
            </span>
            <span className="deck-actions">
              <button className="btn small" onClick={() => void clearOne(c)}>
                解除标记
              </button>
              <button className="btn small danger" onClick={() => void resetOne(c)}>
                重置进度
              </button>
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}
