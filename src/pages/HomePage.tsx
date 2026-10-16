import { useCallback, useEffect, useState } from "react";
import { api, EMPTY_STATS, type GoalMode, type GoalStatus, type Stats } from "../lib/api";
import { triggerReviewNow } from "../lib/env";
import { goalBudgetText, goalCadenceText } from "../lib/goalCadence";
import { logFrontend } from "../lib/logger";
import type { TabKey } from "../lib/tabs";

const EMPTY_GOAL: GoalStatus = {
  enabled: false,
  mode: "review",
  target: 0,
  done: 0,
  reviewedToday: 0,
  spokenToday: 0,
  masteredToday: 0,
  dueCount: 0,
  perPopup: 1,
  start: "19:00",
  end: "22:00",
  met: false,
  speakRate: 0.4,
  budget: null,
  budgetLeft: null,
  poolLeft: 0,
  intervalMin: null,
  plannedIntervalMin: null,
  reason: "off",
  beforeWindow: false,
};

/** 目标条的节奏会随时间流逝而变（剩余时间 ÷ 还需轮数），即使不评分也要
 *  跟着走——15 秒和引擎同一个 tick 粒度，轮询开销可忽略。 */
const GOAL_POLL_MS = 15_000;

export default function HomePage({
  onNavigate,
  onOpenCards,
  onComposeExam,
}: {
  onNavigate: (tab: TabKey) => void;
  onOpenCards: (filter: string) => void;
  onComposeExam: () => void;
}) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [goal, setGoal] = useState<GoalStatus>(EMPTY_GOAL);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState({ target: 0, start: "19:00", end: "22:00" });
  const [goalMsg, setGoalMsg] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    // The main WebView can render a few milliseconds before Tauri setup has
    // finished managing the database state. Retry instead of leaving the
    // homepage counters stuck on the loading ellipsis forever.
    for (const delay of [0, 150, 400, 800, 1500]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        setStats(await api.getStats());
        return;
      } catch {
        // Try again after the backend has had time to finish setup.
      }
    }
  }, []);

  /** `syncDraft` 只在初次加载与保存后为 true：轮询刷新时如果用户正开着目标
   *  编辑器，回填草稿会把他正在输入的时段/张数冲掉。 */
  const loadGoal = useCallback(async (syncDraft: boolean) => {
    for (const delay of [0, 400, 1200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const g = await api.goalStatus();
        setGoal(g);
        if (syncDraft) setGoalDraft({ target: g.target, start: g.start, end: g.end });
        return;
      } catch {
        // Backend may still be starting up.
      }
    }
  }, []);

  useEffect(() => {
    void loadStats();
    void loadGoal(true);
  }, [loadStats, loadGoal]);

  useEffect(() => {
    // 「待复习」必须**同一个来源、同一个时刻**刷新（Bug1 / SPEC §14.1）：
    // - 复习弹窗是独立窗口：用户在弹窗里评分/跳过/关窗后回到主窗口时，这一页
    //   不会重新挂载，旧数字会一直留着 —— 用 focus / visibilitychange 立刻重取；
    // - 主窗口一直开着时用 15s 轮询兜底，而且**同一屏上的目标条与统计卡一起刷**，
    //   否则两者能各显示一个数字。
    // 只 setStats，不重挂载页面：不会冲掉用户正在输入的东西（重挂载会）。
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void loadStats();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadStats]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadGoal(false);
      void loadStats();
    }, GOAL_POLL_MS);
    return () => window.clearInterval(id);
  }, [loadGoal, loadStats]);

  /** 开始复习 used to swallow every failure silently — the user saw "nothing
   *  happened". Surface it, and let the log file carry the reason. */
  async function startReview() {
    setReviewError(null);
    try {
      await triggerReviewNow();
    } catch (e) {
      void logFrontend("error", `开始复习打开弹窗失败: ${String(e)}`);
      setReviewError("弹窗打开失败，请重试一次；若反复出现，请把日志一并发给开发者");
    }
    void loadStats();
  }

  /** 学新卡 opens a review session over the remaining daily new-card quota —
   *  it is a learning action, not a jump to the add-card form. */
  async function startNewCards() {
    setReviewError(null);
    try {
      await api.startNewReview();
    } catch (e) {
      void logFrontend("error", `学新卡打开失败: ${String(e)}`);
      setReviewError(String(e));
    }
    void loadStats();
  }

  /** Save the daily goal. The engine recomputes the popup interval on the
   *  next tick (set_settings wakes it) — 目标当天作废, never debt. */
  async function saveGoal() {
    setGoalMsg("");
    const target = Math.max(0, Math.round(goalDraft.target || 0));
    try {
      await api.setSettings({
        goal_enabled: target > 0 ? "1" : "0",
        goal_target: String(target),
        goal_start: goalDraft.start,
        goal_end: goalDraft.end,
      });
      setEditingGoal(false);
      await loadGoal(true);
    } catch (e) {
      setGoalMsg(String(e));
    }
  }

  /** 切换目标类型。轮询用的 `syncDraft=false`——用户可能正开着编辑器，
   *  切模式不该把他输入的时段/张数冲掉。 */
  async function setGoalMode(mode: GoalMode) {
    if (goal.mode === mode) return;
    setGoalMsg("");
    try {
      await api.setSettings({ goal_mode: mode });
      await loadGoal(false);
    } catch (e) {
      setGoalMsg(String(e));
    }
  }

  const goalProgress =
    goal.target > 0 ? Math.min(100, Math.round((goal.done / goal.target) * 100)) : 0;
  const goalCadence = goalCadenceText(goal);
  const goalBudget = goalBudgetText(goal);
  const goalDoneLabel = goal.met
    ? "🎉 今日目标已达成"
    : goal.mode === "speak"
      ? `今天讲出来 ${goal.done} 张`
      : `今天已经复习 ${goal.done} 张`;

  return (
    <section className="page home-page">
      <div className="home-hero">
        <div>
          <h1>下午好</h1>
          <p className="muted">今天有 {stats.dueCount} 张卡片待复习</p>
        </div>
        <div className="home-hero-actions">
          <button className="btn primary" onClick={() => void startReview()}>
            开始复习
          </button>
          <button className="btn" onClick={() => void startNewCards()}>
            学新卡
          </button>
          <button className="btn" onClick={onComposeExam}>
            组卷复习
          </button>
        </div>
        {reviewError && (
          <p className="error small" role="alert">
            {reviewError}
          </p>
        )}
      </div>

      <div className="goal-panel">
        <span className="goal-icon" aria-hidden="true">◎</span>
        <div className="goal-body">
          <div className="goal-head">
            <span className="goal-title">今日目标</span>
            <span className="goal-mode-switch" role="group" aria-label="目标类型">
              <button
                type="button"
                className={`goal-mode-btn ${goal.mode === "review" ? "active" : ""}`}
                aria-pressed={goal.mode === "review"}
                title="投入口径：今天评过几张（不了解/熟悉/可以讲出来都算，跳过不计）。适合「我就是想每天复习这么多」的目标"
                onClick={() => void setGoalMode("review")}
              >
                复习张数
              </button>
              <button
                type="button"
                className={`goal-mode-btn ${goal.mode === "speak" ? "active" : ""}`}
                aria-pressed={goal.mode === "speak"}
                title="产出口径：今天讲出来过几张（评了「可以讲出来」的卡，每张一天只算一次）。讲出来更能说明真记住了"
                onClick={() => void setGoalMode("speak")}
              >
                讲出张数
              </button>
            </span>
            {goal.enabled && !editingGoal && (
              <span className="goal-meta muted small">
                目标 {goal.target} 张 · {goal.start}–{goal.end}
              </span>
            )}
          </div>
          {editingGoal ? (
            <>
              <div className="goal-editor">
                <label>
                  {goal.mode === "speak" ? "今天想讲出（张）" : "今天想复习（张）"}
                  <input
                    type="number"
                    min={0}
                    value={goalDraft.target || ""}
                    placeholder="如 100"
                    onChange={(e) =>
                      setGoalDraft({ ...goalDraft, target: Number.parseInt(e.target.value, 10) || 0 })
                    }
                  />
                </label>
                <label>
                  开始
                  <input
                    type="time"
                    value={goalDraft.start}
                    onChange={(e) => setGoalDraft({ ...goalDraft, start: e.target.value })}
                  />
                </label>
                <label>
                  结束
                  <input
                    type="time"
                    value={goalDraft.end}
                    onChange={(e) => setGoalDraft({ ...goalDraft, end: e.target.value })}
                  />
                </label>
                {goalMsg && (
                  <span className="error small" role="alert">
                    {goalMsg}
                  </span>
                )}
              </div>
            </>
          ) : goal.enabled ? (
            <>
              <div className="goal-progress-row">
                <span className="goal-done">{goalDoneLabel}</span>
                <span className="muted small">{goal.done} / {goal.target}</span>
              </div>
              <div className="goal-bar">
                <div className="goal-bar-fill" style={{ width: `${goalProgress}%` }} />
              </div>
              {goalCadence && (
                <p className="goal-cadence muted small" title="节奏随剩余时间与进度自动调整">
                  <span aria-hidden="true">⏱</span> {goalCadence}
                </p>
              )}
              {goalBudget && <p className="goal-quiet muted small">{goalBudget}</p>}
              {(goal.mode === "review" || goal.masteredToday > 0) && goal.spokenToday > 0 && (
                <p className="goal-quiet muted small">
                  {goal.mode === "review" && `其中讲出来 ${goal.spokenToday} 张`}
                  {goal.mode === "review" && goal.masteredToday > 0 && " · "}
                  {goal.masteredToday > 0 && `${goal.masteredToday} 张达成掌握 🎉`}
                </p>
              )}
            </>
          ) : (
            <p className="muted small">
              设定一个今日目标——复习多少张，或<span className="goal-em">讲出来</span>多少张
              （讲出来更能说明真记住了）；弹窗节奏会在时段内自动排程，完不成也不欠账。
            </p>
          )}
        </div>
        <div className="goal-actions">
          {editingGoal ? (
            <>
              <button className="btn primary small-btn" onClick={() => void saveGoal()}>
                保存
              </button>
              <button className="btn small-btn" onClick={() => setEditingGoal(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className="btn small-btn"
              onClick={() => {
                setGoalMsg("");
                setEditingGoal(true);
              }}
            >
              {goal.enabled ? "修改" : "设定目标"}
            </button>
          )}
        </div>
      </div>

      <div className="stat-grid home-stat-grid">
        <div className="stat-card" role="button" tabIndex={0} onClick={() => onOpenCards("review")}>
          <div className="stat-num">{stats.todayReviewed}</div>
          <div className="stat-label">今日已复习</div>
        </div>
        <div className="stat-card" role="button" tabIndex={0} onClick={() => onOpenCards("due")}>
          <div className="stat-num">{stats.dueCount}</div>
          <div className="stat-label">待复习</div>
        </div>
        <div className="stat-card" role="button" tabIndex={0} onClick={() => onNavigate("dashboard")}>
          <div className="stat-num">{stats.streakDays}</div>
          <div className="stat-label">连续打卡（天）</div>
        </div>
        <div
          className={`stat-card ${stats.attentionCount > 0 ? "stat-warn" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onNavigate("leeches")}
          title="查看疑难卡片列表"
        >
          <div className="stat-num">{stats.attentionCount}</div>
          <div className="stat-label">⚠ 需专项理解</div>
        </div>
        <div className="stat-card" role="button" tabIndex={0} onClick={() => onOpenCards("archived")}>
          <div className="stat-num">{stats.archivedCount}</div>
          <div className="stat-label">已归档</div>
        </div>
      </div>

      <p className="home-footer muted small">到点自动弹窗复习 · 空闲时收进系统托盘，不打扰工作</p>
    </section>
  );
}
