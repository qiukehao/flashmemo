import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, type CardDto, type RatingName } from "../lib/api";
import { formatGap, mapKeyToRating, type RatingAction } from "../lib/format";
import { renderCard } from "../lib/markdown";

const appWindow = getCurrentWebviewWindow();

function closeWindow() {
  appWindow.close().catch(() => {});
}

const RATINGS: { name: RatingName; label: string; idx: number }[] = [
  { name: "unknown", label: "不了解", idx: 0 },
  { name: "familiar", label: "熟悉", idx: 1 },
  { name: "speakable", label: "可以讲出来", idx: 2 },
];

const HINT_MAX = 3;

export default function ReviewPopup() {
  const [queue, setQueue] = useState<CardDto[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<number[]>([]);
  const [hintCount, setHintCount] = useState(HINT_MAX);
  const hintSaved = useRef(true);

  const card = queue[idx];
  const loading = queue.length === 0;

  useEffect(() => {
    (async () => {
      try {
        const settings = await api.getSettings();
        // A pending manual selection wins; otherwise the due queue batch.
        const q = await api.reviewQueue();
        setQueue(q);
        setHintCount(Number.parseInt(settings.hint_shown_count ?? "0", 10) || 0);
        hintSaved.current = false;
        if (q.length === 0) closeWindow();
      } catch {
        closeWindow();
      }
    })();
  }, []);

  // Fetch interval previews per card (SPEC §7.5: buttons show the next
  // interval) and record the display for throttling (design §2).
  useEffect(() => {
    if (!card) return;
    api
      .previewIntervals(card.id)
      .then(setPreviews)
      .catch(() => setPreviews([]));
    api.markShown(card.id).catch(() => {});
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
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
    } else {
      closeWindow();
    }
  }, [idx, queue.length]);

  /** SPEC §8.4: Esc/✕ postpone unrated cards by the skip delay (no rating). */
  const skipCurrent = useCallback(async () => {
    if (card) await api.skipCard(card.id).catch(() => {});
    advance();
  }, [card, advance]);

  const closeAll = useCallback(async () => {
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    closeWindow();
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
      {/* Borderless window: this header is the drag region (SPEC §8.3). */}
      <header className="popup-header" data-tauri-drag-region>
        <span className="popup-crumb" data-tauri-drag-region>
          {card.deck} · {card.chapter}
          {card.needsAttention && " ⚠ 需专项理解"}
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
            1=不了解 2=熟悉 3=可以讲出来，按钮下方的数字是还要隔几张卡
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
              <small>{formatGap(previews[r.idx] ?? null)}</small>
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
