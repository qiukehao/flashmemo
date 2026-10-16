import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  api,
  type CardContext,
  type CardDto,
  type CardLinks,
  type CloseContext,
  type RatingName,
} from "../lib/api";
import CardLinkPicker, {
  NextLinkActions,
  hasManualLinks,
  partitionRequires,
} from "./CardLinkPicker";
import EditContextMenu from "./EditContextMenu";
import ImageLightbox from "./ImageLightbox";
import { cardImagePreview, type ImagePreview } from "../lib/attachments";
import { copyText, isTextEntryTarget } from "../lib/dom";
import { isTauri } from "../lib/env";
import { formatGap, mapKeyToRating, type RatingAction } from "../lib/format";
import { insertPickedImage, pasteIntoCardEditor } from "../lib/imageInsert";
import { attachNotePopover } from "../lib/notePopover";
import { composeQuestion, fillAiQuestion } from "../lib/aiAsk";
import { frontLabel, frontMarkdown, isRichFront, renderCard } from "../lib/markdown";
import {
  createUndoStack,
  handleQuoteExit,
  htmlToMarkdown,
  insertNoteBlock,
  wrapSelection,
} from "../lib/wysiwyg";

const appWindow = isTauri() ? getCurrentWebviewWindow() : null;

async function closeWindow() {
  if (appWindow) {
    // hide() 而不是 close()：预建弹窗的 WebView 必须常驻（复用窗口），而且
    // Rust 侧的 CloseRequested 拦截在 strict 模式下连隐藏都不做——2026-10-07
    // 用户反馈「点了结束本次没有退出」就卡在这里。会话已正常结束时前端自己
    // 藏窗口；Alt+F4 之类用户发起的关闭仍由 Rust 按 strict 策略拦。
    await appWindow.hide().catch(() => {});
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

/** 卡片排版（「Aa」面板可调，存设置 KV，弹窗内即时生效）. */
const TYPO_DEFAULTS = { font: 18, line: 1.85, gap: 18 };
const TYPO_LIMITS = { font: [13, 26], line: [1.4, 2.4], gap: [0, 40] } as const;
type Typo = typeof TYPO_DEFAULTS;

function clampNum(v: number, limits: readonly [number, number]): number {
  return Math.min(limits[1], Math.max(limits[0], v));
}

function parseTypoValue(raw: string | undefined, fallback: number, limits: readonly [number, number]): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) ? clampNum(n, limits) : fallback;
}

/** 0.1 步进的浮点会留尾差（1.85+0.1=1.95000…2），统一取两位小数. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 顶栏可弹出的面板（与 Aa / 🤖 同一排按钮）。 */
type HeaderPanel = "typo" | "links" | "context";

export default function ReviewPopup() {
  const [queue, setQueue] = useState<CardDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastSession = useRef<number | null>(null);
  const activeSession = useRef(false);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<number[]>([]);
  const [hintCount, setHintCount] = useState(HINT_MAX);
  const hintSaved = useRef(true);
  // Linked-card context (SPEC §11.2): prerequisites (知识铺垫) + follow-up card.
  const [context, setContext] = useState<CardContext | null>(null);
  const [pendingNext, setPendingNext] = useState<CardDto | null>(null);
  // 顺链加入的张数（2026-10-07 用户反馈「会话张数怎么变了」）：评分后点
  // 「继续下一张」会把后置卡插进当前队列，分母随之变大——这里显式标注出来，
  // 进度行不再出现"凭空多卡"的困惑。
  const [chainAdded, setChainAdded] = useState(0);
  // 手动前置/后置边（SPEC §11.1）——弹窗里就地增删/改绑的就是这一份；
  // 同章节自动串联的邻居不在这里（没有边可删）。
  const [links, setLinks] = useState<CardLinks | null>(null);
  // 卡片排版（字号/行距/段距）：「Aa」面板调节，存设置 KV，跨会话记住。
  const [typo, setTypo] = useState<Typo>(TYPO_DEFAULTS);
  // 顶栏弹出面板（排版 / 关联卡片 / 知识铺垫）：同一时刻只开一个，都锚在触发按钮下方。
  // 关联卡片与知识铺垫原本是正文顶部两块常驻内容，占位大、信息少，2026-10-07 收进顶栏。
  const [panel, setPanel] = useState<HeaderPanel | null>(null);
  const [panelPos, setPanelPos] = useState({ left: 0, top: 0 });
  const panelBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setTypo({
          font: parseTypoValue(s.card_font_size, TYPO_DEFAULTS.font, TYPO_LIMITS.font),
          line: parseTypoValue(s.card_line_height, TYPO_DEFAULTS.line, TYPO_LIMITS.line),
          gap: parseTypoValue(s.card_para_gap, TYPO_DEFAULTS.gap, TYPO_LIMITS.gap),
        });
      })
      .catch(() => {});
  }, []);

  /** 面板调节：即时生效 + 立刻落盘（设置是 KV，写全三个键）. */
  function updateTypo(patch: Partial<Typo>) {
    setTypo((prev) => {
      const next = { ...prev, ...patch };
      void api
        .setSettings({
          card_font_size: String(next.font),
          card_line_height: String(next.line),
          card_para_gap: String(next.gap),
        })
        .catch(() => {});
      return next;
    });
  }

  // 顶栏面板：点外面 / Esc 关闭（触发按钮本身除外，否则会出现关了又开的抖动）.
  useEffect(() => {
    if (!panel) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !panelBtnRef.current?.contains(t)) {
        setPanel(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panel]);

  function togglePanel(which: HeaderPanel, ev: React.MouseEvent<HTMLButtonElement>) {
    if (panel === which) {
      setPanel(null);
      return;
    }
    const root = document.querySelector(".popup-root")?.getBoundingClientRect();
    const btn = ev.currentTarget.getBoundingClientRect();
    let left: number;
    if (which === "typo") {
      // 排版面板是小下拉：贴着 Aa 按钮，横向钳在卡片列内（AI 侧栏是原生 WebView，
      // 会盖住 DOM，不能伸过去）。
      const width = 236;
      left = Math.max(
        (root?.left ?? 8) + 8,
        Math.min(btn.right - width, (root?.right ?? window.innerWidth - 8) - width - 8),
      );
    } else {
      // 知识铺垫 / 关联卡片是宽版浮层（里面是整张卡的内容），在卡片列里**居中**。
      // 宽度与 `.popup-panel` 的 `min(600px, 100vw - 32px)` 保持一致。
      const width = Math.min(600, window.innerWidth - 32);
      const center = root
        ? root.left + (root.width - width) / 2
        : (window.innerWidth - width) / 2;
      left = Math.max(8, Math.min(center, window.innerWidth - width - 8));
    }
    panelBtnRef.current = ev.currentTarget;
    setPanelPos({ left: Math.round(left), top: btn.bottom + 8 });
    setPanel(which);
  }
  // The revealed card is ALWAYS editable in place (WYSIWYG, SPEC §9.2) — no
  // edit-mode toggle. The DOM is uncontrolled: innerHTML is written once per
  // card so autosaves can never reset the caret.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // 右键批注菜单（替代常驻工具条）：记录打开位置、选区是否为空与选区文本
  // （「问 AI」要拿它组问题；截断到 300 字防止把 AI 输入框塞爆）。
  const [editMenu, setEditMenu] = useState<{
    x: number;
    y: number;
    collapsed: boolean;
    selected: string;
  } | null>(null);
  const editMenuRef = useRef(false);
  useEffect(() => {
    editMenuRef.current = editMenu !== null;
  }, [editMenu]);
  // 卡面图片放大预览（SPEC §5.4）：只读渲染单击即开；编辑态单击留给光标/选区/
  // 右键批注，改用双击（见 attachments.cardImagePreview）。
  const [lightbox, setLightbox] = useState<ImagePreview | null>(null);
  const lightboxRef = useRef(false);
  useEffect(() => {
    lightboxRef.current = lightbox !== null;
  }, [lightbox]);
  // 保存状态角标只在 saving/短暂 saved 时可见，平时完全隐藏。
  const [chipVisible, setChipVisible] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedSnapshot = useRef("");
  const autosaveTimer = useRef<number | null>(null);
  // 撤销/重做（2026-10-07）：批注动作是直接 DOM 手术，浏览器原生撤销栈会被
  // 绕开，所以这里自管快照（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。
  const undo = useMemo(() => createUndoStack(() => editorRef.current), []);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  // 长题面（LeetCode 题面 + 截图）超过折叠高度时可展开（SPEC §5.2 rule 13）：
  // `frontOverflow` 是量出来的——短题面不该出现一个没用的按钮。
  const frontBoxRef = useRef<HTMLDivElement | null>(null);
  const [frontExpanded, setFrontExpanded] = useState(false);
  const [frontOverflow, setFrontOverflow] = useState(false);
  /** When the current card's answer was revealed — the 答题用时 start stamp. */
  const revealedAt = useRef(0);
  // ---- 关闭策略 (2026-10-04; 2026-10-07 加前 N 张禁止关闭) ----
  /** strict = 无法关闭模式; dodgeStreak ≥2 → 关闭需确认条;
   *  noCloseFirstN = 本次会话前 N 张不显示 ✕（设置项）。 */
  const [closeCtx, setCloseCtx] = useState<CloseContext>({
    strict: false,
    dodgeStreak: 0,
    noCloseFirstN: 0,
  });
  const [confirmClose, setConfirmClose] = useState(false);
  // Session outcome counters for report_popup_session: how many cards the user
  // actually saw / rated this session (only auto popups count as dodges).
  const shownCount = useRef(0);
  const ratedCount = useRef(0);
  const sessionEnded = useRef(true);

  /** Report the session outcome once, then close the window. A missing report
   *  reads as "unknown" on the backend and never counts as a dodge. */
  const endSession = useCallback(async (reason: "completed" | "closed") => {
    if (sessionEnded.current) {
      await closeWindow();
      return;
    }
    sessionEnded.current = true;
    const sessionId = lastSession.current;
    if (sessionId != null) {
      await api
        .reportPopupSession(sessionId, reason, shownCount.current, ratedCount.current)
        .catch(() => {});
    }
    await closeWindow();
  }, []);

  const card = queue[idx];
  const loading = !loaded;

  // 换卡即关闭预览：上一张的图片不该跟着下一张留在屏幕上。
  useEffect(() => {
    setLightbox(null);
  }, [card?.id]);

  /** 离手逃离 (SPEC §8.4): 把"弹窗里有人动过"节流上报给引擎（≥10s 一次）。
   *  引擎据此判断是"人在读卡"还是"拖到副屏放着不管"——没这个心跳，弹窗开着
   *  就等于告诉引擎"用户正在复习"，把当天的弹窗全挡掉了。 */
  const lastTouch = useRef(0);
  const touch = useCallback(() => {
    const now = Date.now();
    if (now - lastTouch.current < 10_000) return;
    lastTouch.current = now;
    void api.popupActivity().catch(() => {});
  }, []);

  useEffect(() => {
    // 任何指针按下 / 在卡面上移动 / 按键都算"人还在"——覆盖点击按钮、鼠标划选、
    // 空格揭示、1/2/3 评分、键盘编辑批注等全部交互路径。
    const onActivity = () => touch();
    document.addEventListener("pointerdown", onActivity, true);
    document.addEventListener("pointermove", onActivity, true);
    window.addEventListener("keydown", onActivity, true);
    touch();
    return () => {
      document.removeEventListener("pointerdown", onActivity, true);
      document.removeEventListener("pointermove", onActivity, true);
      window.removeEventListener("keydown", onActivity, true);
    };
  }, [touch]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const loadQueue = async () => {
      try {
        setLoaded(false);
        setLoadError(null);
        setQueue([]);
        setIdx(0);
        const timeout = new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error("review queue timeout")), 5000),
        );
        const settings = await Promise.race([api.getSettings(), timeout]);
        // A pending manual selection wins; otherwise the due queue batch.
        const q = await Promise.race([api.reviewQueue(), timeout]);
        // 关闭策略 (2026-10-04): strict hides every exit; dodgeStreak ≥2 turns
        // closing into a two-tap decision. Failure degrades to normal policy.
        const ctx = await api
          .closeContext()
          .catch(() => ({ strict: false, dodgeStreak: 0, noCloseFirstN: 0 }));
        setCloseCtx(ctx);

        setQueue(q);
        setIdx(0);
        setRevealed(false);
        setPendingNext(null);
        setChainAdded(0);
        setConfirmClose(false);
        // Mock 会话拿一个合成 id：浏览器调试模式没有 Rust 发的 session 事件，
        // 没有它 endSession 会跳过结局上报，mock 的逃避链模拟就永远收不到数。
        if (!isTauri() && lastSession.current === null) lastSession.current = -1;
        shownCount.current = 0;
        ratedCount.current = 0;
        sessionEnded.current = q.length === 0;
        // aiOpen is deliberately NOT reset here: a new session reuses the same
        // window, and closing the sidebar state while the native AI webview
        // stays alive (or vice versa) leaves the layout out of sync.
        setLoaded(true);
        setHintCount(Number.parseInt(settings.hint_shown_count ?? "0", 10) || 0);
        hintSaved.current = false;
        if (q.length === 0) await closeWindow();
      } catch {
        setLoaded(true);
        setLoadError("复习队列加载失败，请关闭窗口后重新点击“开始复习”");
      }
    };

    const beginSession = () => {
      if (activeSession.current) return;
      activeSession.current = true;
      void loadQueue();
    };

    if (!isTauri()) {
      beginSession();
      // Browser mock navigation replaces the whole document. Do not cancel
      // this initial request during React's development effect replay; doing
      // so can leave the popup permanently on its loading placeholder.
      return () => {};
    }

    // The hidden popup placeholder must not consume the review queue during
    // app startup. Rust emits this only after the window is shown for a real
    // review session.
    void listen("review-popup-open", (event) => {
      const sessionId = Number(event.payload);
      if (lastSession.current === sessionId) return;
      // The visibility fallback may have started the first session before a
      // delayed native event arrived. Adopt that event id without loading the
      // same queue for a second time.
      if (lastSession.current === null && activeSession.current) {
        lastSession.current = sessionId;
        return;
      }
      lastSession.current = sessionId;
      activeSession.current = false;
      beginSession();
    }).then((stop) => {
      unlisten = stop;
    });

    // Fallback for a WebView that finished loading after all native events
    // were emitted. Keep this only until the first session is identified;
    // later openings are driven by their fresh session id.
    const visibilityFallback = window.setInterval(() => {
      if (lastSession.current !== null || !appWindow) return;
      void appWindow.isVisible().then((visible) => {
        if (visible) beginSession();
      });
    }, 250);
    return () => {
      // Keep the listener and visibility poll alive for the reusable native
      // popup. React may replay effects during WebView startup; tearing down
      // the first listener leaves the window permanently on the loader.
      void unlisten;
      void visibilityFallback;
    };
  }, []);

  // Fetch card-gap previews per card (SPEC §7.7) and record the display that
  // advances the global seq counter (design §1).
  // 依赖是**卡号**而不是卡对象：保存后会 setQueue(新对象)，若跟着对象走，这次
  // effect 会在自动保存之后重跑，把刚拿到的「知识铺垫 / 继续下一张」清空——
  // 用户打完字（800ms 防抖保存）就发现续复习选项没了。卡号不变就不该重置。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!card) return;
    shownCount.current += 1;
    api
      .previewIntervals(card.id)
      .then(setPreviews)
      .catch(() => setPreviews([]));
    api.markShown(card.id).catch(() => {});
    // Linked context: prerequisites + the follow-up card (SPEC §11.2).
    setPendingNext(null);
    api
      .getCardContext(card.id)
      .then(setContext)
      .catch(() => setContext(null));
    // 手动前置/后置边（需求2）：与上面的合并上下文分开拉 —— 只有手动边能删，
    // 同章节自动邻居没有边可删（见 CardLinkPicker.partitionRequires）。
    setLinks(null);
    api
      .getCardLinks(card.id)
      .then(setLinks)
      .catch(() => setLinks(null));
    if (hintSaved.current) return;
    hintSaved.current = true;
    if (card.state === "new" && hintCount < HINT_MAX) {
      setHintCount((c) => c + 1);
      api
        .setSettings({ hint_shown_count: String(hintCount + 1) })
        .catch(() => {});
    }
  }, [card?.id, hintCount]);

  // (Re)write the editor DOM when the card changes OR when the editor first
  // mounts (reveal toggles it into existence) — never on save, so the caret
  // survives autosaves.
  useEffect(() => {
    if (!revealed) return;
    const el = editorRef.current;
    if (!el || !card) return;
    el.innerHTML = renderCard(card.contentMd);
    savedSnapshot.current = card.contentMd;
    // 换卡/重新揭示 = 撤销历史换基线；备注悬浮弹窗重新挂在编辑器上。
    undo.reset();
    const detachPopover = attachNotePopover(el);
    setSaveState("idle");
    return detachPopover;
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
    // 撤销快照在改动落地时立刻压栈（action 步），打字的合并由 onInput 侧做。
    undo.push();
    setSaveState("idle");
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void flushEditor(), AUTOSAVE_MS);
  }, [flushEditor, undo]);

  // 保存角标：saving 时常显，saved 显示 1.6s 后自动消失，平时不留任何常驻 UI。
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
        onAskAi={() => void askAi(editMenu.selected)}
        onClose={() => setEditMenu(null)}
      />
    ) : null;

  /** 卡面图片手势（SPEC §5.4）：单击 / 双击都进来，由 cardImagePreview 决定
   *  这次手势在当前语境（编辑态 or 只读渲染）里是否该开预览。 */
  const openImagePreview = useCallback((e: React.MouseEvent) => {
    const preview = cardImagePreview(e.type, e.target);
    if (preview) setLightbox(preview);
  }, []);

  /** Toolbar actions: apply the annotation trio to the live selection. */
  function applyBold() {
    const editor = editorRef.current;
    if (editor) wrapSelection(editor, "strong");
    scheduleAutosave();
  }
  function applyNote() {
    const editor = editorRef.current;
    if (!editor) return;
    // 备注 = 非破坏性批注（2026-10-07 二次反馈：选区被卷进备注读起来就是
    // "答案被改了"）：无论有没有选区，原文一字不动，只在光标所在块后面插
    // 一条空备注，光标落进去直接打字；悬浮摘要条可看全文（notePopover）。
    // 焦点不在卡面里时（刚点过按钮，选区没了）insertNoteBlock 自带兜底：
    // 挂到卡面末尾，绝不静默无操作。
    if (!insertNoteBlock(editor)) return;
    scheduleAutosave();
  }
  /** 🖼 图片: pick a file, copy it into the attachment store, insert at the caret. */
  function applyImage() {
    const editor = editorRef.current;
    if (!editor) return;
    void insertPickedImage(editor).then((ok) => {
      if (ok) scheduleAutosave();
    });
  }
  /** Ctrl+V: screenshots → attachment refs; rich content → normalized card
   *  markup (2026-10-07). Sync call — preventDefault must run during dispatch. */
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    if (pasteIntoCardEditor(editor, e.nativeEvent)) scheduleAutosave();
  }

  const advance = useCallback(
    (reason: "completed" | "closed" = "completed") => {
      setRevealed(false);
      if (idx + 1 < queue.length) {
        setIdx(idx + 1);
      } else {
        void endSession(reason);
      }
    },
    [idx, queue.length, endSession],
  );

  /** 关联被改动后（弹窗内取消/改绑）重新拉手动边与上下文，并让「继续下一张」
   *  立刻反映（SPEC §11.2）：改绑成了别的后置就换成新卡；后置没了就不再排队 ——
   *  这张卡已经评过分，直接推进会话，不把用户留在"已评分的卡 + 评分按钮"的死角。 */
  const refreshAfterLinkChange = useCallback(async () => {
    if (!card) return;
    try {
      const [nextLinks, ctx] = await Promise.all([
        api.getCardLinks(card.id),
        api.getCardContext(card.id),
      ]);
      setLinks(nextLinks);
      setContext(ctx);
      // 还没评分时不能提前抛「继续下一张」——只有已经开着这个选项才需要跟着变。
      if (pendingNext === null) return;
      if (ctx.next && ctx.nextEligible) {
        setPendingNext(ctx.next);
        return;
      }
      setPendingNext(null);
      advance("completed");
    } catch {
      // 刷新失败就保持原状：不做乐观更新，免得界面与库不一致。
    }
  }, [card, pendingNext, advance]);

  /** 共享选择器回传的最新手动边（选择器自己已经重新拉过库）。 */
  const applyLinks = useCallback(
    (next: CardLinks) => {
      setLinks(next);
      void refreshAfterLinkChange();
    },
    [refreshAfterLinkChange],
  );

  /** SPEC §8.4: Esc/✕ postpone unrated cards by the skip delay (no rating). */
  const skipCurrent = useCallback(async () => {
    await flushEditor();
    if (card) await api.skipCard(card.id).catch(() => {});
    advance("closed");
  }, [card, advance, flushEditor]);

  const closeAll = useCallback(async () => {
    await flushEditor();
    for (const c of queue.slice(idx)) await api.skipCard(c.id).catch(() => {});
    await endSession("closed");
  }, [queue, idx, flushEditor, endSession]);

  /** 连续关闭 ≥2 次：关闭前先多点一下（大师 §六：降门槛不施压）。 */
  const requestClose = useCallback(() => {
    if (closeCtx.dodgeStreak >= 2) {
      setConfirmClose(true);
    } else {
      void closeAll();
    }
  }, [closeCtx.dodgeStreak, closeAll]);

  /** 确认条上的「暂停 1 小时」：关闭本次 + 暂停提醒。 */
  const pauseAndClose = useCallback(async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await api.setSettings({ paused_until: until }).catch(() => {});
    await closeAll();
  }, [closeAll]);

  const rate = useCallback(
    async (name: RatingName) => {
      if (!card || !revealed || pendingNext) return;
      await flushEditor();
      // 答题用时 (2026-10-04 review): reveal → rate, stored for future FSRS
      // training data and to spot inflated "可以讲出来" ratings.
      const elapsedMs = revealedAt.current > 0 ? Date.now() - revealedAt.current : null;
      try {
        await api.rateCard(card.id, name, Number.isFinite(elapsedMs) ? elapsedMs : null);
        ratedCount.current += 1;
      } catch {
        // Rating failed (rare); the session outcome report stays honest.
      }
      // SPEC §11.2 顺链续复习: fetch the context fresh so the offer never
      // depends on stale render state.
      const ctx = await api.getCardContext(card.id).catch(() => null);
      if (ctx?.next && ctx.nextEligible) {
        setPendingNext(ctx.next);
        return;
      }
      advance("completed");
    },
    [card, revealed, advance, flushEditor, pendingNext],
  );

  /** Continue inside the same popup session with the linked follow-up card. */
  const continueNext = useCallback(() => {
    if (!pendingNext) return;
    setQueue((q) => {
      const rest = q.filter((c) => c.id !== pendingNext.id);
      const at = Math.min(idx + 1, rest.length);
      return [...rest.slice(0, at), pendingNext, ...rest.slice(at)];
    });
    setRevealed(false);
    setPendingNext(null);
    setChainAdded((n) => n + 1);
    setIdx(idx + 1);
  }, [pendingNext, idx]);

  /** 「结束本次」：立即终止会话（2026-10-07 用户反馈：原来只是推进到队列
   *  下一张，看起来像"点了没反应"）。剩余未评的卡不动，留在到期队列里。
   *  strict 模式下按钮本来就不渲染，正常走不到这里。 */
  const finishSession = useCallback(async () => {
    setPendingNext(null);
    await flushEditor();
    await endSession("closed");
  }, [flushEditor, endSession]);

  /** SPEC §10.1 一键带题: 标题 + 卡面内容打底，`selection` 非空时追加针对
   *  划选处的提问；复制兜底 + 打开 AI 助手窗口 + 尝试写进站点输入框。 */
  const askAi = useCallback(
    async (selection: string) => {
      if (!card) return;
      const text = composeQuestion(card.title, card.contentMd, selection);
      await copyText(text);
      void api.aiWindowShow("popup").catch(() => {});
      void fillAiQuestion(text);
    },
    [card],
  );

  /** 收起答案（2026-10-07 用户反馈）：揭示后回到题面，想再看再点显示。 */
  const hideAnswer = useCallback(async () => {
    setEditMenu(null);
    await flushEditor();
    setRevealed(false);
  }, [flushEditor]);

  const act = useCallback(
    (action: RatingAction) => {
      if (loading || !card || pendingNext) return;
      if (action === "reveal") {
        revealedAt.current = Date.now();
        setRevealed(true);
      } else if (action === "skip") {
        void skipCurrent();
      } else {
        void rate(action);
      }
    },
    [loading, card, skipCurrent, rate, pendingNext],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 批注菜单打开期间按键归菜单管（菜单自己在 document 层拦截 Esc），
      // 全局热键必须让路，否则 Esc 会同时触发「跳过这张卡」。
      if (editMenuRef.current) return;
      // 图片预览打开时键盘归预览层（Esc 由它自己关闭），不能顺手评分/跳过。
      if (lightboxRef.current) return;
      // 顶栏浮层（知识铺垫 / 关联卡片）盖着卡面、还带着遮罩：空格/1/2/3 必须让路，
      // 否则用户在看前置卡时会「隔空」把当前卡评了。Esc 由浮层自己关。
      if (panel === "links" || panel === "context") return;
      // The already-rated card offers a follow-up: Enter continues, Esc ends.
      if (pendingNext) {
        if (e.key === "Enter") {
          e.preventDefault();
          continueNext();
        } else if (e.key === "Escape" && !closeCtx.strict && idx >= closeCtx.noCloseFirstN) {
          // Esc = 结束本次；strict / 前 N 张禁止关闭时它不算数（2026-10-07）。
          e.preventDefault();
          void finishSession();
        }
        return;
      }
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
      // 无法关闭模式: Esc is not an exit — finish every card first.
      if (closeCtx.strict && e.key === "Escape") {
        e.preventDefault();
        return;
      }
      const action = mapKeyToRating(e.key);
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    act,
    flushEditor,
    pendingNext,
    continueNext,
    finishSession,
    closeCtx.strict,
    closeCtx.noCloseFirstN,
    idx,
    panel,
  ]);

  // 题面（需求7）：`front_md` 优先、否则 `title`；富题面用 Markdown 渲染。
  // 折叠测量是 Hook，必须落在下面 loading / loadError / !card 三个早退分支**之前**。
  const frontSrc = card ? frontMarkdown(card.title, card.frontMd) : "";
  const richFront = isRichFront(frontSrc);

  // 换卡就收起展开态；量一次折叠高度决定要不要给「展开」。
  // 直接量**滚动容器自己**是否溢出（`scrollHeight > clientHeight`）——它才是真正
  // 裁剪内容的那一层。图片是异步加载的：只量一次会在图还没到时就得出"不溢出"，
  // 按钮同样出不来，所以用 ResizeObserver 盯住尺寸变化。
  useEffect(() => {
    setFrontExpanded(false);
    const box = frontBoxRef.current;
    const wrap = box?.parentElement;
    if (!box || !wrap) {
      setFrontOverflow(false);
      return;
    }
    const measure = () => {
      // 只往"要展开"的方向翻：展开后按钮本身占高，翻回去会闪。
      setFrontOverflow((prev) => prev || wrap.scrollHeight > wrap.clientHeight + 4);
    };
    measure();
    // jsdom 没有 ResizeObserver：测试环境退化为只量一次，不抛错。
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(box);
    ro?.observe(wrap);
    return () => ro?.disconnect();
  }, [frontSrc]);

  if (loading) {
    return (
      <div className="popup-root popup-empty">
        <span>正在加载复习卡片…</span>
        {!isTauri() && (
          <button className="popup-close" onClick={() => void closeWindow()} title="关闭">
            ✕
          </button>
        )}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="popup-root popup-empty">
        <span>{loadError}</span>
        {!isTauri() && (
          <button className="popup-close" onClick={() => void closeWindow()} title="关闭">
            ✕
          </button>
        )}
      </div>
    );
  }

  if (!card) {
    return (
      <div className="popup-root popup-empty">
        <span>没有待复习的卡片</span>
        {!isTauri() && (
          <button className="popup-close" onClick={() => void closeWindow()} title="关闭">
            ✕
          </button>
        )}
      </div>
    );
  }

  const showHint = card.state === "new" && hintCount <= HINT_MAX;
  // 🔗 上的红点：只在**手动前置/后置边**存在时亮（2026-10-09 修正用户反馈）。
  // 只认 links（🔗 面板列的那一份），不认 context 里的同章节自动邻居——否则
  // 默认开启串联的卡包几乎每张卡都常亮，还和「前置/后置都是无」的面板自相矛盾。
  // 自动邻居由 📚 知识铺垫入口自身的有无表达。
  const hasLinkedCards = hasManualLinks(links);
  // 前 N 张禁止关闭（设置项，2026-10-07）：✕ 直接不渲染，Esc 结束也不放行。
  const closeBlocked = closeCtx.strict || idx < closeCtx.noCloseFirstN;

  // 哪些前置是「自动邻居」（同章节顺序串联）：它没有边可删，界面不能给假按钮。
  const autoRequires = new Set(
    context ? partitionRequires(context.requires, links).auto.map((c) => c.id) : [],
  );

  return (
    <div ref={layoutRef} className="popup-window-layout">
      <div
        className="popup-root"
        style={
          {
            "--card-font": `${typo.font}px`,
            "--card-line": String(typo.line),
            "--card-gap": `${typo.gap}px`,
          } as React.CSSProperties
        }
      >
      {/* 无边框窗口（decorations: false）：这条 header 就是标题栏（拖拽区 +
          ✕），原生 ✕ 已随 title bar 一起移除，关闭策略才能逐卡控制。 */}
      <header className="popup-header" data-tauri-drag-region>
        <span className="popup-crumb" data-tauri-drag-region>
          {card.deck} · {card.chapter}
          {card.needsAttention && " ⚠ 需专项理解"}
        </span>
        {closeCtx.strict && (
          <span className="popup-strict-badge" title="复习完所有卡片才能关闭">
            🔒 无法关闭模式
          </span>
        )}
        <div className="popup-header-actions">
          {context && context.requires.length > 0 && (
            <button
              className={`popup-icon-btn ${panel === "context" ? "active" : ""}`}
              data-testid="popup-context-btn"
              onClick={(e) => togglePanel("context", e)}
              title={`知识铺垫 · ${context.requires.length} 张前置卡`}
            >
              📚
            </button>
          )}
          <button
            className={`popup-icon-btn ${panel === "links" ? "active" : ""}`}
            data-testid="popup-links-btn"
            onClick={(e) => togglePanel("links", e)}
            title={`关联卡片 · 前置 ${links?.prev.length ?? 0} / 后置 ${links?.next.length ?? 0}`}
          >
            🔗
            {hasLinkedCards && <span className="popup-link-dot" data-testid="popup-link-dot" />}
          </button>
          <button
            className={`popup-icon-btn typo-btn ${panel === "typo" ? "active" : ""}`}
            data-testid="popup-typo-btn"
            onClick={(e) => togglePanel("typo", e)}
            title="排版：字号 / 行距 / 段距"
          >
            Aa
          </button>
          <button
            className="popup-icon-btn"
            onClick={() => void askAi("")}
            title="复制问题并打开 AI 助手窗口（Ctrl+V 提问）"
          >
            🤖
          </button>
          {!closeBlocked && (
            <button className="popup-close" onClick={() => requestClose()} title="关闭并跳过剩余">
              ✕
            </button>
          )}
          {closeCtx.strict && !isTauri() && (
            <button className="popup-close" onClick={() => void closeWindow()} title="关闭弹窗">
              ✕
            </button>
          )}
        </div>
      </header>

      {panel === "typo" && (
        <div className="typo-popover" ref={panelRef} role="dialog" aria-label="卡片排版" style={panelPos}>
          <div className="typo-row">
            <span className="typo-label">字号</span>
            <div className="typo-stepper">
              <button
                type="button"
                onClick={() => updateTypo({ font: clampNum(typo.font - 1, TYPO_LIMITS.font) })}
                disabled={typo.font <= TYPO_LIMITS.font[0]}
              >
                −
              </button>
              <span className="typo-value">{typo.font}px</span>
              <button
                type="button"
                onClick={() => updateTypo({ font: clampNum(typo.font + 1, TYPO_LIMITS.font) })}
                disabled={typo.font >= TYPO_LIMITS.font[1]}
              >
                ＋
              </button>
            </div>
          </div>
          <div className="typo-row">
            <span className="typo-label">行距</span>
            <div className="typo-stepper">
              <button
                type="button"
                onClick={() => updateTypo({ line: round2(clampNum(typo.line - 0.1, TYPO_LIMITS.line)) })}
                disabled={typo.line <= TYPO_LIMITS.line[0]}
              >
                −
              </button>
              <span className="typo-value">{typo.line}</span>
              <button
                type="button"
                onClick={() => updateTypo({ line: round2(clampNum(typo.line + 0.1, TYPO_LIMITS.line)) })}
                disabled={typo.line >= TYPO_LIMITS.line[1]}
              >
                ＋
              </button>
            </div>
          </div>
          <div className="typo-row">
            <span className="typo-label">段距</span>
            <div className="typo-stepper">
              <button
                type="button"
                onClick={() => updateTypo({ gap: clampNum(typo.gap - 2, TYPO_LIMITS.gap) })}
                disabled={typo.gap <= TYPO_LIMITS.gap[0]}
              >
                −
              </button>
              <span className="typo-value">{typo.gap}px</span>
              <button
                type="button"
                onClick={() => updateTypo({ gap: clampNum(typo.gap + 2, TYPO_LIMITS.gap) })}
                disabled={typo.gap >= TYPO_LIMITS.gap[1]}
              >
                ＋
              </button>
            </div>
          </div>
          <button
            type="button"
            className="typo-reset"
            onClick={() =>
              updateTypo({
                font: TYPO_DEFAULTS.font,
                line: TYPO_DEFAULTS.line,
                gap: TYPO_DEFAULTS.gap,
              })
            }
          >
            恢复默认
          </button>
        </div>
      )}

      {/* 面板是"读前置卡 / 改知识链"的模态浮层：给一层浅遮罩，点外面即关。
          知识铺垫里放的是**整张卡的内容**（列表 / 代码块 / 表格），窄弹层塞不下，
          所以面板是宽版居中，而不是挂在按钮边上的小下拉。 */}
      {panel && <div className="popup-panel-scrim" onClick={() => setPanel(null)} />}

      {panel === "context" && context && context.requires.length > 0 && (
        <div
          className="popup-panel popup-context"
          ref={panelRef}
          role="dialog"
          aria-label="知识铺垫"
          style={panelPos}
        >
          <div className="popup-panel-head">
            <span>📚 知识铺垫</span>
            <button
              type="button"
              className="popup-panel-close"
              onClick={() => setPanel(null)}
              title="关闭"
            >
              ✕
            </button>
          </div>
          {context.requires.map((r) => (
            <div className="popup-context-card" key={r.id}>
              <div className="popup-context-head">
                {/* SPEC §11.2: the title jumps to the main-window editor —
                    the popup yields and resumes when main closes. */}
                <button
                  type="button"
                  className="popup-context-title"
                  title="到主窗口编辑这张前置卡"
                  onClick={() => void api.editCardInMain(r.id).catch(() => {})}
                >
                  <span>{frontLabel(r.title)}</span>
                  <span className="popup-context-edit-hint">✏️</span>
                </button>
                {/* 手动边可以在「🔗 关联卡片」里取消/改绑；自动邻居没有边可删，
                    这里明说来源，免得用户以为点不动是坏的（需求2）。 */}
                {autoRequires.has(r.id) ? (
                  <span
                    className="popup-context-auto"
                    data-testid="popup-context-auto"
                    title="同章节按导入顺序自动串联（SPEC §11.1），不是可删除的关联"
                  >
                    自动
                  </span>
                ) : (
                  <span
                    className="popup-context-manual"
                    data-testid="popup-context-manual"
                    title="手动关联：在「🔗 关联卡片」里可取消或改绑"
                  >
                    手动
                  </span>
                )}
              </div>
              <div
                className="popup-back"
                onClick={openImagePreview}
                // markdown-it escapes raw HTML (html:false) before this injection.
                dangerouslySetInnerHTML={{ __html: renderCard(r.contentMd) }}
              />
            </div>
          ))}
        </div>
      )}

      {panel === "links" && (
        <div
          className="popup-panel popup-links"
          ref={panelRef}
          role="dialog"
          aria-label="关联卡片"
          data-testid="popup-links"
          style={panelPos}
        >
          <div className="popup-panel-head">
            <span>
              🔗 关联卡片 · 前置 {links?.prev.length ?? 0} / 后置 {links?.next.length ?? 0}
            </span>
            <button
              type="button"
              className="popup-panel-close"
              onClick={() => setPanel(null)}
              title="关闭"
            >
              ✕
            </button>
          </div>
          {/* 主窗口卡片编辑器同款的共享选择器 —— 复习时不用跳窗口也能修知识链。 */}
          <CardLinkPicker
            compact
            cardId={card.id}
            deck={card.deck}
            links={links}
            onLinks={applyLinks}
          />
        </div>
      )}

      <div
        className={`popup-body ${revealed ? "" : "popup-body-centered"} ${
          richFront ? "popup-body-rich-front" : ""
        }`}
      >
        {/* 知识铺垫与关联卡片已移到顶栏面板（📚 / 🔗，2026-10-07）：正文顶部不再
            常驻两块"占位大、信息少"的内容，题面能拿回整块空间。 */}
        {/* 题面（正面）：图片型 / 长题干卡（需求7 / SPEC §5.2）用同一套 Markdown
            渲染器 —— 图片走 F1 的放大预览（同一个灯箱，不重复实现）；单行纯文本
            题面保持原来的样式，旧卡观感不变。 */}
        {richFront ? (
          <div className={`popup-front-scroll ${frontExpanded ? "expanded" : ""}`}>
            <div
              ref={frontBoxRef}
              className="popup-front popup-front-rich"
              onClick={openImagePreview}
              // markdown-it escapes raw HTML (html:false) before this injection.
              dangerouslySetInnerHTML={{ __html: renderCard(frontSrc) }}
            />
            {frontOverflow && (
              <button
                type="button"
                className="btn small popup-front-expand"
                onClick={() => setFrontExpanded((v) => !v)}
              >
                {frontExpanded ? "收起题面" : "展开题面"}
              </button>
            )}
          </div>
        ) : (
          <div className="popup-front">{frontSrc}</div>
        )}
        {revealed ? (
          <>
            <div className="popup-edit-wrap">
              <div className="popup-back-tools">
                <button
                  type="button"
                  className="btn small popup-hide-answer"
                  onClick={() => void hideAnswer()}
                  title="回到题面；再看一次就再点「显示答案」"
                >
                  收起答案
                </button>
              </div>
              <div
                ref={editorRef}
                className="popup-edit-wysiwyg popup-back"
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                onInput={() => {
                  undo.push("typing");
                  scheduleAutosave();
                }}
                onPaste={handlePaste}
                onClick={openImagePreview}
                onDoubleClick={openImagePreview}
                onContextMenu={(e) => {
                  // 自带右键批注菜单（B/高亮/备注/图片…问 AI），替代常驻工具条。
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
                  // 撤销/重做：批注动作是 DOM 手术，原生栈靠不住（2026-10-07）。
                  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
                    e.preventDefault();
                    if (e.shiftKey ? undo.redo() : undo.undo()) scheduleAutosave();
                    return;
                  }
                  if ((e.ctrlKey || e.metaKey) && e.key === "y") {
                    e.preventDefault();
                    if (undo.redo()) scheduleAutosave();
                    return;
                  }
                  if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    applyBold();
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
          </>
        ) : (
          <button className="popup-reveal" onClick={() => act("reveal")}>
            显示答案（空格）
          </button>
        )}
      </div>

      <footer className="popup-footer">
        {confirmClose && !closeCtx.strict && (
          /* 连续关闭 ≥2 次：多点一下确认（2026-10-04，不做惩罚施压）. */
          <div className="popup-confirm-close">
            <span>要关掉这次复习吗？</span>
            <button className="btn primary small" onClick={() => void closeAll()}>
              稍后再来
            </button>
            <button className="btn small" onClick={() => void pauseAndClose()}>
              暂停 1 小时
            </button>
            <button className="btn small" onClick={() => setConfirmClose(false)}>
              继续复习
            </button>
          </div>
        )}
        {showHint && !pendingNext && (
          <div className="popup-hint">
            1=不了解 2=熟悉 3=可以讲出来；答案区内右键可加粗 / 高亮 / 备注
          </div>
        )}
        {pendingNext ? (
          /* SPEC §11.2 顺链续复习: same session, linked follow-up card. */
          <div className="popup-continue">
            <button className="btn primary" onClick={continueNext}>
              继续下一张：{frontLabel(pendingNext.title)}（Enter）
            </button>
            {!closeCtx.strict && (
              <button className="btn" onClick={() => void finishSession()}>
                结束本次（Esc）
              </button>
            )}
            {/* 后置卡就地取消/改绑（需求2）：手动边两步确认，自动串联只说明来源。 */}
            <NextLinkActions
              cardId={card.id}
              next={pendingNext}
              links={links}
              onRemoved={() => void refreshAfterLinkChange()}
            />
          </div>
        ) : (
          <div className="popup-buttons">
            {!closeCtx.strict && (
              <button className="popup-btn skip" onClick={() => void skipCurrent()}>
                跳过
              </button>
            )}
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
        )}
        <div
          className="popup-progress"
          title={
            chainAdded > 0
              ? "评分后点了「继续下一张」，后置卡会插入本次会话，所以总张数增加"
              : undefined
          }
        >
          第 {idx + 1}/{queue.length} 张 · 本次会话
          {chainAdded > 0 && <span className="popup-chain-note"> · 顺链 +{chainAdded}</span>}
        </div>
      </footer>
      </div>
      {/* 图片预览（SPEC §5.4）：portal 到 body —— 遮罩的 position:fixed 不能被
          .popup-root 里的 transform/filter/overflow 祖先拖成相对定位；同时它
          挂在卡面容器之外，绝不进入 contenteditable，回写保真不受影响。 */}
      {lightbox &&
        createPortal(
          <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />,
          document.body,
        )}
    </div>
  );
}
