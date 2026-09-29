import { useEffect, useState } from "react";
import { api, type Stats } from "../lib/api";
import { triggerReviewNow } from "../lib/env";
import type { TabKey } from "../lib/tabs";

const LEVEL_NAMES = ["新卡", "刚接触", "能回忆", "基本熟练", "长期维护 50", "长期维护 100"];
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function dayLabel(indexFromEnd: number): string {
  const d = new Date();
  d.setDate(d.getDate() - indexFromEnd);
  return WEEKDAY[d.getDay()];
}

export default function HomePage({
  onNavigate,
}: {
  onNavigate: (tab: TabKey) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api
      .getStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const last7 = stats?.last7Days ?? [];
  const weekMax = Math.max(1, ...last7);
  const levels = stats?.levelDistribution ?? [];
  const levelMax = Math.max(1, ...levels);

  return (
    <section className="page">
      <h1>闪记</h1>
      <p className="muted">把知识点做成闪卡，工作间隙定时弹出来背。</p>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-num">{stats?.todayReviewed ?? "…"}</div>
          <div className="stat-label">今日已复习</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{stats?.dueCount ?? "…"}</div>
          <div className="stat-label">待复习</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{stats?.streakDays ?? "…"}</div>
          <div className="stat-label">连续打卡（天）</div>
        </div>
        <div
          className={`stat-card ${(stats?.attentionCount ?? 0) > 0 ? "stat-warn" : ""}`}
          role="button"
          onClick={() => onNavigate("leeches")}
          title="查看疑难卡片列表"
        >
          <div className="stat-num">{stats?.attentionCount ?? "…"}</div>
          <div className="stat-label">⚠ 需专项理解</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{stats?.archivedCount ?? "…"}</div>
          <div className="stat-label">已归档</div>
        </div>
      </div>

      <div className="home-actions">
        <button className="btn primary" onClick={() => void triggerReviewNow()}>
          立即复习
        </button>
        <button className="btn" onClick={() => onNavigate("import")}>
          导入 Markdown 笔记
        </button>
        <button className="btn" onClick={() => onNavigate("add")}>
          手动添加卡片
        </button>
      </div>

      <div className="chart-block">
        <div className="chart-title">最近 7 天复习量</div>
        <div className="week-chart">
          {last7.map((n, i) => (
            <div className="week-col" key={i} title={`${n} 张`}>
              <div
                className="week-bar"
                style={{ height: `${Math.round((n / weekMax) * 100)}%` }}
              />
              <div className="week-label muted small">
                {dayLabel(last7.length - 1 - i)}
              </div>
              <div className="week-count muted small">{n > 0 ? n : ""}</div>
            </div>
          ))}
          {last7.length === 0 && <span className="muted small">暂无数据</span>}
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-title">熟练等级分布</div>
        {levels.map((n, i) => (
          <div className="level-row" key={i}>
            <span className="level-name muted small">{LEVEL_NAMES[i]}</span>
            <span className="level-bar-track">
              <span
                className={`level-bar level-bar-${i}`}
                style={{ width: `${Math.round((n / levelMax) * 100)}%` }}
              />
            </span>
            <span className="level-count small">{n}</span>
          </div>
        ))}
        {levels.length === 0 && <span className="muted small">暂无数据</span>}
      </div>

      <p className="muted small">
        到点会自动弹窗；空闲时窗口会收进系统托盘，不打扰工作。
      </p>
    </section>
  );
}
