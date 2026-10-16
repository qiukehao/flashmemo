//! 15s tick engine per SPEC §8.2/§8.5: decides whether a popup (or a light
//! notification) is due, and opens the popup window on the monitor the cursor
//! is currently on. The decision logic is pure and unit-tested. Events
//! (settings change, manual review) wake the loop early via a channel; the
//! 15s timeout is only a fallback.

use crate::db::{self, Db};
use crate::services;
use chrono::{DateTime, Local, Timelike, Utc};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration as StdDuration, Instant};
use tauri::{Emitter, Listener, Manager};

const TICK_SECS: u64 = 15;
/// After a system sleep the first tick stays quiet — a large wall-clock gap
/// would otherwise burst popups for everything that "expired" meanwhile
/// (2026-10-04 review). 2 minutes of tick silence = we probably slept.
const WAKE_GUARD_SECS: u64 = 120;
// Keep enough room for the answer area, rating buttons, and footer on first render.
const POPUP_SIZE: (f64, f64) = (760.0, 680.0);
const TASKBAR_RESERVE: f64 = 48.0;
static POPUP_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct EngineSettings {
    pub interval_min: u32,
    pub study_start: String,
    pub study_end: String,
    pub paused_until: Option<DateTime<Utc>>,
    pub notify_mode: String,
    /// SPEC §7.8 每日弹窗上限; 0 = unlimited.
    pub daily_popup_limit: u32,
    /// 今日目标 (2026-10-04 rework, 大师 §五; 2026-10-06 加讲出模式):
    /// 复习型按缺口摊分；讲出型按设目标时冻结的复习份额排程（见 [`crate::goal`]）。
    pub goal_enabled: bool,
    pub goal_mode: crate::goal::GoalMode,
    pub goal_target: u32,
    pub goal_start: String,
    pub goal_end: String,
    /// 离手逃离 (2026-10-06): 弹窗开着但这么久没有任何交互、鼠标也不在弹窗上，
    /// 就把它拉回光标所在显示器并记一次逃避。0 = 关闭该保护。
    pub popup_idle_escape_min: u32,
}

impl Default for EngineSettings {
    fn default() -> Self {
        EngineSettings {
            // 2026-10-04 review: 20 min default cadence (was 10), 40 popups/day
            // (was 120). Both stay user-tunable in 设置.
            interval_min: 20,
            study_start: "09:00".into(),
            study_end: "22:30".into(),
            paused_until: None,
            notify_mode: "popup".into(),
            daily_popup_limit: 40,
            goal_enabled: false,
            goal_mode: crate::goal::GoalMode::Review,
            goal_target: 0,
            goal_start: "19:00".into(),
            goal_end: "22:00".into(),
            // 5 分钟：足够读完一张卡加批注，又不足以"拖到副屏放着不管"。
            popup_idle_escape_min: 5,
        }
    }
}

/// Last notification time, shared between the tick thread and the
/// `force-review` listener.
#[derive(Default)]
pub struct EngineState {
    pub last_notify: Option<DateTime<Utc>>,
    /// When the last popup was opened — the `popup_interval_min` throttle
    /// counts from here (manual triggers bypass it).
    pub last_popup_at: Option<DateTime<Utc>>,
    /// Cached settings; dropped on `SettingsChanged` wakes so the 15s tick
    /// never re-reads the KV table (2026-10-04 review).
    pub settings: Option<EngineSettings>,
    /// Wall clock of the previous tick — the wake guard compares against it.
    pub last_tick: Option<Instant>,
    /// 学习应用延后 (2026-10-05): when a popup came due while the user was in
    /// a study app, this marks when the deferral started (carried until the
    /// app switch or the 15-minute cap).
    pub deferred_since: Option<Instant>,
    /// 加速弹窗当日计数 (娱乐加速, 2026-10-04): capped at 30% of the daily
    /// popup limit so the acceleration can never run away.
    pub accel_popups_today: i64,
    /// Study day of `accel_popups_today` — the counter resets with the day.
    pub accel_day: Option<String>,
    /// 讲出型目标的**冻结值** `(学习日, 复习份额, 讲出率)`：只在学习日切换或用户
    /// 改目标时重算一次。时段内不更新——时段内更新等于追产出缺口，正是要避免的震荡。
    pub goal_freeze: Option<(String, i64, f64)>,
}

/// Events that wake the engine loop before the 15s timeout elapses.
#[derive(Debug, Clone, Copy)]
pub enum EngineEvent {
    /// Settings KV changed — drop the cached EngineSettings.
    SettingsChanged,
    /// A rating/skip landed — the queue shape may have changed.
    ReviewActivity,
}

/// Handle the command layer uses to poke the engine loop.
pub struct EngineWake(pub mpsc::Sender<EngineEvent>);

/// Lock-free engine→command channel for cross-thread hints (2026-10-05 死锁
/// 修复): the command layer runs on the MAIN thread, and the engine holds its
/// state lock across window operations (show/emit wait for the main thread) —
/// a mutex here deadlocked the whole process ("第二次弹窗卡崩": warm popup
/// webview fired review_queue instantly, colliding with an in-flight tick).
/// Atomics have no waiter, so the cycle cannot form.
#[derive(Default)]
pub struct EngineShared {
    /// 连续关闭惩罚: >0 = the next due-queue popup serves this many cards.
    pub session_size_override: std::sync::atomic::AtomicI64,
    /// 当前弹窗会话 id（0 = 屏上没有弹窗）。离手逃离要拿它给会话记一笔。
    pub popup_session_id: std::sync::atomic::AtomicI64,
    /// 弹窗内最近一次交互的 unix 秒——由前端 `popup_activity` 上报（节流）。
    pub popup_activity_at: std::sync::atomic::AtomicI64,
    /// 已经记过"离手逃离"的会话 id：一个会话只记一次逃避，重复拖走只重复拉回。
    pub popup_idle_marked: std::sync::atomic::AtomicI64,
}

pub fn notify(app: &tauri::AppHandle, event: EngineEvent) {
    if let Some(wake) = app.try_state::<EngineWake>() {
        let _ = wake.0.send(event);
    }
}

/// 前端上报"弹窗里有人动过"（离手逃离的计时基准）。锁无关，永远不会阻塞。
pub fn mark_popup_activity(app: &tauri::AppHandle) {
    if let Some(shared) = app.try_state::<EngineShared>() {
        shared
            .popup_activity_at
            .store(Utc::now().timestamp(), std::sync::atomic::Ordering::Relaxed);
    }
}

pub fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    Some((h.trim().parse().ok()?, m.trim().parse().ok()?))
}

/// SPEC §8.5: outside the study window nothing pops. Malformed settings fall
/// open (always in hours) so a typo can't silence the app silently.
pub fn in_study_hours(now: DateTime<Local>, s: &EngineSettings) -> bool {
    let Some((sh, sm)) = parse_hhmm(&s.study_start) else {
        return true;
    };
    let Some((eh, em)) = parse_hhmm(&s.study_end) else {
        return true;
    };
    let mins = now.hour() * 60 + now.minute();
    mins >= sh * 60 + sm && mins <= eh * 60 + em
}

/// Floor/ceiling of the cadence funnel (2026-10-04 rework, 大师 §五): no
/// schedule may pop faster than every 3 minutes or slower than every 60.
/// 定义在 [`crate::goal`]（目标控制器和引擎共用一套，别在这里再写一份）。
pub use crate::goal::{INTERVAL_CEILING_MIN, INTERVAL_FLOOR_MIN};
/// 学习应用里的最长延后：等不到切走也要弹（评审建议 15 分钟）。
pub const STUDY_DEFER_MAX: StdDuration = StdDuration::from_secs(15 * 60);

/// 应用权重 (2026-10-05, 大师 §五): 娱乐 ÷2、学习 ×2（中性或未达 dwell →
/// 权重 1），结果夹进 [3, 60]。`weight_active` 由调用方按"娱乐当日加速上限
/// 用尽/手动触发"等条件决定，本函数保持纯函数便于测试。
pub fn apply_activity_weight(
    base: u32,
    category: Option<crate::activity::Category>,
    weight_active: bool,
) -> u32 {
    use crate::activity::Category;
    let weighted = if weight_active {
        match category {
            Some(Category::Entertainment) => base / 2,
            Some(Category::Study) => base.saturating_mul(2),
            _ => base,
        }
    } else {
        base
    };
    weighted.clamp(INTERVAL_FLOOR_MIN, INTERVAL_CEILING_MIN)
}

/// 学习应用延后判定：true = 本次先不弹，等切换应用的间隙（或 15 分钟上限）。
/// 手动触发（force）直达，不受延后影响。
pub fn defer_study_popup(
    category: crate::activity::Category,
    dwell_met: bool,
    force: bool,
    deferred_for: Option<StdDuration>,
) -> bool {
    if force || !dwell_met || category != crate::activity::Category::Study {
        return false;
    }
    match deferred_for {
        None => true, // start the deferral
        Some(held) => held < STUDY_DEFER_MAX,
    }
}

/// 节奏控制器: assembles the goal window/counters into a [`crate::goal::GoalInput`]
/// and asks the pure controller. 目标当天作废, never becomes debt.
pub fn goal_interval(
    now: DateTime<Local>,
    s: &EngineSettings,
    counters: &GoalCounters,
    per_popup: u32,
) -> (Option<u32>, crate::goal::CadenceReason) {
    let Some((sh, sm)) = parse_hhmm(&s.goal_start) else {
        return (None, crate::goal::CadenceReason::Off);
    };
    let Some((eh, em)) = parse_hhmm(&s.goal_end) else {
        return (None, crate::goal::CadenceReason::Off);
    };
    let start_min = i64::from(sh * 60 + sm);
    let end_min = i64::from(eh * 60 + em);
    let target = if s.goal_enabled {
        i64::from(s.goal_target)
    } else {
        0
    };
    let done = match s.goal_mode {
        crate::goal::GoalMode::Review => counters.reviewed_today,
        crate::goal::GoalMode::Speak => counters.spoken_today,
    };
    let planned = crate::goal::planned_interval(start_min, end_min, target, per_popup)
        .unwrap_or(crate::goal::INTERVAL_CEILING_MIN);
    crate::goal::goal_cadence(&crate::goal::GoalInput {
        mode: s.goal_mode,
        target,
        done,
        reviewed_in_window: counters.reviewed_in_window,
        budget: counters.budget,
        speak_rate: counters.speak_rate,
        pool_left: counters.pool_left,
        per_popup,
        now_min: i64::from(now.hour() * 60 + now.minute()),
        start_min,
        end_min,
        planned_interval: planned,
    })
}

/// 目标控制器需要的当日计数（每 tick 从库里取一次）。
#[derive(Debug, Clone)]
pub struct GoalCounters {
    /// 今天复习了多少张（学习日口径，三个评分都算）。
    pub reviewed_today: i64,
    /// 今天**讲出来**的卡数（`speak_days` 今天新增一天的卡，按卡去重）。
    pub spoken_today: i64,
    /// 今天达成掌握（连续 `archive_threshold` 次讲出且跨够了学习日）的卡数。
    pub mastered_today: i64,
    /// 目标时段内已复习张数——讲出型"复习份额"的消费计量。
    pub reviewed_in_window: i64,
    /// 今天还能推进（还没讲出过）的卡数。
    pub pool_left: i64,
    /// 冻结的复习份额 / 历史讲出率（仅讲出模式用）。
    pub budget: Option<i64>,
    pub speak_rate: f64,
}

impl Default for GoalCounters {
    fn default() -> Self {
        GoalCounters {
            reviewed_today: 0,
            spoken_today: 0,
            mastered_today: 0,
            reviewed_in_window: 0,
            pool_left: 0,
            budget: None,
            // 先验值（0 样本时的讲出率），不是 0.0——避免份额被估成无穷大。
            speak_rate: crate::goal::speak_rate(0, 0),
        }
    }
}

/// Not paused = no future paused_until in settings. `now` is injected so the
/// gate stays testable without sleeping (2026-10-04 review: injectable clock).
fn not_paused(s: &EngineSettings, now: DateTime<Utc>) -> bool {
    s.paused_until.is_none_or(|t| now >= t)
}

/// SPEC §16 弹窗间隔: at least `interval_min` must pass between popup sessions
/// (even when learning cards become due sooner). Manual triggers bypass this.
pub fn interval_elapsed(
    last_popup_at: Option<DateTime<Utc>>,
    interval_min: u32,
    now: DateTime<Utc>,
) -> bool {
    last_popup_at.is_none_or(|t| now - t >= chrono::Duration::minutes(interval_min as i64))
}

/// SPEC §7.8 过载保护: the first gate is the per-popup quota (§7.4), the second
/// is the popup interval, this is the third — at most `limit` popup sessions
/// per study day (0 = 关). Beyond the cap the app degrades to light reminders.
pub fn daily_limit_reached(today_popups: i64, limit: u32) -> bool {
    limit > 0 && today_popups >= limit as i64
}

/// Everything `decide` needs, as one struct (2026-10-04 review): the four
/// planned features (monitoring, close policy, 组卷, decks) each add inputs,
/// and positional parameters were already at seven. `effective_interval_min`
/// is the CADENCE FUNNEL output: goal controller → application weight (v1:
/// constant 1) → clamp [3, 60] — later features modulate cadence only by
/// feeding this value.
#[derive(Debug, Clone)]
pub struct DecisionInput {
    pub due_count: usize,
    pub now: DateTime<Local>,
    pub settings: EngineSettings,
    pub popup_open: bool,
    pub last_popup_at: Option<DateTime<Utc>>,
    pub today_popups: i64,
    pub effective_interval_min: u32,
    pub force: bool,
}

/// Why the tick decided not to open a popup — loggable, testable, and later
/// shown in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    NotDue,
    PopupAlreadyOpen,
    OutsideStudyHours,
    Paused,
    DailyCap,
    IntervalPending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Open,
    Skip(SkipReason),
}

/// SPEC §8.2 popup gate, structured. `force` (explicit user intent) bypasses
/// the two throttles but not the hours/pause/popup-open checks.
pub fn decide(input: DecisionInput) -> Decision {
    let s = &input.settings;
    let now_utc = input.now.with_timezone(&Utc);
    if input.due_count == 0 {
        return Decision::Skip(SkipReason::NotDue);
    }
    if input.popup_open {
        return Decision::Skip(SkipReason::PopupAlreadyOpen);
    }
    if !in_study_hours(input.now, s) {
        return Decision::Skip(SkipReason::OutsideStudyHours);
    }
    if !not_paused(s, now_utc) {
        return Decision::Skip(SkipReason::Paused);
    }
    if input.force {
        return Decision::Open;
    }
    if daily_limit_reached(input.today_popups, s.daily_popup_limit) {
        return Decision::Skip(SkipReason::DailyCap);
    }
    if !interval_elapsed(input.last_popup_at, input.effective_interval_min, now_utc) {
        return Decision::Skip(SkipReason::IntervalPending);
    }
    Decision::Open
}

/// Center of the monitor work area, in **logical pixels** (2026-09-28 调整：
/// 用户要求固定居中，替代原随机位置方案). Vertically centered above the
/// taskbar reserve; the reserve is 48 logical px, matching the standard
/// Windows taskbar height.
pub fn popup_position(monitor: (f64, f64, f64, f64), win: (f64, f64)) -> (f64, f64) {
    let (mx, my, mw, mh) = monitor;
    let (ww, wh) = win;
    let work_h = (mh - TASKBAR_RESERVE).max(wh);
    (mx + (mw - ww) / 2.0, my + (work_h - wh) / 2.0)
}

fn read_settings(db: &Db) -> EngineSettings {
    let get = |k: &str| db.get_setting(k).ok().flatten();
    EngineSettings {
        interval_min: get("popup_interval_min")
            .and_then(|v| v.parse().ok())
            .unwrap_or(20),
        study_start: get("study_start").unwrap_or_else(|| "09:00".into()),
        study_end: get("study_end").unwrap_or_else(|| "22:30".into()),
        // A malformed paused_until degrades to "not paused" — the popup gate
        // must never take the whole engine down over a settings string.
        paused_until: get("paused_until").and_then(|v| db::parse_time(&v)),
        notify_mode: get("notify_mode").unwrap_or_else(|| "popup".into()),
        daily_popup_limit: get("daily_popup_limit")
            .and_then(|v| v.parse().ok())
            .unwrap_or(40),
        goal_enabled: get("goal_enabled").is_some_and(|v| v.trim() == "1"),
        goal_mode: crate::goal::GoalMode::from_setting(&get("goal_mode").unwrap_or_default()),
        goal_target: get("goal_target").and_then(|v| v.parse().ok()).unwrap_or(0),
        goal_start: get("goal_start").unwrap_or_else(|| "19:00".into()),
        goal_end: get("goal_end").unwrap_or_else(|| "22:00".into()),
        popup_idle_escape_min: get("popup_idle_escape_min")
            .and_then(|v| v.parse().ok())
            .unwrap_or(5),
    }
}

/// One engine pass. Returns true if a popup was opened. `force` is set for
/// manual triggers (tray "立即复习" / 复习选中) and bypasses the interval
/// throttle. `reload_settings` drops the cached settings first.
pub fn tick(
    app: &tauri::AppHandle,
    state: &Mutex<EngineState>,
    force: bool,
    reload_settings: bool,
) -> bool {
    let Some(db_cell) = app.try_state::<Mutex<Db>>() else {
        return false;
    };
    let now_local = Local::now();
    crate::logging::breadcrumb("tick:enter");
    let mut st = state.lock().unwrap_or_else(crate::recover_lock);
    crate::logging::breadcrumb("tick:st-locked");
    // Wake guard: a >2min tick gap means the machine slept. The first tick
    // after waking only refreshes bookkeeping and stays quiet.
    if let Some(last) = st.last_tick {
        if last.elapsed() > StdDuration::from_secs(WAKE_GUARD_SECS) {
            log::info!(
                "[engine] {}s tick gap — treating as system wake, staying quiet this pass",
                last.elapsed().as_secs()
            );
            st.last_tick = Some(Instant::now());
            if reload_settings {
                st.settings = None;
                st.goal_freeze = None;
            }
            return false;
        }
    }
    st.last_tick = Some(Instant::now());
    if reload_settings {
        st.settings = None;
        // 目标改了 → 份额/讲出率必须重算（评审：设目标时冻结一次）。
        st.goal_freeze = None;
    }
    if st.settings.is_none() {
        let db = db_cell.lock().unwrap_or_else(crate::recover_lock);
        st.settings = Some(read_settings(&db));
    }
    let settings = st.settings.clone().unwrap_or_default();
    // DEADLOCK FIX (2026-10-05, proven by breadcrumbs): window queries like
    // is_visible()/is_minimized() dispatch to the MAIN thread and wait. If we
    // called them while holding the DB mutex, a main-thread command waiting
    // for that same mutex (review_queue/rate/...) would freeze everything:
    // engine waits for main, main waits for the DB lock the engine holds.
    // So every main-thread-dispatched call happens OUTSIDE the DB critical
    // section — the rule for anything added to this function later.
    let popup_on_screen = popup_open(app);
    // 离手逃离：必须在 DB 锁之外跑（内部要读窗口位置/鼠标位置，会派发到主线程）。
    if popup_on_screen {
        handle_popup_idle(app, settings.popup_idle_escape_min);
    }
    let (due, today_popups, counters, per_popup, dodges, dwell_secs, study_day, activity_test_secs) = {
        crate::logging::breadcrumb("tick:db-in");
        let db = db_cell.lock().unwrap_or_else(crate::recover_lock);
        crate::logging::breadcrumb("tick:db-locked");
        // Study day rolls at 04:00 local (Anki's convention) so a session just
        // past midnight counts towards the previous day's quota.
        let study_day = db::study_day_of(Utc::now());
        // SPEC §7.4/§16: one shared accessor (was a second hard-coded default:
        // the engine planned with 3 while the popup could serve 1).
        let per_popup: u32 = services::per_popup_size(&db).max(1) as u32;
        let dwell_secs: u64 = db
            .get_setting("activity_dwell_secs")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);
        // 调试直通 (测试监控用): >0 时娱乐持续 N 秒即立即弹窗，测完设回 0。
        let activity_test_secs: u64 = db
            .get_setting("activity_test_secs")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let archive_threshold: i64 = db
            .get_setting("archive_threshold")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3)
            .clamp(2, 5);
        let mut counters = GoalCounters {
            reviewed_today: db.review_count_on_study_day(&study_day).unwrap_or(0),
            spoken_today: db.speak_cards_on_day(&study_day).unwrap_or(0),
            mastered_today: db
                .mastered_cards_on_day(&study_day, archive_threshold)
                .unwrap_or(0),
            pool_left: db.pushable_pool_left(&study_day).unwrap_or(0),
            reviewed_in_window: 0,
            budget: None,
            speak_rate: crate::goal::speak_rate(0, 0),
        };
        if settings.goal_enabled && settings.goal_mode == crate::goal::GoalMode::Speak {
            let stale = st
                .goal_freeze
                .as_ref()
                .is_none_or(|(day, _, _)| day != &study_day);
            if stale {
                let (speaks, draws) = db.speak_rate_sample().unwrap_or((0, 0));
                let rate = crate::goal::speak_rate(speaks, draws);
                let budget = crate::goal::speak_budget(i64::from(settings.goal_target), rate);
                log::info!(
                    "[engine] 今日目标(讲出): 近 14 学习日讲出 {speaks}/{draws} → p={rate:.2}; \
                     讲出 {} 张 ≈ 复习 {budget} 张（冻结，时段内不更新）",
                    settings.goal_target
                );
                st.goal_freeze = Some((study_day.clone(), budget, rate));
            }
            if let Some((_, budget, rate)) = st.goal_freeze {
                counters.budget = Some(budget);
                counters.speak_rate = rate;
            }
            // 份额的消费计量 = 目标时段内的复习张数（只算时段内，早上复习不会
            // 把晚上的份额先花掉）。
            counters.reviewed_in_window = parse_hhmm(&settings.goal_start)
                .and_then(|(h, m)| db.review_count_from(&study_day, i64::from(h * 60 + m)).ok())
                .unwrap_or(0);
        }
        (
            services::due_count(&db).unwrap_or(0) as usize,
            db.popup_count_on(&study_day).unwrap_or(0),
            counters,
            per_popup,
            services::dodge_streak(&db),
            dwell_secs,
            study_day,
            activity_test_secs,
        )
    };
    crate::logging::breadcrumb("tick:db-out");
    // 调频漏斗 (2026-10-04 rework, 大师 §五/§六): goal controller → 逃避惩罚 →
    // 娱乐加速；everything clamps to [3, 60] minutes.
    let (goal_cadence, goal_reason) = goal_interval(now_local, &settings, &counters, per_popup);
    // 有目标节奏时，逃避惩罚不再压缩间隔（见下方注释）。
    let goal_active = goal_cadence.is_some();
    if goal_reason != crate::goal::CadenceReason::Off {
        log::debug!("[engine] goal cadence {goal_reason:?}: {goal_cadence:?} min");
    }
    let mut effective_interval = goal_cadence
        .unwrap_or(settings.interval_min)
        .clamp(INTERVAL_FLOOR_MIN, INTERVAL_CEILING_MIN);
    // 连续关闭惩罚 (大师 §六): 不加量，只提速 + 降低门槛——间隔压到 10 分钟，
    // 下次弹窗只出 1 张。有评分就自然回落（streak 只统计未评分关闭）。
    // The override travels via the lock-free EngineShared channel (see the
    // deadlock note there) — the command layer must never wait on a mutex the
    // engine holds across window operations.
    let override_cards = if dodges >= services::DODGE_PENALTY_STREAK {
        log::debug!("[engine] dodge streak {dodges}: 1-card popups, interval capped");
        1i64
    } else {
        0
    };
    if let Some(shared) = app.try_state::<EngineShared>() {
        shared
            .session_size_override
            .store(override_cards, std::sync::atomic::Ordering::Relaxed);
    }
    // 应用权重 (2026-10-05, 大师 §五): 娱乐持续 ≥dwell → 间隔减半（把打断送到
    // 眼前，当日加速弹窗封顶 30% 防失控）；学习持续 ≥dwell → 间隔翻倍（不打扰
    // 深度工作），并配合下面的"延后到切换间隙"。中性/未达 dwell 权重 1。
    let mut activity_category: Option<crate::activity::Category> = None;
    let mut dwell_met = false;
    let mut test_trigger = false;
    if let Some(shared) = app.try_state::<std::sync::Arc<crate::activity::ActivityShared>>() {
        if let Some((category, held)) = shared.category_duration() {
            activity_category = Some(category);
            dwell_met = held >= StdDuration::from_secs(dwell_secs);
            // 调试直通: activity_test_secs > 0 时娱乐持续 N 秒立即弹（无视间隔
            // 与每日上限节流；仍需有到期卡、在时段内、未暂停、无弹窗开着）。
            if category == crate::activity::Category::Entertainment
                && activity_test_secs > 0
                && held >= StdDuration::from_secs(activity_test_secs)
            {
                test_trigger = true;
            }
        }
    }
    if test_trigger {
        log::info!(
            "[engine] activity TEST: entertainment ≥{activity_test_secs}s → immediate popup (due={due})"
        );
    }
    if st.accel_day.as_deref() != Some(study_day.as_str()) {
        st.accel_day = Some(study_day.clone());
        st.accel_popups_today = 0;
    }
    let accel_cap = i64::from(settings.daily_popup_limit) * 3 / 10;
    let accel_cap_ok = accel_cap <= 0 || st.accel_popups_today < accel_cap;
    let accelerate_now = activity_category == Some(crate::activity::Category::Entertainment)
        && dwell_met
        && accel_cap_ok
        && !force
        && !test_trigger;
    // The weight only applies when it may actually take effect: entertainment
    // stops halving once its daily cap is reached (study doubling has no cap).
    let weight_active = dwell_met
        && !force
        && !test_trigger
        && (activity_category != Some(crate::activity::Category::Entertainment) || accel_cap_ok);
    effective_interval =
        apply_activity_weight(effective_interval, activity_category, weight_active);
    if accelerate_now {
        log::debug!("[engine] entertainment acceleration: interval {effective_interval} min");
    } else if weight_active && activity_category == Some(crate::activity::Category::Study) {
        log::debug!("[engine] study app: interval {effective_interval} min (postponed cadence)");
    }
    // 连续关闭惩罚：躲闪优先于学习抑制——人在学习却说关就关，10 分钟后再来。
    // 但**有目标节奏时不压缩间隔**（2026-10-06 评审）：此时人已经在按事先同意的
    // 节奏走，连续逃避说明他已经过载，节奏该放松而不是更紧；张数照样减到 1。
    if dodges >= services::DODGE_PENALTY_STREAK && !goal_active {
        effective_interval = effective_interval.min(services::DODGE_INTERVAL_MIN);
    }
    // Debug direct path: same semantics as 托盘「立即复习」 (force bypasses the
    // interval and daily-cap throttles but not hours/pause/open/due gates).
    let force = force || test_trigger;
    // Low-cost incentive (2026-10-04 review): the tray tooltip carries the
    // daily progress. Best effort — a tooltip failure must never matter.
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(format!(
            "闪记 FlashMemo — 今日已复习 {} 张 · 待复习 {due} 张",
            counters.reviewed_today
        )));
    }
    if settings.notify_mode == "notify" {
        // 仅轻提醒 mode: same gates as popups, but the output is a notification
        // (throttled inside maybe_notify). The daily cap only degrades popups.
        if due == 0 || !in_study_hours(now_local, &settings) || !not_paused(&settings, Utc::now()) {
            return false;
        }
        maybe_notify(app, due, effective_interval, false, &mut st);
        return false;
    }
    let input = DecisionInput {
        due_count: due,
        now: now_local,
        settings: settings.clone(),
        popup_open: popup_on_screen,
        last_popup_at: st.last_popup_at,
        today_popups,
        effective_interval_min: effective_interval,
        force,
    };
    match decide(input) {
        Decision::Skip(SkipReason::DailyCap) => {
            // SPEC §7.8: once the daily cap is reached, popups stop but light
            // reminders remain.
            maybe_notify(app, due, effective_interval, true, &mut st);
            false
        }
        Decision::Skip(reason) => {
            log::debug!("[engine] popup skipped: {reason:?}");
            false
        }
        Decision::Open => {
            // 学习应用延后 (2026-10-05, 评审建议): 弹窗该响时人正在 IDE/文档
            // 里深度工作 → 等下一次切换应用的间隙再弹（最多延后 15 分钟，
            // 到点照弹）；手动触发与调试直通不受延后影响。
            let deferred_for = st.deferred_since.map(|t| t.elapsed());
            let category_here = activity_category.unwrap_or(crate::activity::Category::Neutral);
            if defer_study_popup(category_here, dwell_met, force, deferred_for) {
                if st.deferred_since.is_none() {
                    st.deferred_since = Some(Instant::now());
                }
                log::debug!(
                    "[engine] study app active: popup deferred ({}s, cap 15 min, due={due})",
                    deferred_for.map(|d| d.as_secs()).unwrap_or(0)
                );
                return false;
            }
            st.deferred_since = None;
            // 空弹窗防护 (SPEC §14, 2026-10-06 F5): 「待复习」数的是候选池，而池里
            // 可能只剩被**当日新卡配额**挡住的卡——那时弹窗会一闪即关，还白吃掉
            // 一次 popup_log 与整个弹窗间隔。先问"这次真有卡吗"，再开窗。
            // DB 锁只在这个判断里持有；窗口操作在锁外（见上面的死锁注记）。
            {
                let has_content = app
                    .try_state::<Mutex<Db>>()
                    .map(|cell| {
                        let db = cell.lock().unwrap_or_else(crate::recover_lock);
                        services::popup_has_content(&db, per_popup)
                    })
                    .unwrap_or(true);
                if !has_content {
                    log::info!("[engine] popup skipped: 池里没有可抽的卡（新卡配额已用尽）");
                    return false;
                }
            }
            let (mx, my, mw, mh) = cursor_monitor_logical(app);
            let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
            log::debug!(
                "[engine] popup at logical ({:.0}, {:.0}) on monitor ({:.0}, {:.0}, {:.0}, {:.0})",
                pos.0,
                pos.1,
                mx,
                my,
                mw,
                mh
            );
            // Auto popup: never steals keyboard focus (SPEC §8.3).
            crate::logging::breadcrumb("tick:open-in");
            match open_popup(app, pos, false, "auto") {
                Ok(_window) => {
                    st.last_popup_at = Some(Utc::now());
                    if accelerate_now {
                        st.accel_popups_today += 1;
                    }
                    crate::logging::breadcrumb("tick:open-out");
                    true
                }
                // The reason (missing window vs show failure) is the first
                // thing a bug report needs when "开始复习 did nothing".
                Err(e) => {
                    log::error!("[review] engine failed to open popup: {e}");
                    false
                }
            }
        }
    }
}

/// Light notification (SPEC §8.1), throttled to one per popup interval.
/// `capped` marks the §7.8 case: the daily popup cap is reached, so only the
/// reminder remains.
fn maybe_notify(
    app: &tauri::AppHandle,
    due: usize,
    interval_min: u32,
    capped: bool,
    st: &mut EngineState,
) {
    let due_notify = st
        .last_notify
        .is_none_or(|t| Utc::now() - t >= chrono::Duration::minutes(interval_min as i64));
    if due_notify && !popup_open(app) {
        st.last_notify = Some(Utc::now());
        show_notification(app, due, capped);
    }
}

/// 离手逃离 (2026-10-06 用户发现): 弹窗开着却长时间没人碰 —— 典型的"把它拖到
/// 副屏放在那儿不管"。因为引擎把"屏上有弹窗"当作"用户正在复习"而不再弹新的，
/// 这个动作等于一个**当天静音且零代价**的开关（没关闭就上报，逃避链也数不到）。
///
/// 处置：把弹窗拉回**光标所在显示器**中央（再拖走就再拉回），并把这个会话记成
/// 一次「逃离」进逃避链。**鼠标在弹窗上不算离手**——慢慢地读、认真地改批注不该
/// 被罚，只有"人不在弹窗上"才算。一个会话只记一次逃离，重复拖走只重复拉回。
pub fn popup_idle_escape(
    timeout_min: u32,
    activity_at: i64,
    now: i64,
    cursor_over_popup: bool,
) -> Option<IdleAction> {
    if timeout_min == 0 || cursor_over_popup {
        return None;
    }
    let idle_secs = now - activity_at;
    if idle_secs < i64::from(timeout_min) * 60 {
        return None;
    }
    Some(IdleAction { idle_secs })
}

/// 离手判定结果（`idle_secs` 只用于日志）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdleAction {
    pub idle_secs: i64,
}

/// 执行离手处置：拉回光标所在显示器 + 记一次逃离。调用方必须**不持有 DB 锁**
/// （`outer_position`/`cursor_position` 会派发到主线程，见 tick 里的死锁注释）。
fn handle_popup_idle(app: &tauri::AppHandle, timeout_min: u32) {
    if timeout_min == 0 {
        return;
    }
    let Some(shared) = app.try_state::<EngineShared>() else {
        return;
    };
    let session_id = shared
        .popup_session_id
        .load(std::sync::atomic::Ordering::Relaxed);
    if session_id <= 0 {
        return;
    }
    let Some(w) = app.get_webview_window("popup") else {
        return;
    };
    let activity_at = shared
        .popup_activity_at
        .load(std::sync::atomic::Ordering::Relaxed);
    let Some(action) = popup_idle_escape(
        timeout_min,
        activity_at,
        Utc::now().timestamp(),
        cursor_over(&w, app),
    ) else {
        return;
    };
    let (mx, my, mw, mh) = cursor_monitor_logical(app);
    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
    let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        pos.0, pos.1,
    )));
    // 一个会话只记一次逃离：逃避链的单位是"会话"，不是"分钟"。
    let first_time = shared
        .popup_idle_marked
        .swap(session_id, std::sync::atomic::Ordering::Relaxed)
        != session_id;
    log::info!(
        "[engine] popup idle {}s → recentered to cursor monitor{}",
        action.idle_secs,
        if first_time {
            " + counted as escape"
        } else {
            ""
        }
    );
    if first_time {
        if let Some(cell) = app.try_state::<Mutex<Db>>() {
            let db = cell.lock().unwrap_or_else(crate::recover_lock);
            let _ = db.mark_session_escaped(session_id);
        }
    }
}

/// 鼠标是否落在弹窗上（物理像素比较）。取不到位置就当作"不在上面"——宁可错判
/// 成离手（用户会被拉回一次，看得见），也不放过"拖走不管"。
fn cursor_over(w: &tauri::WebviewWindow, app: &tauri::AppHandle) -> bool {
    let Ok(cursor) = app.cursor_position() else {
        return false;
    };
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return false;
    };
    let right = f64::from(pos.x + size.width as i32);
    let bottom = f64::from(pos.y + size.height as i32);
    cursor.x >= f64::from(pos.x)
        && cursor.x <= right
        && cursor.y >= f64::from(pos.y)
        && cursor.y <= bottom
}

/// Is a review session actually on screen? A MINIMIZED window still reports
/// `is_visible() == true` (2026-10-03) — counting it as "open" once froze the
/// engine forever: the user minimized the popup (which also hides from the
/// taskbar), every tick skipped with PopupAlreadyOpen, and no new popup could
/// ever appear (user report 2026-10-05). Minimized = not open: the next
/// `open_popup` un-minimizes and restores the same session instead.
fn popup_open(app: &tauri::AppHandle) -> bool {
    match app.get_webview_window("popup") {
        Some(w) => {
            let visible = w.is_visible().unwrap_or(false);
            let minimized = w.is_minimized().unwrap_or(false);
            visible && !minimized
        }
        None => false,
    }
}

/// Record a popup session: the daily-cap row (SPEC §7.8) plus the close-policy
/// session row the frontend reports against. Best effort — a logging failure
/// must never interfere with the popup itself.
fn record_popup(app: &tauri::AppHandle, session_id: i64, origin: &str) {
    crate::logging::breadcrumb("open:record-in");
    if let Some(cell) = app.try_state::<Mutex<Db>>() {
        if let Ok(db) = cell.lock() {
            let _ = db.insert_popup_log(Utc::now());
            let _ = db.open_popup_session(session_id, Utc::now(), origin);
        }
    }
    crate::logging::breadcrumb("open:record-out");
}

fn show_notification(app: &tauri::AppHandle, due: usize, capped: bool) {
    use tauri_plugin_notification::NotificationExt;
    let body = if capped {
        format!("⏰ 有 {due} 张卡片待复习（今日弹窗已达上限，通过托盘菜单「立即复习」打开）")
    } else {
        format!("⏰ 有 {due} 张卡片待复习，通过托盘菜单「立即复习」打开")
    };
    let _ = app
        .notification()
        .builder()
        .title("闪记 FlashMemo")
        .body(body)
        .show();
}

/// Monitor the cursor is on, expressed in **logical** pixels because that is
/// what Tauri's window APIs consume (`WebviewWindowBuilder::position`/
/// `inner_size` are logical while `Monitor::size()`/`position()` are physical).
/// Mixing the two breaks centering on scaled displays — e.g. a 2560x1440 panel
/// at 150% reports 1707x960 logical; using physical numbers puts the window
/// 1.5x too far from the origin.
fn cursor_monitor_logical(app: &tauri::AppHandle) -> (f64, f64, f64, f64) {
    let fallback = (0.0, 0.0, 1920.0, 1080.0);
    let Ok(cursor) = app.cursor_position() else {
        return fallback;
    };
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let s = m.scale_factor();
            (
                m.position().x as f64 / s,
                m.position().y as f64 / s,
                m.size().width as f64 / s,
                m.size().height as f64 / s,
            )
        }
        None => fallback,
    }
}

/// `focus` marks explicit user intent (开始复习/复习选中/学新卡/托盘立即复习):
/// those also bring the popup to the foreground. The 15s-tick auto popup must
/// NOT steal keyboard focus (SPEC §8.3). `origin` tags the close-policy
/// session row ("auto" = tick-driven; manual sessions never count as dodges).
fn open_popup(
    app: &tauri::AppHandle,
    pos: (f64, f64),
    focus: bool,
    origin: &str,
) -> tauri::Result<(tauri::WebviewWindow, i64)> {
    // The popup is declared as a hidden window in tauri.conf.json. Reusing
    // that already-created WebView avoids the Windows WebView2 deadlock that
    // occurs when a second controller is created at runtime.
    let window = match app.get_webview_window("popup") {
        Some(w) => w,
        // Self-heal: the popup WEBVIEW (not just the page) can be lost while
        // the window sits hidden — a dev-server full reload or a renderer
        // crash does it (2026-10-03: "第一次能弹、第二次不行" reproduced via
        // logs). The leftover window shell without its webview must be
        // destroyed first, or building a new one with the same label is
        // rejected and every future popup stays broken until app restart.
        // The caller always runs on a worker thread, so runtime creation here
        // is safe per Tauri's WebviewWindowBuilder guidance.
        None => {
            if let Some(shell) = app.get_window("popup") {
                log::warn!("[review] popup webview lost, destroying the leftover shell");
                let _ = shell.destroy();
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            recreate_popup(app)?
        }
    };
    crate::logging::breadcrumb("open:win");
    window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        pos.0, pos.1,
    )))?;
    crate::logging::breadcrumb("open:positioned");
    window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        POPUP_SIZE.0,
        POPUP_SIZE.1,
    )))?;
    crate::logging::breadcrumb("open:sized");
    // Restore BEFORE showing: show() on a minimized window can land it back in
    // the taskbar on Windows (2026-10-07 "最小化后弹窗弹不出"), and the restore
    // animation can swallow the show. unminimize → show → unminimize again is
    // belt and braces, then re-assert always-on-top in case the z-order flag
    // was dropped while the window sat hidden.
    let _ = window.unminimize();
    window.show()?;
    crate::logging::breadcrumb("open:shown");
    // A MINIMIZED window still reports visible=true, so show() alone leaves it
    // collapsed in the taskbar and a second 开始复习 "does nothing"
    // (2026-10-03 user report). Restore it explicitly.
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    if focus {
        let _ = window.set_focus();
    }
    crate::logging::breadcrumb("open:restored");
    let session_id = next_session_id();
    record_popup(app, session_id, origin);
    // 离手逃离的计时起点：新会话开张就把"最近交互"重置到现在、清掉上轮的标记。
    if let Some(shared) = app.try_state::<EngineShared>() {
        shared.popup_session_id.store(session_id, Ordering::Relaxed);
        shared.popup_idle_marked.store(0, Ordering::Relaxed);
        shared
            .popup_activity_at
            .store(Utc::now().timestamp(), Ordering::Relaxed);
    }
    crate::logging::breadcrumb("open:signal-in");
    signal_popup_session(&window, session_id)?;
    crate::logging::breadcrumb("open:signal-out");
    Ok((window, session_id))
}

/// Rebuild the pre-declared popup window after it was lost. Mirrors the
/// tauri.conf.json declaration (`visible: false`, always on top, no taskbar
/// entry); the caller positions and shows it afterwards.
fn recreate_popup(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    log::warn!("[review] popup window missing, recreating it");
    let built =
        tauri::WebviewWindowBuilder::new(app, "popup", tauri::WebviewUrl::App("index.html".into()))
            .title("闪记")
            .visible(false)
            .inner_size(POPUP_SIZE.0, POPUP_SIZE.1)
            .min_inner_size(600.0, 560.0)
            .resizable(true)
            .focused(false)
            .always_on_top(true)
            .skip_taskbar(true)
            // The header inside the page is the title bar (drag region + ✕);
            // a native frame would duplicate it and pin a permanent close
            // button that per-card close policies cannot hide.
            .decorations(false)
            .shadow(true)
            // Minimizing a skip-taskbar window makes it unreachable, and a
            // minimized window still counts as "visible" (see popup_open) —
            // remove the trap at the source, matching tauri.conf.json.
            .minimizable(false)
            .maximizable(false)
            .build();
    match &built {
        Ok(_) => log::info!("[review] popup window recreated"),
        Err(e) => log::error!("[review] recreating popup failed: {e}"),
    }
    built
}

fn next_session_id() -> i64 {
    let id = POPUP_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    id as i64
}

/// Tell the reusable popup WebView to load a fresh review batch. Repeating the
/// signal covers a slow first WebView load; the React side de-duplicates by id.
fn signal_popup_session(window: &tauri::WebviewWindow, session_id: i64) -> tauri::Result<()> {
    for delay in [50_u64, 150, 350] {
        std::thread::sleep(std::time::Duration::from_millis(delay));
        window.emit("review-popup-open", session_id)?;
    }
    Ok(())
}

/// Open a popup right now for an explicit card selection ("复习选中/复习该包").
/// Replaces any popup already on screen so the new session takes effect.
pub fn open_review_popup(app: &tauri::AppHandle) -> bool {
    let (mx, my, mw, mh) = cursor_monitor_logical(app);
    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
    // Explicit trigger: restore a minimized popup and focus it.
    open_popup(app, pos, true, "manual").is_ok()
}

/// Background loop: wakes on events (settings change, review activity) and
/// otherwise falls back to a 15s tick. The wake channel is managed as
/// `EngineWake` state so the command layer can poke it.
pub fn spawn(app: tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    let (tx, rx) = mpsc::channel::<EngineEvent>();
    app.manage(EngineWake(tx));
    std::thread::spawn(move || loop {
        let mut reload_settings = false;
        match rx.recv_timeout(StdDuration::from_secs(TICK_SECS)) {
            Ok(EngineEvent::SettingsChanged) => {
                reload_settings = true;
                log::debug!("[engine] woken by settings change");
            }
            Ok(event) => log::debug!("[engine] woken by {event:?}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        tick(&app, &state, false, reload_settings);
    });
}

/// Wire the immediate-review path: tray "立即复习" emits `force-review`.
/// If a popup session is already open, surface it; otherwise open one now,
/// bypassing the interval throttle (the user asked explicitly).
pub fn listen_force_review(app: &tauri::AppHandle, state: std::sync::Arc<Mutex<EngineState>>) {
    let handle = app.clone();
    app.listen("force-review", move |_| {
        // Webview2 window creation must never run inside a synchronous Tauri
        // event callback on Windows. The runtime waits for the event loop to
        // finish the callback while Webview2 waits for that same loop, which
        // produces a blank "not responding" popup. Move the whole operation
        // to a worker thread, matching Tauri's WebviewWindowBuilder guidance.
        let handle = handle.clone();
        let state = state.clone();
        std::thread::spawn(move || {
            let popup_visible = handle
                .get_webview_window("popup")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if popup_visible {
                if let Some(w) = handle.get_webview_window("popup") {
                    // Rescue path: an already-open popup may have been dragged
                    // (or restored) onto a monitor the user can't see — e.g.
                    // the portrait second screen (user report 2026-10-05).
                    // 立即复习 is explicit intent: bring it back to the center
                    // of the monitor under the cursor.
                    let (mx, my, mw, mh) = cursor_monitor_logical(&handle);
                    let pos = popup_position((mx, my, mw, mh), POPUP_SIZE);
                    let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                        pos.0, pos.1,
                    )));
                    let _ = w.show();
                    // A minimized popup counts as visible; restore it too.
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    if let Err(e) = signal_popup_session(&w, next_session_id()) {
                        log::error!("[review] failed to refresh popup session: {e}");
                    }
                }
            } else {
                tick(&handle, &state, true, false);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn settings() -> EngineSettings {
        EngineSettings::default()
    }

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 28, h, m, 0).unwrap()
    }

    #[test]
    fn idle_escape_fires_only_when_unattended() {
        // 5 分钟阈值：240 秒还不算，满 300 秒才算
        assert_eq!(popup_idle_escape(5, 1000, 1240, false), None);
        assert_eq!(
            popup_idle_escape(5, 1000, 1300, false),
            Some(IdleAction { idle_secs: 300 })
        );
        // 鼠标在弹窗上（在读、在改批注）永远不算离手——读得慢不该被罚
        assert_eq!(popup_idle_escape(5, 1000, 9999, true), None);
        // 0 = 关闭该保护
        assert_eq!(popup_idle_escape(0, 1000, 9999, false), None);
    }

    #[test]
    fn in_study_hours_bounds() {
        let s = settings();
        assert!(!in_study_hours(at(8, 59), &s));
        assert!(in_study_hours(at(9, 0), &s));
        assert!(in_study_hours(at(22, 30), &s));
        assert!(!in_study_hours(at(22, 31), &s));
    }

    fn input(
        now: DateTime<Local>,
        s: &EngineSettings,
        last: Option<DateTime<Utc>>,
        force: bool,
    ) -> DecisionInput {
        DecisionInput {
            due_count: 5,
            now,
            settings: s.clone(),
            popup_open: false,
            last_popup_at: last,
            today_popups: 0,
            effective_interval_min: s.interval_min,
            force,
        }
    }

    fn counters(reviewed: i64) -> GoalCounters {
        GoalCounters {
            reviewed_today: reviewed,
            pool_left: 100,
            ..GoalCounters::default()
        }
    }

    #[test]
    fn goal_interval_follows_the_window_and_target() {
        use crate::goal::CadenceReason;
        let mut s = settings();
        s.goal_enabled = true;
        s.goal_target = 30;
        s.goal_start = "19:00".into();
        s.goal_end = "22:00".into();
        // 19:30, nothing reviewed: 150 min ÷ ceil(30/3)=10 popups → 15 min.
        assert_eq!(goal_interval(at(19, 30), &s, &counters(0), 3).0, Some(15));
        // Halfway done: remaining 15 → 5 popups → 30 min (self-correcting).
        assert_eq!(goal_interval(at(19, 30), &s, &counters(15), 3).0, Some(30));
        // Goal met → no cadence (positive completion, no more pushing).
        assert_eq!(
            goal_interval(at(19, 30), &s, &counters(30), 3).1,
            CadenceReason::Reached
        );
        // Window not open yet / already over → 目标当天作废.
        assert_eq!(
            goal_interval(at(18, 59), &s, &counters(0), 3).1,
            CadenceReason::OutsideWindow
        );
        assert_eq!(
            goal_interval(at(22, 1), &s, &counters(0), 3).1,
            CadenceReason::OutsideWindow
        );
        // Almost no time left: the raw gap wants 0 minutes, but the plan floor
        // (plan 18 min ÷ 2 = 9) holds it off the 3-minute floor — the review's
        // "at most 2× faster than plan" fix applies to review mode too.
        let (interval, reason) = goal_interval(at(21, 59), &s, &counters(0), 3);
        assert_eq!(interval, Some(9));
        assert_eq!(reason, CadenceReason::CappedAtPlan);
        // Remaining time is generous: clamps to the 60-minute ceiling.
        let mut huge = s.clone();
        huge.goal_target = 3;
        assert_eq!(goal_interval(at(19, 0), &huge, &counters(0), 3).0, Some(60));
        // Disabled → no cadence at all.
        s.goal_enabled = false;
        assert_eq!(
            goal_interval(at(19, 30), &s, &counters(0), 3).1,
            CadenceReason::Off
        );
    }

    #[test]
    fn speak_goal_never_escalates_when_nothing_gets_spoken() {
        use crate::goal::CadenceReason;
        let mut s = settings();
        s.goal_enabled = true;
        s.goal_mode = crate::goal::GoalMode::Speak;
        s.goal_target = 30;
        // 30 张 ÷ p=0.5 → 份额 60；一轮 3 张。
        let mut c = GoalCounters {
            budget: Some(60),
            speak_rate: 0.5,
            pool_left: 100,
            ..GoalCounters::default()
        };
        // 份额一路花完却一张没讲出来：间隔不会越变越短，最后回落常规节奏。
        let mut prev = 0;
        for reviewed in 0..=60 {
            c.reviewed_in_window = reviewed;
            let (interval, reason) = goal_interval(at(19, 30), &s, &c, 3);
            match interval {
                Some(m) => {
                    assert!(m >= prev, "份额消费变多反而弹得更密：{prev} → {m}");
                    prev = m;
                }
                None => {
                    assert_eq!(reason, CadenceReason::BudgetSpent);
                    assert_eq!(reviewed, 60, "份额应当刚好在第 60 张复习时花完");
                }
            }
        }
    }

    #[test]
    fn speak_goal_reports_pool_exhaustion_as_done() {
        use crate::goal::CadenceReason;
        let mut s = settings();
        s.goal_enabled = true;
        s.goal_mode = crate::goal::GoalMode::Speak;
        s.goal_target = 30;
        let c = GoalCounters {
            spoken_today: 5,
            budget: Some(60),
            speak_rate: 0.5,
            pool_left: 0,
            ..GoalCounters::default()
        };
        assert_eq!(
            goal_interval(at(19, 30), &s, &c, 3).1,
            CadenceReason::PoolExhausted
        );
    }

    #[test]
    fn activity_weight_halves_entertainment_and_doubles_study() {
        use crate::activity::Category;
        assert_eq!(
            apply_activity_weight(20, Some(Category::Entertainment), true),
            10
        );
        assert_eq!(apply_activity_weight(20, Some(Category::Study), true), 40);
        assert_eq!(apply_activity_weight(20, Some(Category::Neutral), true), 20);
        assert_eq!(
            apply_activity_weight(20, Some(Category::Study), false),
            20,
            "dwell gate blocks the weight"
        );
        assert_eq!(
            apply_activity_weight(50, Some(Category::Study), true),
            60,
            "study doubling respects the ceiling"
        );
        assert_eq!(
            apply_activity_weight(5, Some(Category::Entertainment), true),
            3,
            "halving respects the floor"
        );
        assert_eq!(apply_activity_weight(20, None, true), 20);
    }

    #[test]
    fn study_deferral_waits_for_a_switch_with_a_fifteen_minute_cap() {
        use crate::activity::Category;
        let study = Category::Study;
        assert!(
            defer_study_popup(study, true, false, None),
            "the first due popup starts the deferral"
        );
        assert!(
            defer_study_popup(study, true, false, Some(StdDuration::from_secs(600))),
            "still deferring ten minutes in"
        );
        assert!(
            !defer_study_popup(
                study,
                true,
                false,
                Some(STUDY_DEFER_MAX + StdDuration::from_secs(1))
            ),
            "cap reached — pop anyway"
        );
        assert!(
            !defer_study_popup(study, true, true, None),
            "manual triggers bypass the deferral"
        );
        assert!(
            !defer_study_popup(study, false, false, None),
            "only after the dwell threshold"
        );
        assert!(
            !defer_study_popup(Category::Neutral, true, false, None),
            "非学习不延后（切走后下一 tick 正常弹）"
        );
    }

    #[test]
    fn decide_skips_with_reasons() {
        let s = settings();
        // Nothing due.
        assert_eq!(
            decide(DecisionInput {
                due_count: 0,
                ..input(at(10, 0), &s, None, false)
            }),
            Decision::Skip(SkipReason::NotDue)
        );
        // Outside study hours.
        assert_eq!(
            decide(input(at(7, 0), &s, None, false)),
            Decision::Skip(SkipReason::OutsideStudyHours)
        );
        // Paused (pause stamps are UTC; anchor them to the test's own clock).
        let base = at(10, 0).with_timezone(&Utc);
        let mut paused = settings();
        paused.paused_until = Some(base + chrono::Duration::hours(1));
        assert_eq!(
            decide(input(at(10, 0), &paused, None, false)),
            Decision::Skip(SkipReason::Paused)
        );
        // Popup already open.
        let mut open = input(at(10, 0), &s, None, false);
        open.popup_open = true;
        assert_eq!(decide(open), Decision::Skip(SkipReason::PopupAlreadyOpen));
        // All clear.
        assert_eq!(decide(input(at(10, 0), &s, None, false)), Decision::Open);
        // Pause expired.
        paused.paused_until = Some(base - chrono::Duration::hours(1));
        assert_eq!(
            decide(input(at(10, 0), &paused, None, false)),
            Decision::Open
        );
    }

    #[test]
    fn popup_throttled_by_interval_setting() {
        // Default interval is 20 minutes (2026-10-04 review).
        let s = settings();
        let base = at(10, 0).with_timezone(&Utc);
        let recent = Some(base - chrono::Duration::minutes(2));
        assert_eq!(
            decide(input(at(10, 0), &s, recent, false)),
            Decision::Skip(SkipReason::IntervalPending),
            "a just-due card must wait for the popup interval"
        );
        let old = Some(base - chrono::Duration::minutes(21));
        assert_eq!(decide(input(at(10, 0), &s, old, false)), Decision::Open);
        // Manual triggers bypass the throttle.
        assert_eq!(decide(input(at(10, 0), &s, recent, true)), Decision::Open);
        // User-configured 5-minute interval.
        let mut custom = settings();
        custom.interval_min = 5;
        let four = Some(base - chrono::Duration::minutes(4));
        assert_eq!(
            decide(input(at(10, 0), &custom, four, false)),
            Decision::Skip(SkipReason::IntervalPending)
        );
        let six = Some(base - chrono::Duration::minutes(6));
        assert_eq!(
            decide(input(at(10, 0), &custom, six, false)),
            Decision::Open
        );
    }

    #[test]
    fn daily_limit_reached_respects_zero_as_unlimited() {
        assert!(!daily_limit_reached(119, 120));
        assert!(daily_limit_reached(120, 120));
        assert!(daily_limit_reached(121, 120));
        assert!(!daily_limit_reached(9_999, 0), "0 = 关掉上限");
    }

    #[test]
    fn daily_cap_suppresses_popup_but_manual_force_bypasses() {
        let s = settings();
        let old = Some(at(10, 0).with_timezone(&Utc) - chrono::Duration::hours(1));
        // Cap reached: no popup even with everything else clear…
        let mut capped = input(at(10, 0), &s, old, false);
        capped.today_popups = capped.settings.daily_popup_limit as i64;
        assert_eq!(decide(capped), Decision::Skip(SkipReason::DailyCap));
        // …and light reminders fire instead (tick maps DailyCap → maybe_notify).
        // Manual 「立即复习」 is explicit user intent — it still opens.
        let mut forced = input(at(10, 0), &s, old, true);
        forced.today_popups = 10_000;
        assert_eq!(decide(forced), Decision::Open);
        // Under the cap nothing changes.
        assert_eq!(decide(input(at(10, 0), &s, old, false)), Decision::Open);
    }

    #[test]
    fn popup_position_is_workarea_center() {
        // 100% scaling, 1920x1080 with a 48px taskbar.
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(
            popup_position(monitor, POPUP_SIZE),
            (
                (1920.0 - POPUP_SIZE.0) / 2.0,
                (1080.0 - 48.0 - POPUP_SIZE.1) / 2.0
            )
        );
    }

    #[test]
    fn popup_position_handles_scaled_and_offset_monitors() {
        // Regression for the reported bug: physical 2560x1440 at 150% scaling
        // is 1706.67x960 logical; window APIs take logical pixels.
        let primary = (0.0, 0.0, 2560.0 / 1.5, 1440.0 / 1.5);
        let (x, y) = popup_position(primary, POPUP_SIZE);
        let expect_x = (2560.0 / 1.5 - POPUP_SIZE.0) / 2.0;
        let expect_y = (1440.0 / 1.5 - 48.0 - POPUP_SIZE.1) / 2.0;
        assert!((x - expect_x).abs() < 0.01, "x {x} != {expect_x}");
        assert!((y - expect_y).abs() < 0.01, "y {y} != {expect_y}");
        // Portrait second monitor at negative offsets.
        let portrait = (-1728.0 / 1.5, -768.0 / 1.5, 1728.0 / 1.5, 3072.0 / 1.5);
        let (x, y) = popup_position(portrait, POPUP_SIZE);
        assert!((x - (-1152.0 + (1152.0 - POPUP_SIZE.0) / 2.0)).abs() < 0.01);
        assert!((y - (-512.0 + (2048.0 - 48.0 - POPUP_SIZE.1) / 2.0)).abs() < 0.01);
    }

    #[test]
    fn parse_hhmm_works() {
        assert_eq!(parse_hhmm("09:00"), Some((9, 0)));
        assert_eq!(parse_hhmm(" 22:30 "), Some((22, 30)));
        assert_eq!(parse_hhmm("bad"), None);
        assert_eq!(parse_hhmm("9:"), None);
    }
}
