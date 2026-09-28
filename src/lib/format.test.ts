import { describe, expect, it } from "vitest";
import { formatGap, formatInterval } from "./format";

describe("formatInterval", () => {
  it("formats units per SPEC examples", () => {
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

describe("formatGap", () => {
  it("formats card gaps per SPEC §7", () => {
    expect(formatGap(3)).toBe("隔 3 张");
    expect(formatGap(100)).toBe("隔 100 张");
    expect(formatGap(null)).toBe("");
  });
});
