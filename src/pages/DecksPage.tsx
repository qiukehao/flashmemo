import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CardDto, type CardLinks, type DeckOverview, errText } from "../lib/api";
import EditContextMenu from "../components/EditContextMenu";
import { copyText } from "../lib/dom";
import { isTauri } from "../lib/env";
import { insertPickedImage, pasteIntoCardEditor } from "../lib/imageInsert";
import { attachNotePopover } from "../lib/notePopover";
import { logFrontend } from "../lib/logger";
import { composeQuestion, fillAiQuestion } from "../lib/aiAsk";
import { renderCard } from "../lib/markdown";
import {
  createUndoStack,
  handleQuoteExit,
  htmlToMarkdown,
  insertNoteBlock,
  wrapSelection,
} from "../lib/wysiwyg";

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
  // 与首页「待复习」/ 托盘同名（SPEC §14.1）：同一个谓词、同一个词。
  { key: "due", label: "待复习" },
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
export default function DecksPage({
  initialFilter = "all",
  openCardId = null,
  onCardOpened,
}: {
  initialFilter?: string;
  /** Jump-to-edit target (§11.2): auto-open this card's editor on mount. */
  openCardId?: number | null;
  onCardOpened?: () => void;
} = {}) {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDto[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(initialFilter);
  const [results, setResults] = useState<CardDto[] | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editFront, setEditFront] = useState("");
  // Workspace WYSIWYG editing (SPEC §9.2, same model as the review popup):
  // the contenteditable renders the card; saves convert the DOM back to
  // markdown (debounced). Refs keep the flush stable across card switches.
  const editorRef = useRef<HTMLDivElement | null>(null);
  // 题面区（正面，SPEC §5.2 rule 13）：与背面同一套 WYSIWYG。`frontDirty` 只在
  // 用户真的动过题面时才置位——`front_md` 的 DOM→markdown 往返并非逐字节恒等，
  // 没编辑就不该顺手改写它（否则每次改背面都会重写题面）。
  const frontRef = useRef<HTMLDivElement | null>(null);
  const frontDirty = useRef(false);
  const savedSnapshot = useRef("");
  const autosaveTimer = useRef<number | null>(null);
  const editingRef = useRef<number | null>(null);
  const titleRef = useRef("");
  // 撤销/重做（2026-10-07）：批注动作是直接 DOM 手术，原生撤销栈靠不住。
  // 两个编辑器各一份；push 有去重，scheduleAutosave 里两份一起推不会错记。
  const undo = useMemo(() => createUndoStack(() => editorRef.current), []);
  const frontUndo = useMemo(() => createUndoStack(() => frontRef.current), []);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // 右键批注菜单（与弹窗同一套交互）：打开位置 + 选区是否为空 + 选区文本（问 AI 用）。
  const [editMenu, setEditMenu] = useState<{
    x: number;
    y: number;
    collapsed: boolean;
    selected: string;
  } | null>(null);
  const [chipVisible, setChipVisible] = useState(false);
  // Manual 前置/后置 links of the card being edited (SPEC §11.1).
  const [links, setLinks] = useState<CardLinks | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<CardDto[]>([]);
  const [linkMsg, setLinkMsg] = useState("");
  const [workspaceDeck, setWorkspaceDeck] = useState<string | null>(null);

  const flatMode = query.trim() !== "" || filter !== "all";

  const loadOverview = useCallback(() => {
    api
      .listOverview()
      .then(setOverview)
      .catch((e) => setError(errText(e)));
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
        .catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [query, filter, flatMode]);

  async function openWorkspace(name: string) {
    setWorkspaceDeck(name);
    setOpenDeck(name);
    setError("");
    try {
      const loaded = await api.listCards(name);
      setCards(loaded);
      if (loaded.length > 0) startEdit(loaded[0]);
      else setEditing(null);
    } catch (e) {
      setError(errText(e));
    }
  }

  function closeWorkspace() {
    setWorkspaceDeck(null);
    setOpenDeck(null);
    setEditing(null);
    setLinks(null);
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
      setError(errText(e));
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
      setError(errText(e));
    }
  }

  /** 导出全部卡包为 Markdown（浏览器调试模式无保存对话框，提示走桌面版）。 */
  async function exportAll() {
    if (!isTauri()) {
      flash("浏览器调试模式不支持保存文件，请在桌面版导出");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: "闪记导出.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      const r = await api.exportMarkdown(path);
      flash(`已导出 ${r.decks} 个卡包 · ${r.cards} 张卡`);
    } catch (e) {
      setError(errText(e));
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
      setError(errText(e));
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
      setError(errText(e));
    }
  }

  async function doDeleteCard(card: CardDto) {    if (!confirm(`确定删除卡片「${card.title}」？`)) return;
    setError("");
    try {
      await api.deleteCard(card.id);
      flash("卡片已删除");
      refreshCurrent();
    } catch (e) {
      setError(errText(e));
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

  /** Persist WYSIWYG edits: DOM → markdown → update_card (title included so
   *  title edits autosave too). No-op when the workspace editor isn't mounted
   *  (the flat-view inline editor saves through doSaveEdit instead). */
  const flushEditor = useCallback(async () => {
    const editor = editorRef.current;
    const id = editingRef.current;
    if (!editor || id == null) return;
    let md: string;
    try {
      md = htmlToMarkdown(editor.innerHTML);
    } catch (e) {
      // 转换异常绝不能静默吞掉这次编辑（Bug2）：报错留在界面上，
      // 编辑器里的内容原样保留，用户可以复制或重试。
      void logFrontend("error", `workspace: htmlToMarkdown failed: ${String(e)}`);
      setError("卡面保存失败（结构异常），本次改动未写入，请复制内容后重试");
      setSaveState("idle");
      return;
    }
    if (md === savedSnapshot.current && !frontDirty.current) return;
    let frontMd: string | undefined;
    if (frontDirty.current) {
      const front = frontRef.current;
      try {
        frontMd = front ? htmlToMarkdown(front.innerHTML) : "";
      } catch (e) {
        void logFrontend("error", `workspace: front htmlToMarkdown failed: ${String(e)}`);
        setError("题面保存失败（结构异常），本次改动未写入，请复制内容后重试");
        setSaveState("idle");
        return;
      }
    }
    setSaveState("saving");
    try {
      const updated = await api.updateCard(id, titleRef.current, md, frontMd);
      savedSnapshot.current = md;
      if (frontMd !== undefined) frontDirty.current = false;
      setSaveState("saved");
      setCards((list) => list.map((c) => (c.id === updated.id ? { ...c, title: updated.title } : c)));
    } catch {
      setSaveState("idle");
    }
  }, []);

  /** Debounced autosave while typing (SPEC §9.2: 防抖，绝不丢批注). */
  const scheduleAutosave = useCallback(() => {
    // 撤销快照在改动落地时立刻压栈（action 步）；打字的合并由 onInput 侧做。
    undo.push();
    frontUndo.push();
    setSaveState("idle");
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void flushEditor(), 800);
  }, [flushEditor, undo, frontUndo]);

  // 备注悬浮弹窗：编辑器（背面/题面）里的 .card-note 摘要条悬浮出浮层。
  // 换卡重写 DOM 后重新挂一遍，返回的清理函数跟着 effect 生命周期走。
  useEffect(() => {
    const editor = editorRef.current;
    const front = frontRef.current;
    if (!editor) return;
    const detachEditor = attachNotePopover(editor);
    const detachFront = front ? attachNotePopover(front) : () => {};
    return () => {
      detachEditor();
      detachFront();
    };
  }, [editing]);

  // 保存角标：saving 时常显，saved 显示 1.6s 后自动消失。
  useEffect(() => {
    if (saveState === "idle") {
      setChipVisible(false);
      return;
    }
    setChipVisible(true);
    if (saveState === "saved") {
      const t = window.setTimeout(() => setChipVisible(false), 1600);
      return () => window.clearTimeout(t);
    }
  }, [saveState]);

  /** 右键菜单里的「问 AI」：标题 + 卡面内容打底，划选了文字就针对性提问。
   *  AI 助手是独立窗口（2026-10-07 重做）：打开/聚焦它，再把问题写进站点
   *  输入框（剪贴板已兜底）。 */
  function askAiWithSelection(selection: string) {
    const md =
      editorRef.current && editingRef.current === editing
        ? htmlToMarkdown(editorRef.current.innerHTML)
        : editContent;
    const text = composeQuestion(editTitle || "闪卡", md, selection);
    void copyText(text);
    void api.aiWindowShow("main").catch(() => {});
    void fillAiQuestion(text);
  }

  /** 右键菜单：图标矩阵 + 子菜单 +「问 AI」，动作大多由菜单内部完成，这里只传
   *  编辑器与它自己管不了的回调（备注/选图/自动保存/问 AI）。 */
  const editMenuPortal =
    editMenu && editorRef.current ? (
      <EditContextMenu
        x={editMenu.x}
        y={editMenu.y}
        editor={editorRef.current}
        collapsed={editMenu.collapsed}
        onNote={applyNote}
        onPickImage={applyImage}
        onChange={scheduleAutosave}
        onAskAi={() => askAiWithSelection(editMenu.selected)}
        onClose={() => setEditMenu(null)}
      />
    ) : null;

  function applyBold() {
    if (editorRef.current) wrapSelection(editorRef.current, "strong");
    scheduleAutosave();
  }
  function applyNote() {
    const el = editorRef.current;
    if (!el) return;
    // 备注 = 非破坏性批注（2026-10-07 二次反馈）：原文一字不动，段落后插空备注。
    if (!insertNoteBlock(el)) return;
    scheduleAutosave();
  }
  /** 🖼 图片: same store-and-insert flow as the review popup (SPEC §9.4). */
  function applyImage() {
    const el = editorRef.current;
    if (!el) return;
    void insertPickedImage(el).then((ok) => {
      if (ok) scheduleAutosave();
    });
  }
  /** Ctrl+V of a screenshot / rich content: unified paste (attachment refs +
   *  normalized card markup, 2026-10-07). Sync call — preventDefault only
   *  works during event dispatch. */
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const el = editorRef.current;
    if (!el) return;
    if (pasteIntoCardEditor(el, e.nativeEvent)) scheduleAutosave();
  }

  /** 题面区（正面）：🖼 图片与粘贴，与背面共用附件流程（SPEC §9.4）。 */
  function applyFrontImage() {
    const el = frontRef.current;
    if (!el) return;
    void insertPickedImage(el).then((ok) => {
      if (ok) {
        frontDirty.current = true;
        scheduleAutosave();
      }
    });
  }
  function handleFrontPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const el = frontRef.current;
    if (!el) return;
    if (pasteIntoCardEditor(el, e.nativeEvent)) {
      frontDirty.current = true;
      scheduleAutosave();
    }
  }
  function handleFrontInput() {
    frontUndo.push("typing");
    frontDirty.current = true;
    scheduleAutosave();
  }

  /** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：自定义撤销栈（批注动作是直接 DOM 手术，
   *  浏览器原生撤销靠不住）。返回 true 表示按键已消费。 */
  function handleUndoKeys(
    e: React.KeyboardEvent<HTMLDivElement>,
    stack: typeof undo,
  ): boolean {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const key = e.key.toLowerCase();
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey ? stack.redo() : stack.undo()) scheduleAutosave();
      return true;
    }
    if (key === "y") {
      e.preventDefault();
      if (stack.redo()) scheduleAutosave();
      return true;
    }
    return false;
  }

  function startEdit(card: CardDto) {
    // Save the previous card's pending WYSIWYG edits before switching.
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    void flushEditor();
    setEditing(card.id);
    editingRef.current = card.id;
    titleRef.current = card.title;
    setEditTitle(card.title);
    setEditContent(card.contentMd);
    setEditFront(card.frontMd ?? "");
    frontDirty.current = false;
    setLinks(null);
    setLinkQuery("");
    setLinkResults([]);
    setLinkMsg("");
    api
      .getCardLinks(card.id)
      .then(setLinks)
      .catch(() => {});
  }

  // (Re)write the editor DOM when the edited card changes — never on save, so
  // the caret survives autosaves (same contract as the review popup).
  useEffect(() => {
    const el = editorRef.current;
    if (!el || editing == null) return;
    el.innerHTML = renderCard(editContent);
    const front = frontRef.current;
    if (front) front.innerHTML = editFront.trim() ? renderCard(editFront) : "";
    savedSnapshot.current = editContent;
    frontDirty.current = false;
    // 换卡 = 撤销历史换基线：上一张卡的历史不能串到这张卡上。
    undo.reset();
    frontUndo.reset();
    setSaveState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Jump-to-edit (§11.2): expand the card's deck and open its editor once.
  useEffect(() => {
    if (openCardId == null) return;
    let cancelled = false;
    api
      .getCard(openCardId)
      .then(async (card) => {
        if (cancelled) return;
        if (!card) {
          setError("卡片不存在");
          onCardOpened?.();
          return;
        }
        setOpenDeck(card.deck);
        setCards(await api.listCards(card.deck));
        startEdit(card);
        onCardOpened?.();
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
    // onCardOpened is stable enough for this one-shot effect; including it
    // would re-fire on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCardId]);

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
      setLinkMsg(errText(e));
    }
  }

  async function removeLink(from: number, to: number) {
    if (editing == null) return;
    setLinkMsg("");
    try {
      await api.removeCardLink(from, to);
      setLinks(await api.getCardLinks(editing));
    } catch (e) {
      setLinkMsg(errText(e));
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
      setError(errText(e));
    }
  }

  async function doSaveEdit() {
    if (editing == null) return;
    setError("");
    try {
      if (editingRef.current === editing && editorRef.current) {
        // Workspace WYSIWYG: the editor already persists via flushEditor
        // (title included); the button forces it and refreshes the list.
        await flushEditor();
        flash("卡片已保存");
      } else {
        await api.updateCard(editing, editTitle, editContent);
        flash("卡片已保存");
      }
      if (workspaceDeck) {
        setCards(await api.listCards(workspaceDeck));
      } else {
        setEditing(null);
        refreshCurrent();
      }
    } catch (e) {
      setError(errText(e));
    }
  }

  /** SPEC §10.1: copy the edited card and open the AI window. */
  async function askAiAboutCard() {
    const md =
      editorRef.current && editingRef.current === editing
        ? htmlToMarkdown(editorRef.current.innerHTML)
        : editContent;
    await copyText(`${editTitle}\n\n${md}`);
    await api.showMainWithAi().catch(() => {});
  }

  /** SPEC §12.2: archived cards come back with their level intact. */
  async function doRestore(card: CardDto) {
    setError("");
    try {
      await api.restoreCard(card.id);
      flash(`「${card.title}」已恢复到复习队列`);
      refreshCurrent();
    } catch (e) {
      setError(errText(e));
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
            <button className="btn" onClick={() => void askAiAboutCard()}>
              🤖 问 AI
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

  if (workspaceDeck) {
    const selected = editing == null ? null : cards.find((card) => card.id === editing) ?? null;
    return (
      <section className="page deck-workspace-page">
        <div className="decks-heading">
          <div>
            <button className="workspace-back btn" onClick={closeWorkspace}>
              ← 返回卡包
            </button>
            <h1>{workspaceDeck}</h1>
            <p className="muted">左侧选择卡片，右侧实时编辑并预览</p>
          </div>
          <button className="btn primary" onClick={() => void reviewDeck(workspaceDeck)}>
            复习该包
          </button>
        </div>
        {msg && <p className="ok">{msg}</p>}
        {error && <p className="error">{error}</p>}
        <div className="deck-workspace" data-testid="deck-workspace">
          <aside className="deck-workspace-list" data-testid="deck-list-scroll">
            <div className="workspace-list-title">
              <strong>卡片</strong>
              <span className="muted small">{cards.length} 张</span>
            </div>
            {chaptersOf(cards).map(([chapter, list]) => (
              <div className="workspace-chapter" key={chapter}>
                <div className="workspace-chapter-title">{chapter}</div>
                {list.map((card) => (
                  <button
                    type="button"
                    className={`workspace-card-item ${selected?.id === card.id ? "active" : ""}`}
                    key={card.id}
                    onClick={() => startEdit(card)}
                  >
                    <span>{card.title}</span>
                    <small className="muted">{levelLabel(card.level, card.state)}</small>
                  </button>
                ))}
              </div>
            ))}
            {cards.length === 0 && <p className="muted small">该卡包暂无卡片</p>}
          </aside>
          <div className="deck-workspace-detail" data-testid="deck-detail-scroll">
            {selected ? (
              <>
                <div className="workspace-detail-head">
                  <span className="muted small">编辑卡片</span>
                  <span className="muted small">{selected.chapter}</span>
                </div>
                <input
                  className="workspace-title-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="卡片标题"
                />
                <div className="workspace-field">
                  <div className="workspace-field-head">
                    <span className="muted small">题面（正面）</span>
                    <button className="btn small" onClick={applyFrontImage} title="插入图片：图片会复制到附件目录">
                      🖼 图片
                    </button>
                  </div>
                  <div
                    ref={frontRef}
                    className="popup-edit-wysiwyg workspace-front"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    data-placeholder="留空时正面显示上面的标题；也可以写长题干、粘截图"
                    onInput={handleFrontInput}
                    onPaste={handleFrontPaste}
                    onKeyDown={(e) => {
                      handleUndoKeys(e, frontUndo);
                    }}
                  />
                </div>
                <div className="popup-edit-wrap">
                  <div
                    ref={editorRef}
                    className="popup-edit-wysiwyg workspace-wysiwyg"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    onInput={() => {
                      undo.push("typing");
                      scheduleAutosave();
                    }}
                    onPaste={handlePaste}
                    onContextMenu={(e) => {
                      // 与弹窗一致：右键出批注菜单，不再放常驻工具条。
                      e.preventDefault();
                      const sel = window.getSelection();
                      setEditMenu({
                        x: e.clientX,
                        y: e.clientY,
                        collapsed: !sel || sel.isCollapsed,
                        selected: (sel?.toString() ?? "").trim().slice(0, 300),
                      });
                    }}
                    onKeyDown={(e) => {
                      // 引用块里按回车要能出来（空行即退出，SPEC §9.2）.
                      if (editorRef.current && handleQuoteExit(editorRef.current, e.nativeEvent)) {
                        scheduleAutosave();
                        return;
                      }
                      if (handleUndoKeys(e, undo)) return;
                      if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        applyBold();
                      }
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void flushEditor();
                      }
                    }}
                  />
                  {chipVisible && (
                    <span className={`edit-save-chip ${saveState}`} aria-live="polite">
                      {saveState === "saving" ? "保存中…" : "已保存 ✓"}
                    </span>
                  )}
                </div>
                {editMenuPortal}
                <div className="workspace-actions">
                  <button className="btn primary" onClick={() => void doSaveEdit()}>
                    保存卡片
                  </button>
                  <button className="btn" onClick={() => void askAiAboutCard()}>
                    🤖 问 AI
                  </button>
                </div>
              </>
            ) : (
              <div className="workspace-empty muted">从左侧选择一张卡片开始编辑</div>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="decks-heading">
        <div>
          <h1>卡包</h1>
          <p className="muted">
            {overview.length} 个卡包 · {overview.reduce((sum, item) => sum + item.cardCount, 0)} 张卡 · 今日到期 {overview.reduce((sum, item) => sum + item.dueCount, 0)}
          </p>
        </div>
        <div className="decks-heading-actions">
          <button className="btn" onClick={() => void exportAll()} title="把全部卡包导出为 Markdown（与导入格式互逆，可再导入恢复）">
            导出 Markdown
          </button>
          <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent("flashmemo:add-card"))}>
            ＋ 添加卡片
          </button>
        </div>
      </div>
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="🔍 搜索卡片标题或内容…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filter-pills" aria-label="卡片状态筛选">
          {FILTERS.map((f) => (
            <button
              type="button"
              className={`filter-pill ${filter === f.key ? "active" : ""}`}
              key={f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
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
                <span className="deck-name" onClick={() => void openWorkspace(o.name)} role="button">
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
                  <button className="btn small" onClick={() => void openWorkspace(o.name)}>
                    打开工作区
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
