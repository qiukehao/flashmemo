import type { RatingName } from "./api";

export type RatingAction = RatingName | "reveal" | "skip";

/**
 * Human interval label per SPEC §7.5: "10分钟" / "6天" (time floors, card lists).
 */
export function formatInterval(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}小时`;
  return `${Math.round(minutes / 1440)}天`;
}

/** Card-gap label for rating buttons: "隔 3 张" (SPEC §7 seq scheduling). */
export function formatGap(cards: number | null): string {
  if (cards == null) return "";
  return `隔 ${cards} 张`;
}

/** SPEC §8.4: space reveals, 1-3 rate (三档), Esc skips. */
export function mapKeyToRating(key: string): RatingAction | null {
  switch (key) {
    case " ":
    case "Spacebar":
      return "reveal";
    case "1":
      return "unknown";
    case "2":
      return "familiar";
    case "3":
      return "speakable";
    case "Escape":
      return "skip";
    default:
      return null;
  }
}
