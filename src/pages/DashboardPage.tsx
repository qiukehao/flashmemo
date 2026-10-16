import { useEffect, useState } from "react";
import { api, EMPTY_STATS, type Stats } from "../lib/api";
import { studyDayKey } from "../lib/studyDay";
import type { TabKey } from "../lib/tabs";

const LEVEL_NAMES = ["新卡", "刚接触", "能回忆", "基本熟练", "长期维护 50", "长期维护 100"];
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function dayLabel(anchor: Date, indexFromEnd: number): string {
  const d = new Date(anchor);
  d.setDate(anchor.getDate() - indexFromEnd);
  return WEEKDAY[d.getDay()];
}

export default function DashboardPage({
  onNavigate,
  onOpenCards,
}: {
  onNavigate: (tab: TabKey) => void;
  onOpenCards: (filter: string) => void;
}) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [heatmapRange, setHeatmapRange] = useState<"year" | "month">("year");

  useEffect(() => {
    const load = () => {
      api
        .getStats()
        .then(setStats)
        .catch(() => undefined);
    };
    load();
    // 与首页同一条来源、同一个刷新时机（SPEC §14.1）：复习弹窗关掉、回到主窗口时
    // 这一页不会重挂载，旧数字会一直留着。只刷新数据，不重挂载（保留用户状态）。
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const last7 = stats.last7Days;
  const weekMax = Math.max(1, ...last7);
  const levels = stats.levelDistribution;
  const levelMax = Math.max(1, ...levels);
  const heatmap = stats.reviewHeatmap;
  const heatmapByDate = new Map(heatmap.map((item) => [item.date, item.count]));
  // 后端按「学习日」（凌晨 4 点分界）分组；这里用当前学习日的**正午**当锚点，
  // 免得凌晨 0–4 点打开仪表盘时，日期整体被 4 小时偏移挪走一天。
  const today = new Date(`${studyDayKey()}T12:00:00`);

  // 年视图：53 列，以「今天所在周」收尾，每列周一→周日。
  const yearStart = new Date(today);
  yearStart.setDate(today.getDate() - ((today.getDay() + 6) % 7) - 52 * 7);
  const yearCells = Array.from({ length: 53 * 7 }, (_, index) => {
    const date = new Date(yearStart);
    date.setDate(yearStart.getDate() + index);
    const key = studyDayKey(date);
    return {
      key,
      date,
      outsideMonth: false,
      count: date > today ? 0 : heatmapByDate.get(key) ?? 0,
    };
  });

  // 月视图：铺满卡片宽度的日历，行=周（周一→周日），只保留本月跨到的那些周。
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const monthGridStart = new Date(monthStart);
  monthGridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
  const monthWeeks =
    Math.ceil((Math.round((monthEnd.getTime() - monthGridStart.getTime()) / 86400000) + 1) / 7);
  const monthCells = Array.from({ length: monthWeeks * 7 }, (_, index) => {
    const date = new Date(monthGridStart);
    date.setDate(monthGridStart.getDate() + index);
    const key = studyDayKey(date);
    const outsideMonth = date.getMonth() !== today.getMonth();
    return {
      key,
      date,
      outsideMonth,
      count: date > today || outsideMonth ? 0 : heatmapByDate.get(key) ?? 0,
    };
  });

  const yearMax = Math.max(1, ...yearCells.map((cell) => cell.count));
  const monthMax = Math.max(1, ...monthCells.map((cell) => cell.count));

  function heatClass(count: number, max: number): string {
    if (count === 0) return "heatmap-cell level-0";
    const level = Math.min(4, Math.ceil((count / max) * 4));
    return `heatmap-cell level-${level}`;
  }

  return (
    <section className="page dashboard-page">
      <div className="dashboard-heading">
        <div>
          <h1>仪表盘</h1>
          <p className="muted">查看最近的复习进度与卡片熟练度</p>
        </div>
        <button className="btn" onClick={() => onNavigate("home")}>
          返回首页
        </button>
      </div>

      <div className="home-analytics dashboard-analytics">
        <div className="chart-block">
          <div className="chart-title">最近 7 天复习量</div>
          <div className="week-chart">
            {last7.map((n, i) => (
              <div className="week-col" key={i} title={`${n} 张`}>
                <div className="week-count small">{n > 0 ? n : ""}</div>
                <div
                  className="week-bar"
                  style={{ height: `${Math.round((n / weekMax) * 100)}%` }}
                />
                <div className="week-label muted small">
                  {dayLabel(today, last7.length - 1 - i)}
                </div>
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
      </div>

      <div className="chart-block heatmap-block">
        <div className="heatmap-heading">
          <div className="chart-title">
            复习热力图 <span className="chart-subtitle">{heatmapRange === "year" ? "最近一年" : `${today.getFullYear()} 年 ${today.getMonth() + 1} 月`}</span>
          </div>
          <div className="heatmap-range-switch" role="group" aria-label="热力图范围">
            <button
              className={`btn small ${heatmapRange === "month" ? "active" : ""}`}
              onClick={() => setHeatmapRange("month")}
            >
              月视图
            </button>
            <button
              className={`btn small ${heatmapRange === "year" ? "active" : ""}`}
              onClick={() => setHeatmapRange("year")}
            >
              年视图
            </button>
          </div>
        </div>
        <div className="heatmap-wrap">
          {heatmapRange === "year" ? (
            <>
              <div className="heatmap-week-labels muted small">
                <span>一</span><span>三</span><span>五</span>
              </div>
              <div className="heatmap-grid year" aria-label="最近一年每日复习量">
                {yearCells.map((cell) => (
                  <span
                    key={cell.key}
                    className={heatClass(cell.count, yearMax)}
                    title={`${cell.key} · ${cell.count} 次复习`}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="heatmap-month">
              <div className="heatmap-month-weekdays muted small" aria-hidden="true">
                {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>
              <div className="heatmap-grid month" aria-label="本月每日复习量">
                {monthCells.map((cell) => (
                  <span
                    key={cell.key}
                    className={`${heatClass(cell.count, monthMax)} ${cell.outsideMonth ? "outside-month" : ""}`}
                    title={`${cell.key} · ${cell.count} 次复习`}
                  >
                    {cell.date.getDate()}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="heatmap-footer">
          <span className="muted small">少</span>
          <span className="heatmap-cell level-0" />
          <span className="heatmap-cell level-1" />
          <span className="heatmap-cell level-2" />
          <span className="heatmap-cell level-3" />
          <span className="heatmap-cell level-4" />
          <span className="muted small">多</span>
          <button className="btn small" onClick={() => onOpenCards("review")}>
            查看已复习卡片
          </button>
        </div>
      </div>
    </section>
  );
}
