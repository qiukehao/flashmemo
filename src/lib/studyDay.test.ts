import { describe, expect, it } from "vitest";
import { shiftStudyDay, studyDayKey } from "./studyDay";

/** 本地时间点 → ISO，便于用本地时刻构造用例（学习日是本地概念）。 */
function localAt(y: number, m: number, d: number, h: number, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

describe("studyDayKey（凌晨 4 点为界的学习日）", () => {
  it("凌晨 0–4 点算前一天", () => {
    expect(studyDayKey(localAt(2026, 10, 6, 0, 0))).toBe("2026-10-05");
    expect(studyDayKey(localAt(2026, 10, 6, 1, 30))).toBe("2026-10-05");
    expect(studyDayKey(localAt(2026, 10, 6, 3, 59))).toBe("2026-10-05");
  });

  it("4:00 整点翻页，其余时刻都算当天", () => {
    expect(studyDayKey(localAt(2026, 10, 6, 4, 0))).toBe("2026-10-06");
    expect(studyDayKey(localAt(2026, 10, 6, 12, 0))).toBe("2026-10-06");
    expect(studyDayKey(localAt(2026, 10, 6, 23, 59))).toBe("2026-10-06");
  });

  it("平移以正午为锚点，跨月跨年都不偏", () => {
    expect(shiftStudyDay("2026-10-06", -1)).toBe("2026-10-05");
    expect(shiftStudyDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftStudyDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftStudyDay("2026-10-06", -6)).toBe("2026-09-30");
    expect(shiftStudyDay("2026-10-06", 1)).toBe("2026-10-07");
  });

  it("平移后的键仍是合法学习日键（可往返）", () => {
    const today = studyDayKey();
    expect(shiftStudyDay(shiftStudyDay(today, -3), 3)).toBe(today);
  });
});
