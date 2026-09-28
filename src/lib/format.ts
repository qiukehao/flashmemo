import type { RatingName } from "./api";

export type RatingAction = RatingName | "reveal" | "skip";

/**
 * Human interval label per SPEC §7.5: "10分钟" / "6天".
 * Minutes below 60 stay minutes, below a day become hours, otherwise days.
 */
export function formatInterval(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}小时`;
  return `${Math.round(minutes / 1440)}天`;
}

/** SPEC §8.4: space reveals, 1-4 rate, Esc skips. */
export function mapKeyToRating(key: string): RatingAction | null {
  switch (key) {
    case " ":
    case "Spacebar":
      return "reveal";
    case "1":
      return "again";
    case "2":
      return "hard";
    case "3":
      return "good";
    case "4":
      return "easy";
    case "Escape":
      return "skip";
    default:
      return null;
  }
}
