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
  { key: "retention", label: "目标保留率", hint: "0.80 ~ 0.95" },
  {
    key: "steps_min",
    label: "学习步骤（分钟）",
    hint: "如 1,5,10；留空 = 无分钟级步骤，评分后直接按天/小时复习（间断记忆推荐）",
  },
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
