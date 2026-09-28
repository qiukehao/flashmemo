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
