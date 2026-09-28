import { describe, expect, it } from "vitest";
import { mapKeyToRating } from "../lib/format";

describe("mapKeyToRating", () => {
  it("maps SPEC §8.4 keyboard controls (三档)", () => {
    expect(mapKeyToRating(" ")).toBe("reveal");
    expect(mapKeyToRating("1")).toBe("unknown");
    expect(mapKeyToRating("2")).toBe("familiar");
    expect(mapKeyToRating("3")).toBe("speakable");
    expect(mapKeyToRating("Escape")).toBe("skip");
  });

  it("ignores unrelated keys", () => {
    expect(mapKeyToRating("x")).toBeNull();
    expect(mapKeyToRating("Enter")).toBeNull();
    expect(mapKeyToRating("4")).toBeNull();
  });
});
