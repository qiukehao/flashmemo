import { useEffect, useState } from "react";
import { api } from "../lib/api";

const FIELDS: { key: string; label: string; hint?: string; options?: string[] }[] = [
  {
    key: "popup_interval_min",
    label: "弹窗间隔（分钟）",
    hint: "两次弹窗之间的最小间隔；手动「立即复习」不受限",
  },
  { key: "per_popup", label: "每次弹窗卡片数", hint: "1~5" },
  { key: "study_start", label: "学习时段开始", hint: "HH:MM" },
  { key: "study_end", label: "学习时段结束", hint: "HH:MM" },
  {
    key: "min_interval_min",
    label: "最短复习间隔（分钟）",
    hint: "评「不了解」后的间隔，默认 120；不低于 30",
  },
  {
    key: "max_interval_days",
    label: "最长复习间隔（天）",
    hint: "默认 60；重点面试卡包可调小",
  },
  {
    key: "familiar_cap_days",
    label: "「熟悉」间隔上限（天）",
    hint: "默认 7；一直只能评「熟悉」的卡不会无限拉长",
  },
  { key: "familiar_mult", label: "「熟悉」增长倍率", hint: "默认 1.5" },
  { key: "speak_mult", label: "「可以讲出来」增长倍率", hint: "默认 2.5" },
  {
    key: "attention_threshold",
    label: "连续「不了解」提示阈值",
    hint: "默认 3；达到后标记「需专项理解」并放缓到每天一次",
  },
  {
    key: "max_daily_shows",
    label: "同一张卡每天最多出现次数",
    hint: "1 或 2，默认 2（滚动 24 小时）",
  },
  {
    key: "min_display_gap_min",
    label: "同一张卡最小展示间隔（分钟）",
    hint: "默认 120；跳过的卡也不会马上再出现",
  },
  { key: "daily_new_limit", label: "每日新卡上限", hint: "默认 5" },
  { key: "session_new_limit", label: "每次弹窗新卡上限", hint: "默认 1" },
  { key: "skip_delay_min", label: "跳过重入队延迟（分钟）", hint: "10 ~ 120" },
  {
    key: "notify_mode",
    label: "提醒方式",
    options: ["popup", "notify"],
  },
];

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api
      .getSettings()
      .then(setValues)
      .catch(() => {});
  }, []);

  async function save() {
    setMsg("");
    try {
      await api.setSettings(values);
      setMsg("已保存");
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <section className="page">
      <h1>设置</h1>
      {FIELDS.map((f) => (
        <div className="form-row" key={f.key}>
          <label title={f.hint}>{f.label}</label>
          {f.options ? (
            <select
              value={values[f.key] ?? "popup"}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            >
              <option value="popup">强制弹窗</option>
              <option value="notify">仅轻提醒（系统通知）</option>
            </select>
          ) : (
            <input
              value={values[f.key] ?? ""}
              placeholder={f.hint}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
          {f.hint && <span className="muted small">{f.hint}</span>}
        </div>
      ))}
      <div className="form-row">
        <button className="btn primary" onClick={() => void save()}>
          保存设置
        </button>
        {msg && <span className="ok">{msg}</span>}
      </div>
    </section>
  );
}
