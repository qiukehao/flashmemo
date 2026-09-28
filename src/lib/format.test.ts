import { describe, expect, it } from "vitest";
import { formatInterval } from "./format";

describe("formatInterval", () => {
  it("formats units per SPEC §7.5 examples", () => {
    expect(formatInterval(45)).toBe("45分钟");
    expect(formatInterval(90)).toBe("2小时");
    expect(formatInterval(2880)).toBe("2天");
  });

  it("handles boundaries and null", () => {
    expect(formatInterval(null)).toBe("");
    expect(formatInterval(1)).toBe("1分钟");
    expect(formatInterval(0.4)).toBe("0分钟");
    expect(formatInterval(60)).toBe("1小时");
    expect(formatInterval(1440)).toBe("1天");
    expect(formatInterval(10080)).toBe("7天");
  });
});
