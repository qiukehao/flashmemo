//! 今日目标的节奏控制器（SPEC §7.9）。
//!
//! 两种模式：
//! - [`GoalMode::Review`]：今天要**复习** N 张。投入式——评一张 +1，目标与动作
//!   一一对应，节奏公式直接按缺口摊分。
//! - [`GoalMode::Speak`]：今天要**讲出来** N 张。产出式——评了未必讲得出，产出
//!   不可控。所以**不在时段内追产出缺口**：设目标时用历史讲出率把它换算成一份
//!   固定的"复习份额" [`speak_budget`]，时段内只为花掉这份份额排程。最坏情况它
//!   退化成复习型目标，结构上不会出现"越够不着弹得越密"的轰炸
//!   （2026-10-06 外部评审：加压只能来自用户事先同意的投入，不能来自产出缺口）。
//!
//! 纯函数、无数据库、无系统时间：入参全部显式传入。

/// 间隔下限（分钟）。目标再急也不会比这更密。
pub const INTERVAL_FLOOR_MIN: u32 = 3;
/// 间隔上限（分钟）。
pub const INTERVAL_CEILING_MIN: u32 = 60;
/// 份额上限 = 4 × 目标：讲出率估得偏低时，份额也不能无限膨胀。
pub const BUDGET_CAP_MULTIPLIER: i64 = 4;
/// 讲出率先验平滑：样本很少时 p 落在 0.4 附近，而不是 0 或 1。
pub const SPEAK_RATE_PRIOR_SPEAKS: f64 = 2.0;
pub const SPEAK_RATE_PRIOR_DRAWS: f64 = 5.0;
pub const SPEAK_RATE_MIN: f64 = 0.25;
pub const SPEAK_RATE_MAX: f64 = 0.9;
/// 节奏最多比计划快一倍：间隔不低于 `计划间隔 × 0.5`。
pub const PLAN_SPEEDUP_FACTOR: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalMode {
    Review,
    Speak,
}

impl GoalMode {
    /// 设置值 → 模式；未知值一律当复习型（老用户的默认行为）。
    pub fn from_setting(s: &str) -> GoalMode {
        if s == "speak" {
            GoalMode::Speak
        } else {
            GoalMode::Review
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            GoalMode::Review => "review",
            GoalMode::Speak => "speak",
        }
    }
}

/// 当前节奏的成因。**直接对应首页那一行文案**——用户要能看懂"为什么现在弹得密或疏"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CadenceReason {
    /// 未启用目标（或目标为 0）。
    Off,
    /// 时段外。
    OutsideWindow,
    /// 正按缺口摊分，节奏正常。
    OnPace,
    /// 缺口算出来比计划还快，被"最多快一倍"的下限托住了。
    CappedAtPlan,
    /// 已达标。
    Reached,
    /// 复习份额花完了（讲出型：事先约定好的投入已经做完）。
    BudgetSpent,
    /// 今天能推进的卡都推进过了。
    PoolExhausted,
}

impl CadenceReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CadenceReason::Off => "off",
            CadenceReason::OutsideWindow => "outsideWindow",
            CadenceReason::OnPace => "onPace",
            CadenceReason::CappedAtPlan => "cappedAtPlan",
            CadenceReason::Reached => "reached",
            CadenceReason::BudgetSpent => "budgetSpent",
            CadenceReason::PoolExhausted => "poolExhausted",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GoalInput {
    pub mode: GoalMode,
    /// 目标张数。
    pub target: i64,
    /// 模式对应的已完成数：Review = 今日复习张数；Speak = 今日讲出张数。
    pub done: i64,
    /// 目标时段内**已复习**张数——花掉份额的计量。
    pub reviewed_in_window: i64,
    /// 讲出型：设目标时冻结的复习份额。
    pub budget: Option<i64>,
    /// 讲出型：冻结的历史讲出率 p。
    pub speak_rate: f64,
    /// 讲出型：今天还能推进的卡数（0 = 卡池耗尽）。
    pub pool_left: i64,
    pub per_popup: u32,
    /// 当前时刻、时段起止，都是「当日第几分钟」。
    pub now_min: i64,
    pub start_min: i64,
    pub end_min: i64,
    /// 整段时段均匀铺开的计划间隔（分钟）。
    pub planned_interval: u32,
}

/// 历史讲出率：`(有效讲出 + 2) / (展示 + 5)`，夹进 `[0.25, 0.9]`。
///
/// 先验平滑让样本很少时 p 落在 0.4 附近（而不是 0 或 1，避免份额估成无穷大）。
pub fn speak_rate(speaks: i64, draws: i64) -> f64 {
    let p = (speaks as f64 + SPEAK_RATE_PRIOR_SPEAKS) / (draws as f64 + SPEAK_RATE_PRIOR_DRAWS);
    p.clamp(SPEAK_RATE_MIN, SPEAK_RATE_MAX)
}

/// 讲出 `target` 张大约需要复习多少张 = 设目标时冻结的**复习份额**。
///
/// 夹进 `[target, 4 × target]`：份额是"事先征得同意的投入上限"，
/// 估得再离谱也不会失控。
pub fn speak_budget(target: i64, rate: f64) -> i64 {
    if target <= 0 {
        return 0;
    }
    let need = (target as f64 / rate).ceil() as i64;
    need.clamp(target, target.saturating_mul(BUDGET_CAP_MULTIPLIER))
}

/// 计划节奏：整段时段均匀铺开时的间隔——时段开始前的预告，也是节奏下限的基准。
pub fn planned_interval(start_min: i64, end_min: i64, target: i64, per_popup: u32) -> Option<u32> {
    if target <= 0 || end_min <= start_min {
        return None;
    }
    Some(cadence_interval(end_min - start_min, target, per_popup))
}

/// 节奏控制器。返回 `(间隔分钟, 成因)`；`None` = 这个状态下没有目标节奏，
/// 引擎回落到常规弹窗间隔（`popup_interval_min`）。
pub fn goal_cadence(i: &GoalInput) -> (Option<u32>, CadenceReason) {
    if i.target <= 0 {
        return (None, CadenceReason::Off);
    }
    if i.now_min < i.start_min || i.now_min > i.end_min {
        return (None, CadenceReason::OutsideWindow);
    }
    if i.done >= i.target {
        return (None, CadenceReason::Reached);
    }
    if i.mode == GoalMode::Speak && i.pool_left <= 0 {
        return (None, CadenceReason::PoolExhausted);
    }

    let remaining = match i.mode {
        // 投入式：缺口就是还要评多少张。
        GoalMode::Review => i.target - i.done,
        // 产出式：讲出越多需要越少（只会变松）；再被"事先同意的份额"封顶，
        // 所以产出为零时也不会越催越急。
        GoalMode::Speak => {
            let still_need = ((i.target - i.done) as f64 / i.speak_rate).ceil() as i64;
            match i.budget {
                Some(budget) => still_need.min(budget - i.reviewed_in_window),
                None => still_need,
            }
        }
    };
    if remaining <= 0 {
        return (None, CadenceReason::BudgetSpent);
    }

    let popups = ceil_div(remaining, i64::from(i.per_popup.max(1))).max(1);
    let raw = ((i.end_min - i.now_min) as f64 / popups as f64).round() as i64;
    // 最多比计划快一倍——两种模式都用这条下限（2026-10-06 评审：复习型目标
    // 在时段末尾也会压到 3 分钟地板，同样要托住）。
    let floor = ((f64::from(i.planned_interval) * PLAN_SPEEDUP_FACTOR).round() as i64)
        .max(i64::from(INTERVAL_FLOOR_MIN));
    let capped = raw < floor;
    let interval = raw.clamp(floor, i64::from(INTERVAL_CEILING_MIN)) as u32;
    let reason = if capped {
        CadenceReason::CappedAtPlan
    } else {
        CadenceReason::OnPace
    };
    (Some(interval), reason)
}

/// 基准间隔 = 可用分钟数 ÷ 还需轮数，夹进 `[3, 60]`。
fn cadence_interval(minutes: i64, remaining: i64, per_popup: u32) -> u32 {
    let popups = ceil_div(remaining, i64::from(per_popup.max(1))).max(1);
    let base = (minutes as f64 / popups as f64).round() as u32;
    base.clamp(INTERVAL_FLOOR_MIN, INTERVAL_CEILING_MIN)
}

fn ceil_div(a: i64, b: i64) -> i64 {
    if b <= 0 {
        0
    } else {
        (a + b - 1) / b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: GoalMode, target: i64, done: i64) -> GoalInput {
        GoalInput {
            mode,
            target,
            done,
            reviewed_in_window: 0,
            budget: None,
            speak_rate: 0.5,
            pool_left: 100,
            per_popup: 3,
            now_min: 1140, // 19:00
            start_min: 1140,
            end_min: 1320, // 22:00
            planned_interval: 5,
        }
    }

    #[test]
    fn review_mode_spreads_the_gap_over_the_window() {
        let mut i = input(GoalMode::Review, 100, 0);
        i.planned_interval = 5;
        // 180 分钟 ÷ ceil(100/3)=34 轮 ≈ 5 分钟
        assert_eq!(goal_cadence(&i).0, Some(5));
        // 已经做了 50 张 → 还需 17 轮 → 180/17 ≈ 11 分钟
        i.done = 50;
        assert_eq!(goal_cadence(&i).0, Some(11));
        // 达标
        i.done = 100;
        assert_eq!(goal_cadence(&i).1, CadenceReason::Reached);
    }

    #[test]
    fn speak_mode_falls_back_to_the_frozen_budget() {
        let mut i = input(GoalMode::Speak, 30, 0);
        i.speak_rate = 0.5;
        i.budget = Some(60);
        i.planned_interval = 5;
        // 讲出 0/30，p=0.5 → 还要复习 60 张；份额 60 → remaining 60
        assert_eq!(goal_cadence(&i).1, CadenceReason::OnPace);
        // 已经复习掉整个份额，却一张没讲出来 → 份额用完，回落常规节奏
        i.reviewed_in_window = 60;
        let (interval, reason) = goal_cadence(&i);
        assert_eq!(interval, None);
        assert_eq!(reason, CadenceReason::BudgetSpent);
    }

    /// 评审要求的三条性质之一：产出一直为 0 时，弹窗轮数也被份额封顶。
    #[test]
    fn zero_output_never_exceeds_the_budget() {
        let rate = 0.25; // 最悲观的讲出率
        let target = 40;
        let budget = speak_budget(target, rate);
        assert_eq!(budget, 160, "40 / 0.25 = 160");
        assert!(budget <= target * BUDGET_CAP_MULTIPLIER);

        // 产出为 0 地一路推进：份额每消费一张就少一张，用完即 BudgetSpent。
        let mut i = input(GoalMode::Speak, target, 0);
        i.speak_rate = rate;
        i.budget = Some(budget);
        for reviewed in 0..budget {
            i.reviewed_in_window = reviewed;
            assert_eq!(
                goal_cadence(&i).1,
                CadenceReason::OnPace,
                "份额还没花完时应当继续按份额排程"
            );
        }
        i.reviewed_in_window = budget;
        assert_eq!(goal_cadence(&i).1, CadenceReason::BudgetSpent);
    }

    /// 评审要求的三条性质之二：间隔永不低于计划间隔的一半。
    #[test]
    fn cadence_never_runs_faster_than_half_the_plan() {
        let mut i = input(GoalMode::Review, 200, 0);
        i.now_min = 1319; // 只剩 1 分钟
        i.planned_interval = 30; // 计划 30 分钟一轮
        let (interval, reason) = goal_cadence(&i);
        assert_eq!(interval, Some(15), "托底在 plan/2，而不是压到 3 分钟地板");
        assert_eq!(reason, CadenceReason::CappedAtPlan);
    }

    /// 评审要求的三条性质之三：讲出数增加时间隔不会变短。
    #[test]
    fn progress_never_makes_the_interval_shorter() {
        let mut i = input(GoalMode::Speak, 30, 0);
        i.speak_rate = 0.5;
        i.budget = Some(60);
        let mut prev = 0;
        for done in 0..=30 {
            i.done = done;
            let (interval, _) = goal_cadence(&i);
            let interval = interval.unwrap_or(INTERVAL_CEILING_MIN);
            assert!(
                interval >= prev,
                "讲出 {done} 张时间隔 {interval} 分钟，比之前的 {prev} 分钟更短"
            );
            prev = interval;
        }
    }

    #[test]
    fn pool_exhausted_is_treated_as_done_for_speak_mode() {
        let mut i = input(GoalMode::Speak, 30, 10);
        i.budget = Some(60);
        i.pool_left = 0;
        assert_eq!(goal_cadence(&i).1, CadenceReason::PoolExhausted);
        // 复习型不受卡池影响（到期卡可以重复出现）
        i.mode = GoalMode::Review;
        i.pool_left = 0;
        assert_eq!(goal_cadence(&i).1, CadenceReason::OnPace);
    }

    #[test]
    fn outside_window_and_off_report_their_own_reasons() {
        let mut i = input(GoalMode::Review, 100, 0);
        i.now_min = 1139;
        assert_eq!(goal_cadence(&i).1, CadenceReason::OutsideWindow);
        i.now_min = 1321;
        assert_eq!(goal_cadence(&i).1, CadenceReason::OutsideWindow);
        i.target = 0;
        i.now_min = 1140;
        assert_eq!(goal_cadence(&i).1, CadenceReason::Off);
    }

    #[test]
    fn speak_rate_is_smoothed_toward_the_prior() {
        // 0 样本 → 先验 2/5 = 0.4
        assert_eq!(speak_rate(0, 0), 0.4);
        // 极低命中率被下限托住，避免份额炸开
        assert_eq!(speak_rate(0, 500), SPEAK_RATE_MIN);
        // 极高命中率被上限压住，避免份额缩到 1 张
        assert_eq!(speak_rate(500, 500), SPEAK_RATE_MAX);
    }

    #[test]
    fn planned_interval_spreads_the_whole_window() {
        assert_eq!(planned_interval(1140, 1320, 100, 3), Some(5));
        assert_eq!(planned_interval(1140, 1320, 300, 3), Some(3));
        assert_eq!(planned_interval(1140, 1320, 3, 3), Some(60));
        assert_eq!(planned_interval(1140, 1320, 0, 3), None);
        assert_eq!(planned_interval(1320, 1140, 30, 3), None);
    }
}
