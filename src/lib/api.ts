import { invoke } from "@tauri-apps/api/core";

export interface CardDto {
  id: number;
  deck: string;
  chapter: string;
  title: string;
  contentMd: string;
  state: string;
  dueAt: string;
  learningStep: number;
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
}

export interface DeckOverview {
  name: string;
  chapterCount: number;
  cardCount: number;
  dueCount: number;
}

export type RatingName = "again" | "hard" | "good" | "easy";

export const api = {
  importMarkdown: (files: ImportFile[], preferFile: boolean) =>
    invoke<ImportReport>("import_markdown", { files, preferFile }),
  previewImport: (files: ImportFile[]) =>
    invoke<ImportPreview>("preview_import", { files }),
  addCard: (deck: string, chapter: string, title: string, contentMd: string) =>
    invoke<CardDto>("add_card", { deck, chapter, title, contentMd }),
  listOverview: () => invoke<DeckOverview[]>("list_overview"),
  dueQueue: (limit: number) => invoke<CardDto[]>("due_queue", { limit }),
  rateCard: (cardId: number, rating: RatingName) =>
    invoke<CardDto>("rate_card", { cardId, rating }),
  skipCard: (cardId: number) => invoke<CardDto>("skip_card", { cardId }),
  previewIntervals: (cardId: number) =>
    invoke<(number | null)[]>("preview_intervals", { cardId }),
  dueCount: () => invoke<number>("due_count"),
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  setSettings: (map: Record<string, string>) =>
    invoke<void>("set_settings", { map }),
};
