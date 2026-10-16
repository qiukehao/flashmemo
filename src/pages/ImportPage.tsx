import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TabKey } from "../lib/tabs";
import { isTauri } from "../lib/env";
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

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }];

export default function ImportPage({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: (tab: TabKey) => void;
}) {
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [preferFile, setPreferFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** SPEC §5.3: the native picker hands us paths, so the import can also copy
   *  the images the note references (SPEC §5.4). */
  async function chooseNative() {
    setError("");
    const picked = await open({ multiple: true, directory: false, filters: MD_FILTERS });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    await load(() => api.readMarkdownFiles(paths));
  }

  /** Browser debug mode: no filesystem, so read the picked files in JS. */
  async function chooseBrowser(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const md = Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith(".md") || f.name.toLowerCase().endsWith(".markdown"),
    );
    if (md.length === 0) {
      setError("请选择 .md 文件");
      return;
    }
    await load(() => Promise.all(md.map(readText)));
  }

  async function load(read: () => Promise<ImportFile[]>) {
    setError("");
    setReport(null);
    setPreview(null);
    try {
      const parsed = await read();
      setFiles(parsed);
      setPreview(await api.previewImport(parsed));
    } catch (e) {
      setError(String(e));
    }
  }

  async function choose(fileList: FileList | null) {
    await chooseBrowser(fileList);
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
      <button className="page-back btn" onClick={onBack}>
        ← 返回首页
      </button>
      <h1>导入</h1>
      <p className="muted">
        规则：`#` 卡包 · `##` 章节 · `###` 卡片问题，其后内容为答案（SPEC §5）。
        <br />
        文档里引用的本地图片会被复制到 FlashMemo 附件目录，卡面用 `attachment:` 引用（SPEC §5.4）。
      </p>
      <div className="form-row">
        <button
          className="btn primary"
          onClick={() =>
            void (isTauri()
              ? chooseNative()
              : inputRef.current?.click())
          }
        >
          选择 Markdown 文件…
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".md,.markdown,text/markdown"
          onChange={(e) => void choose(e.target.files)}
        />
      </div>
      {preview && (
        <div className="card-block">
          <h2>解析预览</h2>
          <p>
            {preview.decks} 个卡包 · {preview.chapters} 个章节 · {preview.cards} 张卡
            {preview.conflicts > 0 && ` · ${preview.conflicts} 张本地编辑冲突`}
          </p>
          {preview.deckNames.length > 0 && (
            <p className="muted small">将创建卡包：{preview.deckNames.join("、")}</p>
          )}
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
