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
const AUTOSAVE_MS = 800;

export default function ReviewPopup() {
  const [queue, setQueue] = useState<CardDto[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<number[]>([]);
  const [hintCount, setHintCount] = useState(HINT_MAX);
  const hintSaved = useRef(true);
  // Annotation editing (SPEC §9.2).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const savedSnapshot = useRef("");

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

  // Fetch card-gap previews per card (SPEC §7.7) and record the display that
  // advances the global seq counter (design §1).
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

  /** Persist the draft if it differs from the last saved snapshot. */
  const flushDraft = useCallback(async () => {
    if (!card) return;
    const current = draft;
    if (current === savedSnapshot.current) return;
    setSaveState("saving");
    try {
      const updated = await api.saveCardContent(card.id, current);
      savedSnapshot.current = current;
      setQueue((q) => q.map((c) => (c.id === updated.id ? updated : c)));
      setSaveState("saved");
    } catch {
      setSaveState("idle");
    }
  }, [card, draft]);

  // Debounced autosave while editing (SPEC §9.2: 防抖 800ms，绝不丢批注).
  useEffect(() => {
    if (!editing) return;
    if (draft === savedSnapshot.current) return;
    const t = setTimeout(() => void flushDraft(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, editing, flushDraft]);

  function startEditing() {
    if (!card) return;
    setDraft(card.contentMd);
    savedSnapshot.current = card.contentMd;
    setSaveState("idle");
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const stopEditing = useCallback(async () => {
    await flushDraft();
    setEditing(false);
  }, [flushDraft]);

  /** Wrap the current textarea selection with the annotation syntax (§9.1). */
  function wrapSelection(marker: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd, value } = ta;
    const selected = value.slice(selectionStart, selectionEnd);
    const next =
      value.slice(0, selectionStart) + marker + selected + marker + value.slice(selectionEnd);
    setDraft(next);
    const pos = selectionStart + marker.length + selected.length + marker.length;
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(selected ? pos : selectionStart + marker.length, pos);
    }, 0);
  }

  const advance = useCallback(() => {
    setRevealed(false);
    setEditing(false);
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
    } else {
      closeWindow();
    }
  }, [idx, queue.length]);

  /** SPEC §8.4: Esc/✕ postpone unrated cards by the skip delay (no rating). */
  const skipCurrent = useCallback(async () => {
    await flushDraft();
    if (card) await api.skipCard(card.id).catch(() => {});
    advance();
  }, [card, advance, flushDraft]);

  const closeAll = useCallback(async () => {
    await flushDraft();
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    closeWindow();
  }, [queue, idx, flushDraft]);

  const rate = useCallback(
    async (name: RatingName) => {
      if (!card || !revealed) return;
      await flushDraft();
      await api.rateCard(card.id, name).catch(() => {});
      advance();
    },
    [card, revealed, advance, flushDraft],
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
      // While annotating, the keyboard belongs to the textarea: Esc exits the
      // editor (SPEC §9.2), Ctrl+Enter finishes it.
      if (editing) {
        if (e.key === "Escape") {
          e.preventDefault();
          void stopEditing();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void stopEditing();
        }
        return;
      }
      const action = mapKeyToRating(e.key);
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [act, editing, stopEditing]);

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
        {revealed && !editing && (
          <button className="popup-icon-btn" onClick={startEditing} title="批注（编辑卡面）">
            ✏️
          </button>
        )}
        <button className="popup-close" onClick={() => void closeAll()} title="关闭并跳过剩余">
          ✕
        </button>
      </header>

      <div className="popup-body">
        <div className="popup-front">{card.title}</div>
        {editing ? (
          <div className="popup-edit">
            <div className="popup-edit-toolbar">
              <button className="btn small" onClick={() => wrapSelection("**")} title="加粗 Ctrl+B">
                <b>B</b>
              </button>
              <button className="btn small" onClick={() => wrapSelection("==")} title="高亮">
                🖍 高亮
              </button>
              <button className="btn small" onClick={() => wrapSelection("%%")} title="备注">
                📝 备注
              </button>
              <span className="edit-status muted small">
                {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "编辑中"}
              </span>
              <button className="btn small primary" onClick={() => void stopEditing()}>
                完成
              </button>
            </div>
            <textarea
              ref={textareaRef}
              className="popup-edit-input"
              value={draft}
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaveState("idle");
              }}
              onKeyDown={(e) => {
                if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  wrapSelection("**");
                }
              }}
            />
            <div className="popup-edit-preview">
              <div className="muted small">实时预览</div>
              <div dangerouslySetInnerHTML={{ __html: renderCard(draft) }} />
            </div>
          </div>
        ) : revealed ? (
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
        {showHint && !editing && (
          <div className="popup-hint">
            1=不了解 2=熟悉 3=可以讲出来，按钮下方的数字是还要隔几张卡
          </div>
        )}
        <div className="popup-buttons">
          <button className="popup-btn skip" disabled={editing} onClick={() => void skipCurrent()}>
            跳过
          </button>
          {RATINGS.map((r) => (
            <button
              key={r.name}
              className={`popup-btn ${r.name}`}
              disabled={!revealed || editing}
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
