import { useEffect, useState } from "react";
import { api, type ActivityStatus, errText } from "../lib/api";

interface ActivityRule {
  kind: "exe" | "title";
  pattern: string;
  category: "entertainment" | "study";
}

/** 屏幕监控的默认规则：用户可增删（标题匹配只读浏览器窗口标题——注意浏览器
 *  标题显示的是站点名「抖音」而不是域名，所以中文名才是关键匹配串）。 */
const DEFAULT_RULES: ActivityRule[] = [
  { kind: "title", pattern: "抖音", category: "entertainment" },
  { kind: "title", pattern: "douyin", category: "entertainment" },
  { kind: "title", pattern: "bilibili", category: "entertainment" },
  { kind: "title", pattern: "哔哩哔哩", category: "entertainment" },
  { kind: "exe", pattern: "weixin.exe", category: "entertainment" },
  { kind: "exe", pattern: "qq.exe", category: "entertainment" },
  { kind: "exe", pattern: "code.exe", category: "study" },
  { kind: "exe", pattern: "cursor.exe", category: "study" },
  { kind: "exe", pattern: "idea64.exe", category: "study" },
  { kind: "exe", pattern: "pycharm64.exe", category: "study" },
];

const FIELDS: {
  key: string;
  label: string;
  hint?: string;
  /** 有 options 就渲染下拉框；第一项同时是"未设置"时的显示值。 */
  options?: { value: string; label: string }[];
  /** 输入框的默认值（仅用于占位展示，真实默认在后端）。 */
  def?: string;
}[] = [
  {
    key: "popup_interval_min",
    label: "弹窗间隔（分钟）",
    hint: "默认 20；两次弹窗之间的最小间隔，手动「立即复习」不受限",
  },
  { key: "per_popup", label: "每次弹窗卡片数", hint: "1~5" },
  { key: "study_start", label: "学习时段开始", hint: "HH:MM" },
  { key: "study_end", label: "学习时段结束", hint: "HH:MM" },
  {
    key: "gap_unknown",
    label: "「不了解」隔几张卡",
    hint: "默认 3：中间先过 3 张其他卡再回来",
  },
  {
    key: "gap_familiar",
    label: "「熟悉」至少隔几张卡",
    hint: "默认 8（等级基础距离更大的话以等级为准）",
  },
  {
    key: "gap_speakable",
    label: "「可以讲出来」至少隔几张卡",
    hint: "默认 20",
  },
  {
    key: "level_gaps",
    label: "等级基础距离（0~5 级）",
    hint: "逗号分隔 6 个数，默认 3,5,10,20,50,100",
  },
  {
    key: "attention_threshold",
    label: "连续「不了解」标记阈值",
    hint: "默认 3：达到后标记 ⚠ 重点卡",
  },
  {
    key: "attention_gap",
    label: "重点卡回访距离（张）",
    hint: "默认 5；每次弹窗最多 1 张重点卡",
  },
  {
    key: "max_unknown_gap",
    label: "连续不了解的最大距离（张）",
    hint: "默认 10：第 4 次起不再无限加密",
  },
  {
    key: "floor_unknown_min",
    label: "「不了解」最短时间保护（分钟）",
    hint: "默认 10；0 = 不限制",
  },
  {
    key: "floor_familiar_min",
    label: "「熟悉」最短时间保护（分钟）",
    hint: "默认 30",
  },
  {
    key: "floor_speakable_min",
    label: "「可以讲出来」最短时间保护（分钟）",
    hint: "默认 120",
  },
  { key: "daily_new_limit", label: "每日新卡上限", hint: "默认 15" },
  { key: "session_new_limit", label: "每次弹窗新卡上限", hint: "默认 1" },
  { key: "skip_delay_min", label: "跳过重入队延迟（分钟）", hint: "10 ~ 120" },
  {
    key: "fullscreen_dnd",
    label: "全屏免打扰",
    hint: "检测到全屏应用（游戏/视频/演示）时，自动弹窗改为轻提醒；手动「立即复习」不受影响",
    options: [
      { value: "1", label: "开启（默认）" },
      { value: "0", label: "关闭" },
    ],
  },
  {
    key: "daily_popup_limit",
    label: "每日弹窗上限",
    hint: "默认 40；0 = 不限。超过后当天只保留轻提醒（系统通知）",
  },
  {
    key: "autostart",
    label: "开机自启",
    hint: "开机自动驻留托盘（系统启动项，改动即时生效）",
    options: [
      { value: "1", label: "开启" },
      { value: "0", label: "关闭" },
    ],
  },
  {
    key: "notify_mode",
    label: "提醒方式",
    options: [
      { value: "popup", label: "强制弹窗" },
      { value: "notify", label: "仅轻提醒" },
      { value: "combo", label: "先轻提醒，未处理再弹窗" },
    ],
  },
  {
    key: "combo_escalate_min",
    label: "升级弹窗等待（分钟）",
    hint: "「先轻提醒」模式下，轻提醒后这么多分钟仍未复习就升级为弹窗；默认 5",
  },
  {
    key: "popup_idle_escape_min",
    label: "离手逃离判定（分钟）",
    hint: "默认 5；弹窗开着但这么久没人碰、鼠标也不在弹窗上，就把弹窗拉回光标所在屏幕并记一次逃避。0 = 关闭",
    def: "5",
  },
  {
    key: "close_policy",
    label: "关闭策略",
    hint: "「不允许关闭」会藏掉弹窗的所有退出入口，复习完这批卡才放行——不想让自己逃的时候上锁",
    options: [
      { value: "normal", label: "允许关闭（默认）" },
      { value: "strict", label: "不允许关闭" },
    ],
  },
  {
    key: "no_close_first_n",
    label: "会话前 N 张禁止关闭",
    hint: "开启后本次弹窗的前 N 张不显示 ✕（Esc「结束本次」同样禁用），先把开头做完再给自己留出口。0 = 不限制",
    options: [
      { value: "0", label: "不限制（默认）" },
      { value: "1", label: "前 1 张" },
      { value: "2", label: "前 2 张" },
      { value: "3", label: "前 3 张" },
      { value: "5", label: "前 5 张" },
    ],
  },
  {
    key: "debug_breadcrumbs",
    label: "诊断面包屑",
    hint: "排障用：把每个关键步骤写进日志，供开发者定位卡死。平时保持关闭，日志才干净；遇到异常再打开复现一次",
  },
];

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "弹窗与学习时段", keys: ["autostart", "popup_interval_min", "per_popup", "study_start", "study_end", "notify_mode", "daily_popup_limit", "popup_idle_escape_min", "close_policy", "no_close_first_n", "fullscreen_dnd", "combo_escalate_min"] },
  { title: "间隔调度（隔 N 张）", keys: ["gap_unknown", "gap_familiar", "gap_speakable", "level_gaps"] },
  { title: "重点卡与时间保护", keys: ["attention_threshold", "attention_gap", "max_unknown_gap", "floor_unknown_min", "floor_familiar_min", "floor_speakable_min"] },
  { title: "每日上限与 AI", keys: ["daily_new_limit", "session_new_limit", "skip_delay_min"] },
  { title: "诊断", keys: ["debug_breadcrumbs"] },
];

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const [rules, setRules] = useState<ActivityRule[]>(DEFAULT_RULES);
  const [live, setLive] = useState<ActivityStatus | null>(null);
  // 开机自启是系统级开关：读真实状态展示，改动即时生效（不等「保存设置」）。
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartMsg, setAutostartMsg] = useState("");

  useEffect(() => {
    api
      .getAutostart()
      .then(setAutostartOn)
      .catch(() => {});
  }, []);

  async function toggleAutostart(on: boolean) {
    setAutostartMsg("");
    try {
      const now = await api.setAutostart(on);
      setAutostartOn(now);
      setAutostartMsg(now ? "已开启：下次开机自动驻留托盘" : "已关闭");
    } catch (e) {
      setAutostartMsg(errText(e));
    }
  }

  // 实时捕捉：设置页打开时每 2 秒拉一次监控的上次采样（纯内存，不落库）。
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      api
        .activityStatus()
        .then((s) => {
          if (!cancelled) setLive(s);
        })
        .catch(() => {});
    void tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function backupNow() {
    setBackupMsg("");
    try {
      const path = await api.backupNow();
      setBackupMsg(`已备份：${path}`);
    } catch (e) {
      setBackupMsg(errText(e));
    }
  }

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setValues(s);
        // 已保存过的规则优先；否则用默认清单（抖音/B站/微信/QQ）。
        if (s.activity_rules) {
          try {
            const parsed = JSON.parse(s.activity_rules) as ActivityRule[];
            if (Array.isArray(parsed) && parsed.length > 0) setRules(parsed);
          } catch {
            /* keep defaults */
          }
        }
      })
      .catch(() => {});
  }, []);

  async function save() {
    setMsg("");
    try {
      // 屏幕监控规则随设置一起保存（JSON 串进 KV）。
      await api.setSettings({
        ...values,
        activity_rules: JSON.stringify(rules.filter((r) => r.pattern.trim())),
      });
      setMsg("已保存");
    } catch (e) {
      setMsg(errText(e));
    }
  }

  function addRule() {
    setRules([...rules, { kind: "title", pattern: "", category: "entertainment" }]);
  }

  function updateRule(i: number, patch: Partial<ActivityRule>) {
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function removeRule(i: number) {
    setRules(rules.filter((_, j) => j !== i));
  }

  return (
    <section className="page settings-page">
      <div className="settings-heading">
        <div>
          <h1>设置</h1>
          <p className="muted">所有数据仅保存在本机 · 零联网</p>
        </div>
        <div className="settings-save-wrap">
          <button className="btn primary" onClick={() => void save()}>保存设置</button>
          {msg && <span className="ok small">{msg}</span>}
        </div>
      </div>

      <div className="settings-grid">
        {GROUPS.map((group) => (
          <section className="settings-card" key={group.title}>
            <h2>{group.title}</h2>
            {group.keys.map((key) => {
              const f = FIELDS.find((field) => field.key === key);
              if (!f) return null;
              return (
                <div className="settings-row" key={f.key}>
                  <div className="settings-label">
                    <label title={f.hint}>{f.label}</label>
                    {f.hint && <span className="muted small">{f.hint}</span>}
                  </div>
                  {f.key === "autostart" ? (
                    <div className="autostart-cell">
                      <select
                        value={autostartOn ? "1" : "0"}
                        onChange={(e) => void toggleAutostart(e.target.value === "1")}
                      >
                        <option value="1">开启</option>
                        <option value="0">关闭</option>
                      </select>
                      {autostartMsg && <span className="ok small">{autostartMsg}</span>}
                    </div>
                  ) : f.options ? (
                    <select
                      value={values[f.key] ?? f.options[0].value}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    >
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={values[f.key] ?? ""}
                      placeholder={f.def ? `默认 ${f.def}` : "默认"}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <section className="backup-card">
        <div>
          <h2>数据备份</h2>
          <p className="muted small">每日首次启动自动备份，保留最近 7 份 · %APPDATA%\FlashMemo\backups</p>
        </div>
        <div className="backup-action">
          <button className="btn" onClick={() => void backupNow()}>立即备份</button>
          {backupMsg && <span className="ok small">{backupMsg}</span>}
        </div>
      </section>

      <section className="settings-card activity-card">
        <h2>屏幕监控（娱乐加速）</h2>
        <div className="settings-row">
          <div className="settings-label">
            <label>监控开关</label>
            <span className="muted small">
              娱乐清单上持续 1 分钟 → 弹窗间隔减半（不低于 3 分钟）；学习清单上 → 间隔翻倍，
              并等你切走应用时再弹（最多延后 15 分钟）
            </span>
          </div>
          <select
            value={values.activity_enabled ?? "0"}
            onChange={(e) => setValues({ ...values, activity_enabled: e.target.value })}
          >
            <option value="0">关闭</option>
            <option value="1">开启</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <label>最短持续时长（秒）</label>
            <span className="muted small">默认 60；防止瞄一眼就触发</span>
          </div>
          <input
            value={values.activity_dwell_secs ?? ""}
            placeholder="60"
            onChange={(e) => setValues({ ...values, activity_dwell_secs: e.target.value })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <label>调试：娱乐几秒后立即弹窗</label>
            <span className="muted small">
              0 = 关闭（正常运行）；设为 10 表示检测到娱乐界面持续 10 秒就立刻弹一次，
              无视弹窗间隔，用于验证监控是否生效 —— 测完请设回 0
            </span>
          </div>
          <input
            value={values.activity_test_secs ?? ""}
            placeholder="0"
            onChange={(e) => setValues({ ...values, activity_test_secs: e.target.value })}
          />
        </div>
        <div className="activity-rules">
          <div className="activity-rules-head">
            <span className="muted small">
              娱乐清单：进程名（如 weixin.exe）或浏览器窗口标题片段（如 bilibili）。
              标题只在内存中匹配，不记录、不联网。
            </span>
            <button className="btn small-btn" onClick={addRule}>
              ＋ 添加规则
            </button>
          </div>
          {rules.map((rule, i) => (
            <div className="activity-rule-row" key={i}>
              <select
                value={rule.kind}
                onChange={(e) => updateRule(i, { kind: e.target.value as ActivityRule["kind"] })}
              >
                <option value="exe">进程名</option>
                <option value="title">窗口标题</option>
              </select>
              <input
                value={rule.pattern}
                placeholder={rule.kind === "exe" ? "weixin.exe" : "bilibili"}
                onChange={(e) => updateRule(i, { pattern: e.target.value })}
              />
              <select
                value={rule.category}
                onChange={(e) =>
                  updateRule(i, { category: e.target.value as ActivityRule["category"] })
                }
              >
                <option value="entertainment">娱乐（加速弹窗）</option>
                <option value="study">学习（间隔翻倍、延后弹窗）</option>
              </select>
              <button className="btn small-btn" onClick={() => removeRule(i)} title="删除规则">
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* 实时捕捉：把监控上一次采样看到的东西显示出来，方便调规则。 */}
        <div className="activity-live">
          <span className="activity-live-dot" data-category={live?.category ?? "neutral"} />
          <span className="activity-live-text">
            {!live
              ? "读取监控状态…"
              : !live.enabled
                ? "监控已关闭——打开上方开关后，这里会显示实时捕捉的内容"
                : live.idle
                  ? "空闲中（超过 5 分钟无操作，按中性处理）"
                  : live.process === ""
                    ? "等待下一次采样…（每 3 秒一次）"
                    : (() => {
                        const cat =
                          live.category === "entertainment"
                            ? "娱乐"
                            : live.category === "study"
                              ? "学习"
                              : "中性";
                        const ruleText =
                          live.category === "neutral"
                            ? live.matched
                              ? `（命中规则「${live.matched}」）`
                              : "（未命中任何规则，可在上方加一条）"
                            : `（命中规则「${live.matched}」）`;
                        return (
                          <>
                            捕捉到：<b>{live.process}</b>
                            {live.title ? <> · 标题「{live.title}」</> : <> · 非浏览器（不读标题）</>}
                            　→　<b>{cat}</b>
                            {ruleText}
                            {live.category === "entertainment" && (
                              <> · 已持续 {live.continuousSecs} 秒</>
                            )}
                          </>
                        );
                      })()}
          </span>
        </div>
      </section>
    </section>
  );
}
