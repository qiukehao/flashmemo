import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, type CardDto, type RatingName } from "../lib/api";
import { isTextEntryTarget } from "../lib/dom";
import { isTauri } from "../lib/env";
import { formatGap, mapKeyToRating, type RatingAction } from "../lib/format";
import { renderCard } from "../lib/markdown";
import { htmlToMarkdown, insertNoteBlock, wrapSelection } from "../lib/wysiwyg";

const appWindow = isTauri() ? getCurrentWebviewWindow() : null;

function closeWindow() {
  if (appWindow) {
    appWindow.close().catch(() => {});
  } else {
    // Browser mock mode has no second window: go back to the management view.
    window.location.search = "?window=main";
  }
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
  // The revealed card is ALWAYS editable in place (WYSIWYG, SPEC §9.2) — no
  // edit-mode toggle. The DOM is uncontrolled: innerHTML is written once per
  // card so autosaves can never reset the caret.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedSnapshot = useRef("");
  const autosaveTimer = useRef<number | null>(null);

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

  // (Re)write the editor DOM when the card changes OR when the editor first
  // mounts (reveal toggles it into existence) — never on save, so the caret
  // survives autosaves.
  useEffect(() => {
    if (!revealed) return;
    const el = editorRef.current;
    if (!el || !card) return;
    el.innerHTML = renderCard(card.contentMd);
    savedSnapshot.current = card.contentMd;
    setSaveState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, revealed]);

  /** Serialize the edited DOM back to markdown and persist if it changed. */
  const flushEditor = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || !card) return;
    const md = htmlToMarkdown(editor.innerHTML);
    if (md === savedSnapshot.current) return;
    setSaveState("saving");
    try {
      const updated = await api.saveCardContent(card.id, md);
      savedSnapshot.current = md;
      setQueue((q) => q.map((c) => (c.id === updated.id ? updated : c)));
      setSaveState("saved");
    } catch {
      setSaveState("idle");
    }
  }, [card]);

  /** Debounced autosave while typing (SPEC §9.2: 防抖，绝不丢批注). */
  const scheduleAutosave = useCallback(() => {
    setSaveState("idle");
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void flushEditor(), AUTOSAVE_MS);
  }, [flushEditor]);

  /** Toolbar actions: apply the annotation trio to the live selection. */
  function applyBold() {
    const editor = editorRef.current;
    if (editor) wrapSelection(editor, "strong");
    scheduleAutosave();
  }
  function applyHighlight() {
    const editor = editorRef.current;
    if (editor) wrapSelection(editor, "mark");
    scheduleAutosave();
  }
  function applyNote() {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = window.getSelection();
    const collapsed = !sel || sel.isCollapsed;
    if (collapsed) insertNoteBlock(editor);
    else wrapSelection(editor, "div", "card-note");
    scheduleAutosave();
  }

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
    await flushEditor();
    if (card) await api.skipCard(card.id).catch(() => {});
    advance();
  }, [card, advance, flushEditor]);

  const closeAll = useCallback(async () => {
    await flushEditor();
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    closeWindow();
  }, [queue, idx, flushEditor]);

  const rate = useCallback(
    async (name: RatingName) => {
      if (!card || !revealed) return;
      await flushEditor();
      await api.rateCard(card.id, name).catch(() => {});
      advance();
    },
    [card, revealed, advance, flushEditor],
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
      // Typing inside the editable card belongs to the text: Esc leaves the
      // editor, Ctrl+Enter forces a save. Everything else is plain typing.
      if (isTextEntryTarget(e.target)) {
        if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void flushEditor();
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
  }, [act, flushEditor]);

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
          <>
            <div className="popup-edit-toolbar">
              <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={applyBold} title="加粗选中文字（Ctrl+B）">
                <b>B</b>
              </button>
              <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={applyHighlight} title="高亮选中文字">
                🖍 高亮
              </button>
              <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={applyNote} title="备注（选中则包裹，未选中则插入）">
                📝 备注
              </button>
              <span className="edit-status muted small">
                {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "选中文字即可批注"}
              </span>
            </div>
            <div
              ref={editorRef}
              className="popup-edit-wysiwyg popup-back"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onInput={scheduleAutosave}
              onKeyDown={(e) => {
                if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  applyBold();
                }
              }}
            />
          </>
        ) : (
          <button className="popup-reveal" onClick={() => act("reveal")}>
            显示答案（空格）
          </button>
        )}
      </div>

      <footer className="popup-footer">
        {showHint && (
          <div className="popup-hint">
            1=不了解 2=熟悉 3=可以讲出来；答案区可直接点选文字批注
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
