import { useState } from "react";
import {
  api,
  type ImportFile,
  type ImportPreview,
  type ImportReport,
} from "../lib/api";

function readText(file: File): Promise<ImportFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ name: file.name, content: String(reader.result ?? "") });
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

export default function ImportPage({
  onDone,
}: {
  onDone: (tab: "home" | "import" | "add" | "settings") => void;
}) {
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [preferFile, setPreferFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose(fileList: FileList | null) {
    setError("");
    setReport(null);
    setPreview(null);
    const md = Array.from(fileList ?? []).filter(
      (f) => f.name.toLowerCase().endsWith(".md") || f.name.toLowerCase().endsWith(".markdown"),
    );
    if (md.length === 0) {
      setError("请选择 .md 文件");
      return;
    }
    try {
      const parsed = await Promise.all(md.map(readText));
      setFiles(parsed);
      setPreview(await api.previewImport(parsed));
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setReport(await api.importMarkdown(files, preferFile));
      setFiles([]);
      setPreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <h1>导入</h1>
      <p className="muted">
        规则：`#` 卡包 · `##` 章节 · `###` 卡片问题，其后内容为答案（SPEC §5）。
      </p>
      <input
        type="file"
        multiple
        accept=".md,.markdown,text/markdown"
        onChange={(e) => void choose(e.target.files)}
      />
      {preview && (
        <div className="card-block">
          <h2>解析预览</h2>
          <p>
            {preview.decks} 个卡包 · {preview.chapters} 个章节 · {preview.cards} 张卡
            {preview.conflicts > 0 && ` · ${preview.conflicts} 张本地编辑冲突`}
          </p>
          <label className="muted">
            <input
              type="checkbox"
              checked={preferFile}
              onChange={(e) => setPreferFile(e.target.checked)}
            />
            冲突时以文件为准（覆盖本地批注）
          </label>
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? "导入中…" : "确认导入"}
            </button>
          </div>
        </div>
      )}
      {report && (
        <div className="card-block">
          <h2>导入完成</h2>
          <p>
            新增 {report.added} · 更新 {report.updated} · 冲突保留 {report.conflicts} ·
            源中删除保留 {report.keptMissing}
          </p>
          <button className="btn" onClick={() => onDone("home")}>
            回到首页
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
