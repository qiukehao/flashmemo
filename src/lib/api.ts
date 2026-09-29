import { invoke } from "@tauri-apps/api/core";

export interface CardDto {
  id: number;
  deck: string;
  chapter: string;
  title: string;
  contentMd: string;
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
  attentionCount: number;
  archivedCount: number;
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
}

/** SPEC §7 三档口述评分. */
export type RatingName = "unknown" | "familiar" | "speakable";

export const api = {
  importMarkdown: (files: ImportFile[], preferFile: boolean) =>
    invoke<ImportReport>("import_markdown", { files, preferFile }),
  previewImport: (files: ImportFile[]) =>
    invoke<ImportPreview>("preview_import", { files }),
  addCard: (deck: string, chapter: string, title: string, contentMd: string) =>
    invoke<CardDto>("add_card", { deck, chapter, title, contentMd }),
  listOverview: () => invoke<DeckOverview[]>("list_overview"),
  listCards: (deck: string) => invoke<CardDto[]>("list_cards", { deck }),
  renameDeck: (oldName: string, newName: string) =>
    invoke<void>("rename_deck", { oldName, newName }),
  deleteDeck: (name: string) => invoke<void>("delete_deck", { name }),
  deleteCard: (cardId: number) => invoke<void>("delete_card", { cardId }),
  updateCard: (cardId: number, title: string, contentMd: string) =>
    invoke<CardDto>("update_card", { cardId, title, contentMd }),
  saveCardContent: (cardId: number, contentMd: string) =>
    invoke<CardDto>("save_card_content", { cardId, contentMd }),
  searchCards: (query: string | null, deck: string | null, filter: string) =>
    invoke<CardDto[]>("search_cards", { query, deck, filter }),
  startReview: (cardIds: number[]) => invoke<number>("start_review", { cardIds }),
  reviewQueue: () => invoke<CardDto[]>("review_queue"),
  dueQueue: (limit: number) => invoke<CardDto[]>("due_queue", { limit }),
  rateCard: (cardId: number, rating: RatingName) =>
    invoke<CardDto>("rate_card", { cardId, rating }),
  skipCard: (cardId: number) => invoke<CardDto>("skip_card", { cardId }),
  previewIntervals: (cardId: number) =>
    invoke<number[]>("preview_intervals", { cardId }),  markShown: (cardId: number) => invoke<void>("mark_card_shown", { cardId }),
  dueCount: () => invoke<number>("due_count"),
  getStats: () => invoke<Stats>("get_stats"),
  listAttentionCards: () => invoke<CardDto[]>("list_attention_cards"),
  clearAttention: (cardId: number) => invoke<CardDto>("clear_attention", { cardId }),
  resetCardProgress: (cardId: number) => invoke<CardDto>("reset_card_progress", { cardId }),
  restoreCard: (cardId: number) => invoke<CardDto>("restore_card", { cardId }),
  backupNow: () => invoke<string>("backup_now"),
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  setSettings: (map: Record<string, string>) =>
    invoke<void>("set_settings", { map }),
};
