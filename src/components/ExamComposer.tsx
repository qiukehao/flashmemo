import { useEffect, useState } from "react";
import { api, type DeckOverview, errText } from "../lib/api";

interface PartRow {
  deck: string;
  count: number;
}

// 组卷 (2026-10-04): 用户自由规划今天复习什么——从多个卡包各抽 N 张，
// 可选先并入今日到期卡；策略「最弱优先」把等级低/复习少的卡先排上。
export default function ExamComposer({ onClose }: { onClose: () => void }) {
  const [decks, setDecks] = useState<DeckOverview[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [includeDue, setIncludeDue] = useState(true);
  const [strategy, setStrategy] = useState<"weak" | "random">("weak");
  const [presets, setPresets] = useState<[number, string, string][]>([]);
  const [presetName, setPresetName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listOverview()
      .then((d) => {
        setDecks(d);
        if (d.length > 0) setParts([{ deck: d[0].name, count: 10 }]);
      })
      .catch(() => setMsg("卡包列表加载失败"));
    void loadPresets();
  }, []);

  function loadPresets() {
    return api
      .listExamPresets()
      .then(setPresets)
      .catch(() => {});
  }

  const total = parts.reduce((sum, p) => sum + Math.max(0, p.count), 0);

  async function start() {
    setMsg("");
    const rows = parts.filter((p) => p.count > 0 && p.deck);
    if (rows.length === 0) {
      setMsg("先选一个卡包并填入张数");
      return;
    }
    setBusy(true);
    try {
      await api.composeExam(rows, includeDue, strategy);
      onClose();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function savePreset() {
    setMsg("");
    const name = presetName.trim();
    if (!name) {
      setMsg("给预设起个名字再保存");
      return;
    }
    try {
      await api.saveExamPreset(
        name,
        JSON.stringify({ parts, includeDue, strategy }),
      );
      setPresetName("");
      await loadPresets();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  function applyPreset(configJson: string) {
    setMsg("");
    try {
      const cfg = JSON.parse(configJson) as {
        parts?: PartRow[];
        includeDue?: boolean;
        strategy?: "weak" | "random";
      };
      if (cfg.parts) setParts(cfg.parts);
      if (typeof cfg.includeDue === "boolean") setIncludeDue(cfg.includeDue);
      if (cfg.strategy) setStrategy(cfg.strategy);
    } catch {
      setMsg("预设内容已损坏");
    }
  }

  return (
    <div className="exam-overlay" onClick={onClose}>
      <div className="exam-modal" onClick={(e) => e.stopPropagation()}>
        <div className="exam-head">
          <span className="exam-title">组卷复习</span>
          <button className="btn small-btn" onClick={onClose}>
            取消
          </button>
        </div>

        <div className="exam-rows">
          {parts.map((row, i) => (
            <div className="exam-row" key={i}>
              <select
                value={row.deck}
                onChange={(e) =>
                  setParts(parts.map((p, j) => (j === i ? { ...p, deck: e.target.value } : p)))
                }
              >
                {decks.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}（{d.cardCount} 张）
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                value={row.count || ""}
                placeholder="张数"
                onChange={(e) =>
                  setParts(
                    parts.map((p, j) =>
                      j === i ? { ...p, count: Number.parseInt(e.target.value, 10) || 0 } : p,
                    ),
                  )
                }
              />
              <button
                className="btn small-btn"
                onClick={() => setParts(parts.filter((_, j) => j !== i))}
                title="移除这一行"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn small-btn"
            onClick={() =>
              setParts([...parts, { deck: decks[0]?.name ?? "", count: 10 }])
            }
            disabled={decks.length === 0}
          >
            ＋ 加一个卡包
          </button>
        </div>

        <div className="exam-options">
          <label>
            <input
              type="checkbox"
              checked={includeDue}
              onChange={(e) => setIncludeDue(e.target.checked)}
            />
            先并入今日到期卡
          </label>
          <label>
            抽卡策略
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as "weak" | "random")}
            >
              <option value="weak">最弱优先（等级低先来）</option>
              <option value="random">随机</option>
            </select>
          </label>
        </div>

        <div className="exam-total muted">
          本次共 {total} 张{includeDue ? " + 今日到期卡" : ""}，按每次弹窗张数分批出卡
        </div>

        <div className="exam-presets">
          <input
            value={presetName}
            placeholder="预设名称"
            onChange={(e) => setPresetName(e.target.value)}
          />
          <button className="btn small-btn" onClick={() => void savePreset()}>
            保存为预设
          </button>
        </div>
        {presets.length > 0 && (
          <div className="exam-preset-list">
            {presets.map(([id, name, cfg]) => (
              <span className="exam-preset-chip" key={id}>
                <button className="exam-preset-load" onClick={() => applyPreset(cfg)}>
                  {name}
                </button>
                <button
                  className="exam-preset-del"
                  title="删除预设"
                  onClick={() =>
                    void api.deleteExamPreset(id).then(() => loadPresets()).catch(() => {})
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {msg && (
          <p className="error small" role="alert">
            {msg}
          </p>
        )}

        <div className="exam-actions">
          <button className="btn primary" onClick={() => void start()} disabled={busy}>
            {busy ? "组卷中…" : "开始复习"}
          </button>
        </div>
      </div>
    </div>
  );
}
