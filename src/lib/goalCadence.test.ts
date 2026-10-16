import { describe, expect, it } from "vitest";
import type { GoalStatus } from "./api";
import { goalBudgetText, goalCadenceText } from "./goalCadence";
import { goalCadence, plannedGoalInterval, speakBudget, speakRate } from "./mockBackend";

function goal(over: Partial<GoalStatus>): GoalStatus {
  return {
    enabled: true,
    mode: "review",
    target: 100,
    done: 40,
    reviewedToday: 40,
    spokenToday: 0,
    masteredToday: 0,
    dueCount: 12,
    perPopup: 3,
    start: "19:00",
    end: "22:00",
    met: false,
    speakRate: 0.4,
    budget: null,
    budgetLeft: null,
    poolLeft: 20,
    intervalMin: 15,
    plannedIntervalMin: 5,
    reason: "onPace",
    beforeWindow: false,
    ...over,
  };
}

describe("goalCadenceText（首页目标条的节奏文案）", () => {
  it("时段内：用当前间隔说「多久弹一次」", () => {
    expect(goalCadenceText(goal({ reason: "onPace", intervalMin: 15 }))).toBe(
      "当前节奏：约每 15 分钟弹一次 · 一轮 3 张",
    );
  });

  it("被托底时说清楚「已经最快了」，而不是偷偷压到 3 分钟", () => {
    expect(goalCadenceText(goal({ reason: "cappedAtPlan", intervalMin: 9 }))).toBe(
      "当前节奏：约每 9 分钟弹一次 · 一轮 3 张（已是最快，不会再加密）",
    );
  });

  it("时段开始前用计划间隔预告；时段过了只说已过", () => {
    expect(goalCadenceText(goal({ reason: "outsideWindow", beforeWindow: true }))).toBe(
      "计划节奏：约每 5 分钟弹一次 · 一轮 3 张",
    );
    expect(goalCadenceText(goal({ reason: "outsideWindow", beforeWindow: false }))).toBe(
      "目标时段已过，明天继续",
    );
  });

  it("份额花完与卡池耗尽都是正向表述，不指责用户", () => {
    expect(
      goalCadenceText(goal({ mode: "speak", reason: "budgetSpent", spokenToday: 24 })),
    ).toBe("今天的复习份额完成了 · 讲出来 24 张");
    expect(goalCadenceText(goal({ mode: "speak", reason: "poolExhausted" }))).toBe(
      "今天能推进的卡都推进过了 ✓",
    );
  });

  it("已达标与未启用都不占文案（进度行已经说了）", () => {
    expect(goalCadenceText(goal({ reason: "reached", met: true }))).toBeNull();
    expect(goalCadenceText(goal({ reason: "off", enabled: false }))).toBeNull();
    expect(goalCadenceText(goal({ enabled: true, target: 0 }))).toBeNull();
  });

  it("后端没给出间隔时不出文案，不猜数字", () => {
    expect(goalCadenceText(goal({ reason: "onPace", intervalMin: null }))).toBeNull();
  });
});

describe("goalBudgetText（讲出型的份额说明）", () => {
  it("讲出型说明「N 张 ≈ 复习多少张」，让人看懂份额从哪来", () => {
    expect(
      goalBudgetText(
        goal({ mode: "speak", target: 30, budget: 60, budgetLeft: 45, speakRate: 0.5 }),
      ),
    ).toBe("按近期讲出率 50% 估算：讲出 30 张 ≈ 复习 60 张 · 还剩 45 张");
  });

  it("复习型没有份额概念", () => {
    expect(goalBudgetText(goal({ mode: "review", budget: 60 }))).toBeNull();
  });
});

// 浏览器调试模式那套公式必须与 Rust 一致，否则 mock 里看到的节奏和真机不一样。
// 下面每个期望值都直接抄自 goal.rs / engine.rs 的同名单测。
describe("mock 节奏公式与 Rust goal.rs 对齐", () => {
  it("计划节奏把整段时段铺满，并夹进 [3, 60]", () => {
    expect(plannedGoalInterval(1140, 1320, 100, 3)).toBe(5);
    expect(plannedGoalInterval(1140, 1320, 300, 3)).toBe(3);
    expect(plannedGoalInterval(1140, 1320, 3, 3)).toBe(60);
    expect(plannedGoalInterval(1140, 1320, 0, 3)).toBeNull();
    expect(plannedGoalInterval(1320, 1140, 30, 3)).toBeNull();
  });

  it("讲出率先验平滑 + 上下限", () => {
    expect(speakRate(0, 0)).toBeCloseTo(0.4, 6);
    expect(speakRate(0, 500)).toBe(0.25);
    expect(speakRate(500, 500)).toBe(0.9);
  });

  it("份额夹进 [N, 4N]", () => {
    expect(speakBudget(30, 0.5)).toBe(60);
    expect(speakBudget(40, 0.25)).toBe(160);
    expect(speakBudget(100, 1)).toBe(100); // 命中率上限 0.9，不会低于 N
  });

  it("复习型按缺口摊分，且被「最多快一倍」托住", () => {
    const base = {
      mode: "review" as const,
      target: 100,
      reviewedInWindow: 0,
      budget: null,
      speakRate: 0.5,
      poolLeft: 100,
      perPopup: 3,
      nowMin: 1140,
      startMin: 1140,
      endMin: 1320,
      plannedInterval: 5,
    };
    expect(goalCadence({ ...base, done: 0 })).toEqual({ interval: 5, reason: "onPace" });
    expect(goalCadence({ ...base, done: 50 })).toEqual({ interval: 11, reason: "onPace" });
    expect(goalCadence({ ...base, done: 100 }).reason).toBe("reached");
    // 只剩 1 分钟：下限托在 plan/2 = 15，而不是压到 3 分钟地板
    expect(
      goalCadence({ ...base, target: 200, done: 0, nowMin: 1319, plannedInterval: 30 }),
    ).toEqual({ interval: 15, reason: "cappedAtPlan" });
  });

  it("讲出型：产出为零也不会越弹越密，份额花完就回落常规节奏", () => {
    const base = {
      mode: "speak" as const,
      target: 30,
      done: 0,
      reviewedInWindow: 0,
      budget: 60,
      speakRate: 0.5,
      poolLeft: 100,
      perPopup: 3,
      nowMin: 1140,
      startMin: 1140,
      endMin: 1320,
      plannedInterval: 5,
    };
    let prev = 0;
    for (let reviewed = 0; reviewed <= 60; reviewed++) {
      const out = goalCadence({ ...base, reviewedInWindow: reviewed });
      if (out.interval != null) {
        expect(out.interval).toBeGreaterThanOrEqual(prev);
        prev = out.interval;
      } else {
        expect(out.reason).toBe("budgetSpent");
        expect(reviewed).toBe(60);
      }
    }
  });

  it("讲出型：卡池耗尽视为达成", () => {
    const out = goalCadence({
      mode: "speak",
      target: 30,
      done: 5,
      reviewedInWindow: 10,
      budget: 60,
      speakRate: 0.5,
      poolLeft: 0,
      perPopup: 3,
      nowMin: 1140,
      startMin: 1140,
      endMin: 1320,
      plannedInterval: 5,
    });
    expect(out).toEqual({ interval: null, reason: "poolExhausted" });
  });
});
