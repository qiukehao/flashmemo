import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CardDto, type RatingName } from "../lib/api";
import { formatInterval, mapKeyToRating, type RatingAction } from "../lib/format";
import { renderCard } from "../lib/markdown";

const RATINGS: { name: RatingName; label: string; idx: number }[] = [
  { name: "again", label: "重来", idx: 0 },
  { name: "hard", label: "困难", idx: 1 },
  { name: "good", label: "良好", idx: 2 },
  { name: "easy", label: "简单", idx: 3 },
];

const HINT_MAX = 3;

export default function ReviewPopup() {
  const [queue, setQueue] = useState<CardDto[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<(number | null)[]>([]);
  const [hintCount, setHintCount] = useState(HINT_MAX);
  const hintSaved = useRef(true);

  const card = queue[idx];
  const loading = queue.length === 0;

  useEffect(() => {
    (async () => {
      try {
        const settings = await api.getSettings();
        const per = Number.parseInt(settings.per_popup ?? "1", 10) || 1;
        const q = await api.dueQueue(per);
        setQueue(q);
        setHintCount(Number.parseInt(settings.hint_shown_count ?? "0", 10) || 0);
        hintSaved.current = false;
        if (q.length === 0) window.close();
      } catch {
        window.close();
      }
    })();
  }, []);

  // Fetch interval previews per card (SPEC §7.5: buttons show the next interval).
  useEffect(() => {
    if (!card) return;
    api
      .previewIntervals(card.id)
      .then(setPreviews)
      .catch(() => setPreviews([]));
    if (hintSaved.current) return;
    hintSaved.current = true;
    if (card.state === "new" && hintCount < HINT_MAX) {
      setHintCount((c) => c + 1);
      api
        .setSettings({ hint_shown_count: String(hintCount + 1) })
        .catch(() => {});
    }
  }, [card, hintCount]);

  const advance = useCallback(() => {
    setRevealed(false);
    setIdx((i) => {
      if (i + 1 < queue.length) return i + 1;
      window.close();
      return i;
    });
  }, [queue.length]);

  /** SPEC §8.4: Esc/✕ postpone unrated cards by the skip delay (no rating). */
  const skipCurrent = useCallback(async () => {
    if (card) await api.skipCard(card.id).catch(() => {});
    advance();
  }, [card, advance]);

  const closeAll = useCallback(async () => {
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    window.close();
  }, [queue, idx]);

  const rate = useCallback(
    async (name: RatingName) => {
      if (!card || !revealed) return;
      await api.rateCard(card.id, name).catch(() => {});
      advance();
    },
    [card, revealed, advance],
  );

  const act = useCallback(
    (action: RatingAction) => {
      if (loading) return;
      if (action === "reveal") {
        setRevealed(true);
      } else if (action === "skip") {
        void skipCurrent();
      } else {
        void rate(action);
      }
    },
    [loading, skipCurrent, rate],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = mapKeyToRating(e.key);
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [act]);

  if (loading) {
    return <div className="popup-root popup-empty">没有待复习的卡片</div>;
  }

  const showHint = card.state === "new" && hintCount <= HINT_MAX;

  return (
    <div className="popup-root">
      <header className="popup-header">
        <span className="popup-crumb">
          {card.deck} · {card.chapter}
        </span>
        <button className="popup-close" onClick={() => void closeAll()} title="关闭并跳过剩余">
          ✕
        </button>
      </header>

      <div className="popup-body">
        <div className="popup-front">{card.title}</div>
        {revealed ? (
          <div
            className="popup-back"
            // markdown-it escapes raw HTML (html:false) before this injection.
            dangerouslySetInnerHTML={{ __html: renderCard(card.contentMd) }}
          />
        ) : (
          <button className="popup-reveal" onClick={() => act("reveal")}>
            显示答案（空格）
          </button>
        )}
      </div>

      <footer className="popup-footer">
        {showHint && (
          <div className="popup-hint">
            1=重来 2=困难 3=良好 4=简单，按钮下方的数字是下次出现间隔
          </div>
        )}
        <div className="popup-buttons">
          <button className="popup-btn skip" onClick={() => void skipCurrent()}>
            跳过
          </button>
          {RATINGS.map((r) => (
            <button
              key={r.name}
              className={`popup-btn ${r.name}`}
              disabled={!revealed}
              onClick={() => void rate(r.name)}
            >
              {r.label}
              <small>{formatInterval(previews[r.idx] ?? null)}</small>
            </button>
          ))}
        </div>
        <div className="popup-progress">
          第 {idx + 1}/{queue.length} 张 · 本次会话
        </div>
      </footer>
    </div>
  );
}
