import { describe, expect, it } from "vitest";
import { mapKeyToRating } from "../lib/format";

describe("mapKeyToRating", () => {
  it("maps SPEC §8.4 keyboard controls", () => {
    expect(mapKeyToRating(" ")).toBe("reveal");
    expect(mapKeyToRating("1")).toBe("again");
    expect(mapKeyToRating("2")).toBe("hard");
    expect(mapKeyToRating("3")).toBe("good");
    expect(mapKeyToRating("4")).toBe("easy");
    expect(mapKeyToRating("Escape")).toBe("skip");
  });

  it("ignores unrelated keys", () => {
    expect(mapKeyToRating("x")).toBeNull();
    expect(mapKeyToRating("Enter")).toBeNull();
    expect(mapKeyToRating("5")).toBeNull();
  });
});
