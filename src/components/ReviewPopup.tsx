import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, type CardDto, type RatingName } from "../lib/api";
import { formatGap, mapKeyToRating, type RatingAction } from "../lib/format";
import { renderCard } from "../lib/markdown";
import { htmlToMarkdown, insertNoteBlock, wrapSelection } from "../lib/wysiwyg";

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
  // WYSIWYG annotation editing (SPEC §9.2): edit the rendered card in place.
  const [editing, setEditing] = useState(false);
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

  function startEditing() {
    if (!card) return;
    savedSnapshot.current = card.contentMd;
    setSaveState("idle");
    setEditing(true);
    setTimeout(() => editorRef.current?.focus(), 0);
  }

  const stopEditing = useCallback(async () => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    await flushEditor();
    setEditing(false);
  }, [flushEditor]);

  /** Toolbar actions: apply the annotation trio to the live selection. */
  function applyBold() {
    const editor = editorRef.current;
    if (editor) wrapSelection(editor, "strong");
  }
  function applyHighlight() {
    const editor = editorRef.current;
    if (editor) wrapSelection(editor, "mark");
  }
  function applyNote() {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = window.getSelection();
    const collapsed = !sel || sel.isCollapsed;
    if (collapsed) insertNoteBlock(editor);
    else wrapSelection(editor, "div", "card-note");
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
    if (editing) await flushEditor();
    if (card) await api.skipCard(card.id).catch(() => {});
    advance();
  }, [card, advance, flushEditor, editing]);

  const closeAll = useCallback(async () => {
    if (editing) await flushEditor();
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    closeWindow();
  }, [queue, idx, flushEditor, editing]);

  const rate = useCallback(
    async (name: RatingName) => {
      if (!card || !revealed) return;
      if (editing) await flushEditor();
      await api.rateCard(card.id, name).catch(() => {});
      advance();
    },
    [card, revealed, advance, flushEditor, editing],
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
      // While annotating, the keyboard belongs to the editor: Esc exits the
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
              <button className="btn small" onClick={applyBold} title="加粗（Ctrl+B）">
                <b>B</b>
              </button>
              <button className="btn small" onClick={applyHighlight} title="高亮选中文字">
                🖍 高亮
              </button>
              <button className="btn small" onClick={applyNote} title="插入/包裹备注">
                📝 备注
              </button>
              <span className="edit-status muted small">
                {saveState === "saving"
                  ? "保存中…"
                  : saveState === "saved"
                    ? "已保存"
                    : "编辑中（所见即所得）"}
              </span>
              <button className="btn small primary" onClick={() => void stopEditing()}>
                完成
              </button>
            </div>
            {/* WYSIWYG: the rendered card itself is editable in place. */}
            <div
              key={card.id}
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
              dangerouslySetInnerHTML={{ __html: renderCard(card.contentMd) }}
            />
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
