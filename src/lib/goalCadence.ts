import type { GoalStatus } from "./api";

/**
 * 首页目标条的「节奏」一行（SPEC §7.9）：把后端算好的 reason / intervalMin /
 * plannedIntervalMin 翻译成一句人话——"这个目标大概意味着多久弹一次"，
 * 以及"为什么现在弹得密或疏"（可解释是硬性要求，见评审 §0 约束）。
 *
 * 节奏公式只有 Rust 一份（`goal::goal_cadence`），这里只做文案，绝不重算时间。
 */
export function goalCadenceText(goal: GoalStatus): string | null {
  if (!goal.enabled || goal.target <= 0) return null;
  const round = `一轮 ${goal.perPopup} 张`;
  const pace = (label: string, minutes: number | null): string | null =>
    minutes == null ? null : `${label}：约每 ${minutes} 分钟弹一次 · ${round}`;

  switch (goal.reason) {
    case "onPace":
      return pace("当前节奏", goal.intervalMin);
    case "cappedAtPlan":
      // 缺口算得比计划还快，被"最多快一倍"的下限托住了——说清楚它不会再加密。
      return goal.intervalMin == null
        ? null
        : `${pace("当前节奏", goal.intervalMin)}（已是最快，不会再加密）`;
    case "outsideWindow":
      return goal.beforeWindow
        ? pace("计划节奏", goal.plannedIntervalMin)
        : "目标时段已过，明天继续";
    case "budgetSpent":
      // 正向表述：份额是事先同意的投入，做完了就是做完了。
      return `今天的复习份额完成了 · 讲出来 ${goal.spokenToday} 张`;
    case "poolExhausted":
      return "今天能推进的卡都推进过了 ✓";
    default:
      // off / reached：进度行已经说了"已达成"，不必重复。
      return null;
  }
}

/** 讲出型目标的「份额」说明行：让用户看懂 N 张是怎么换算成复习量的。 */
export function goalBudgetText(goal: GoalStatus): string | null {
  if (!goal.enabled || goal.mode !== "speak" || goal.budget == null) return null;
  const pct = Math.round(goal.speakRate * 100);
  const left = goal.budgetLeft == null ? "" : ` · 还剩 ${goal.budgetLeft} 张`;
  return `按近期讲出率 ${pct}% 估算：讲出 ${goal.target} 张 ≈ 复习 ${goal.budget} 张${left}`;
}
