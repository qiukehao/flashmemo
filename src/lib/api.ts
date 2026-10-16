import { invoke } from "@tauri-apps/api/core";

export interface CardDto {
  id: number;
  deck: string;
  chapter: string;
  title: string;
  contentMd: string;
  /** 题面 Markdown（需求7 / SPEC §5.2）：图片型 / 长题干卡的正面内容。
   *  缺省或空串时正面就是 `title`（旧卡行为不变）；`title` 始终是身份键。 */
  frontMd?: string;
  state: string;
  dueAt: string;
  needsAttention: boolean;
  level: number;
  lapses: number;
}

export interface Stats {
  todayReviewed: number;
  dueCount: number;
  totalCards: number;
  streakDays: number;
  levelDistribution: number[];
  last7Days: number[];
  reviewHeatmap: ReviewDay[];
  attentionCount: number;
  archivedCount: number;
}

/** Render a stable empty state while the local database is starting. */
export const EMPTY_STATS: Stats = {
  todayReviewed: 0,
  dueCount: 0,
  totalCards: 0,
  streakDays: 0,
  levelDistribution: [0, 0, 0, 0, 0, 0],
  last7Days: [0, 0, 0, 0, 0, 0, 0],
  reviewHeatmap: [],
  attentionCount: 0,
  archivedCount: 0,
};

export interface ReviewDay {
  date: string;
  count: number;
}

/** Linked-card context for the review popup (SPEC §11.2). */
export interface CardContext {
  requires: CardDto[];
  next: CardDto | null;
  nextEligible: boolean;
}

export interface ImportFile {
  name: string;
  content: string;
}

export interface ImportReport {
  added: number;
  updated: number;
  conflicts: number;
  keptMissing: number;
}

export interface ImportPreview {
  decks: number;
  chapters: number;
  cards: number;
  conflicts: number;
  deckNames: string[];
}

export interface DeckOverview {
  name: string;
  chapterCount: number;
  cardCount: number;
  dueCount: number;
  chainByOrder: boolean;
}

/** Manual link edges of one card (SPEC §11.1 card editor). */
export interface CardLinks {
  prev: CardDto[];
  next: CardDto[];
}

/** SPEC §7 三档口述评分. */
export type RatingName = "unknown" | "familiar" | "speakable";

/** 目标类型：今天要复习 N 张（投入）还是讲出来 N 张（产出，SPEC §7.9）。 */
export type GoalMode = "review" | "speak";

/** 当前节奏的成因（Rust `goal::CadenceReason`），前端据此选文案。 */
export type GoalReason =
  | "off"
  | "outsideWindow"
  | "onPace"
  | "cappedAtPlan"
  | "reached"
  | "budgetSpent"
  | "poolExhausted";

/** 今日目标面板（2026-10-06 加讲出模式）: positive framing — what is done. */
export interface GoalStatus {
  enabled: boolean;
  mode: GoalMode;
  target: number;
  /** 模式对应的已完成数（复习型=今日复习张数；讲出型=今日讲出的卡数）。 */
  done: number;
  reviewedToday: number;
  /** 今天讲出来过的卡数（按卡去重；同一天连答三次只算 1 张）。 */
  spokenToday: number;
  /** 附带成绩：今天达成掌握的卡数——不当目标。 */
  masteredToday: number;
  dueCount: number;
  perPopup: number;
  start: string;
  end: string;
  /** 视为达成：做到位，或（讲出型）今天能推进的卡都推进过了。 */
  met: boolean;
  /** 讲出型：冻结的历史讲出率。 */
  speakRate: number;
  /** 讲出型：冻结的复习份额（讲出 N 张大约要复习多少张）。 */
  budget: number | null;
  budgetLeft: number | null;
  /** 今天还能推进的卡数（0 = 卡池耗尽）。 */
  poolLeft: number;
  /** 时段内的当前间隔（分钟）；null = 该状态下没有目标节奏。 */
  intervalMin: number | null;
  /** 计划节奏：整段时间均匀铺开的间隔，时段开始前的预告。 */
  plannedIntervalMin: number | null;
  /** 由它选文案——别在前端重算时间，两边会漂。 */
  reason: GoalReason;
  /** reason == "outsideWindow" 时：现在是否还在时段开始之前。 */
  beforeWindow: boolean;
}

/** 关闭策略上下文 (2026-10-04; 2026-10-07 加前 N 张禁止关闭). */
export interface CloseContext {
  strict: boolean;
  dodgeStreak: number;
  /** 本次会话前 N 张不显示 ✕（0 = 不限制）。 */
  noCloseFirstN: number;
}

/** 屏幕监控实时采样（设置页「实时捕捉」面板，纯内存不落库）. */
export interface ActivityStatus {
  enabled: boolean;
  category: "entertainment" | "study" | "neutral";
  continuousSecs: number;
  process: string;
  title: string;
  matched: string | null;
  idle: boolean;
}

export const api = {
  importMarkdown: (files: ImportFile[], preferFile: boolean) =>
    invoke<ImportReport>("import_markdown", { files, preferFile }),
  previewImport: (files: ImportFile[]) =>
    invoke<ImportPreview>("preview_import", { files }),
  /** 需求7：第 5 个参数是**可选**的题面（正面）Markdown。不传就不发该字段 ——
   *  旧调用点的 payload 与加该参数之前逐字节一致；Rust 侧 `add_card` 的
   *  `front_md: Option<String>` 收到 None（题面为空，正面仍退回 `title`）。 */
  addCard: (deck: string, chapter: string, title: string, contentMd: string, frontMd?: string) =>
    invoke<CardDto>("add_card", {
      deck,
      chapter,
      title,
      contentMd,
      ...(frontMd === undefined ? {} : { frontMd }),
    }),
  listOverview: () => invoke<DeckOverview[]>("list_overview"),
  listCards: (deck: string) => invoke<CardDto[]>("list_cards", { deck }),
  renameDeck: (oldName: string, newName: string) =>
    invoke<void>("rename_deck", { oldName, newName }),
  deleteDeck: (name: string) => invoke<void>("delete_deck", { name }),
  deleteCard: (cardId: number) => invoke<void>("delete_card", { cardId }),
  /** 同上：`frontMd` 不传 = 不改题面（Rust 用 `COALESCE(?4, front_md)`，
   *  弹窗背面批注走的 `saveCardContent` 绝不会把题面抹掉）。 */
  updateCard: (cardId: number, title: string, contentMd: string, frontMd?: string) =>
    invoke<CardDto>("update_card", {
      cardId,
      title,
      contentMd,
      ...(frontMd === undefined ? {} : { frontMd }),
    }),
  saveCardContent: (cardId: number, contentMd: string) =>
    invoke<CardDto>("save_card_content", { cardId, contentMd }),
  searchCards: (query: string | null, deck: string | null, filter: string) =>
    invoke<CardDto[]>("search_cards", { query, deck, filter }),
  getCard: (cardId: number) => invoke<CardDto>("get_card", { cardId }),
  /** Popup 知识铺垫 → 主窗口编辑器 (SPEC §11.2); the popup yields meanwhile. */
  editCardInMain: (cardId: number) => invoke<void>("edit_card_in_main", { cardId }),
  startReview: (cardIds: number[]) => invoke<number>("start_review", { cardIds }),
  /** 学新卡: a popup session over the remaining daily new-card quota. */
  startNewReview: () => invoke<number>("start_new_review"),
  openReviewNow: () => invoke<void>("open_review_now"),
  reviewQueue: () => invoke<CardDto[]>("review_queue"),
  dueQueue: (limit: number) => invoke<CardDto[]>("due_queue", { limit }),
  rateCard: (cardId: number, rating: RatingName, elapsedMs?: number | null) =>
    invoke<CardDto>("rate_card", { cardId, rating, elapsedMs: elapsedMs ?? null }),
  skipCard: (cardId: number) => invoke<CardDto>("skip_card", { cardId }),
  previewIntervals: (cardId: number) =>
    invoke<number[]>("preview_intervals", { cardId }),  markShown: (cardId: number) => invoke<void>("mark_card_shown", { cardId }),
  dueCount: () => invoke<number>("due_count"),
  goalStatus: () => invoke<GoalStatus>("goal_status"),
  /** 屏幕监控的实时捕捉（设置页轮询用）. */
  activityStatus: () => invoke<ActivityStatus>("activity_status"),
  /** 关闭策略上下文 (无法关闭模式开关 + 当前连续逃避次数). */
  closeContext: () => invoke<CloseContext>("close_context"),
  /** 弹窗会结束时上报结局: completed | closed（缺失=unknown，不计逃避）. */
  reportPopupSession: (sessionId: number, reason: string, shown: number, rated: number) =>
    invoke<void>("report_popup_session", { sessionId, reason, shown, rated }),
  /** 弹窗内交互心跳（离手逃离判定用，SPEC §8.4）——前端节流后调用. */
  popupActivity: () => invoke<void>("popup_activity"),
  /** 组卷: 从多个卡包各抽 N 张组成一次复习会话. */
  composeExam: (parts: { deck: string; count: number }[], includeDue: boolean, strategy: "weak" | "random") =>
    invoke<number>("compose_exam", { parts, includeDue, strategy }),
  saveExamPreset: (name: string, configJson: string) =>
    invoke<number>("save_exam_preset", { name, configJson }),
  listExamPresets: () => invoke<[number, string, string][]>("list_exam_presets"),
  deleteExamPreset: (id: number) => invoke<boolean>("delete_exam_preset", { id }),
  getStats: () => invoke<Stats>("get_stats"),
  listAttentionCards: () => invoke<CardDto[]>("list_attention_cards"),
  clearAttention: (cardId: number) => invoke<CardDto>("clear_attention", { cardId }),
  resetCardProgress: (cardId: number) => invoke<CardDto>("reset_card_progress", { cardId }),
  restoreCard: (cardId: number) => invoke<CardDto>("restore_card", { cardId }),
  backupNow: () => invoke<string>("backup_now"),
  getCardContext: (cardId: number) => invoke<CardContext>("get_card_context", { cardId }),
  getCardLinks: (cardId: number) => invoke<CardLinks>("get_card_links", { cardId }),
  addCardLink: (fromId: number, toId: number) => invoke<void>("add_card_link", { fromId, toId }),
  removeCardLink: (fromId: number, toId: number) =>
    invoke<void>("remove_card_link", { fromId, toId }),
  setDeckChain: (deck: string, enabled: boolean) =>
    invoke<void>("set_deck_chain", { deck, enabled }),
  aiWindowShow: (origin: "main" | "popup") =>
    invoke<void>("ai_window_show", { origin }),
  /** 由 AI 窗口页面调用：把站点 webview 钉进窗口内的布局槽。同站点重复调用
   *  只校正位置、不重新导航 —— 隐藏再打开时对话还在。 */
  aiWindowAttach: (url: string, x: number, y: number, w: number, h: number) =>
    invoke<void>("ai_window_attach", { url, x, y, w, h }),
  aiWindowResize: (x: number, y: number, w: number, h: number) =>
    invoke<void>("ai_window_resize", { x, y, w, h }),
  /** 隐藏（不是销毁）：站点页面继续活着，对话因此得以保留。 */
  aiWindowHide: () => invoke<void>("ai_window_hide"),
  showMainWithAi: () => invoke<void>("show_main_with_ai"),
  /** 尝试把问题写进 AI 站点的聊天输入框（best-effort：失败时前端有剪贴板兜底）. */
  aiFillQuestion: (text: string) => invoke<void>("ai_fill_question", { text }),
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  setSettings: (map: Record<string, string>) =>
    invoke<void>("set_settings", { map }),
  /** 附件（SPEC §5.4）：图片存到 %APPDATA%\FlashMemo\attachments，卡面只留 attachment: 引用. */
  attachmentDir: () => invoke<string>("attachment_dir"),
  saveAttachment: (data: string, ext?: string | null) =>
    invoke<string>("save_attachment", { data, ext: ext ?? null }),
  saveAttachmentFile: (path: string) => invoke<string>("save_attachment_file", { path }),
  /** 原生文件选择给的是路径，正文由 Rust 读入（顺带拿到图片相对目录）. */
  readMarkdownFiles: (paths: string[]) =>
    invoke<ImportFile[]>("read_markdown_files", { paths }),
};
