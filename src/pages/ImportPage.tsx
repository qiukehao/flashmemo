import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TabKey } from "../lib/tabs";
import { isTauri } from "../lib/env";
import {
  api,
  errText,
  type DeckOverview,
  type ImportFile,
  type ImportPreview,
  type ImportReport,
} from "../lib/api";
import { pasteImportFile, summarizePaste } from "../lib/pasteImport";

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

const NEW = "__new__";

export default function ImportPage({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: (tab: TabKey) => void;
}) {
  /** SPEC §5.3「导入」这一页有两个入口：选文件、或者直接粘贴文本（§5.5）。 */
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [preferFile, setPreferFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 粘贴模式：卡包列表、选中的卡包、以及要贴的那段文本。
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [pasteDeck, setPasteDeck] = useState("");
  const [pasteNewDeck, setPasteNewDeck] = useState("");
  const [pasteText, setPasteText] = useState("");

  useEffect(() => {
    api
      .listOverview()
      .then((o) => {
        setOverview(o);
        // 一个卡包都没有时直接落到「新建卡包」，否则下拉是空的、无从下手。
        setPasteDeck((sel) => sel || (o.length > 0 ? o[0].name : NEW));
      })
      .catch(() => {});
  }, []);

  const pasteDeckName = pasteDeck === NEW ? pasteNewDeck.trim() : pasteDeck;
  // 预览完全用本地解析器算（与后端同一套 §5.2 规则），粘贴即刷新，不用等往返。
  const summary = useMemo(
    () => summarizePaste(pasteText, pasteDeckName),
    [pasteText, pasteDeckName],
  );

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
      setError(errText(e));
    }
  }

  async function choose(fileList: FileList | null) {
    await chooseBrowser(fileList);
  }

  /** 共用的收尾：一次导入只写一次报告。 */
  async function runImport(batch: ImportFile[]) {
    setBusy(true);
    setError("");
    try {
      setReport(await api.importMarkdown(batch, preferFile));
      setPreview(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    await runImport(files);
    setFiles([]);
  }

  async function confirmPaste() {
    if (!pasteDeckName) {
      setError("请填写卡包名");
      return;
    }
    if (summary.cards === 0) {
      setError(summary.notice ?? "还没有解析出卡片");
      return;
    }
    await runImport([pasteImportFile(pasteText, pasteDeckName)]);
    setPasteText("");
  }

  return (
    <section className="page">
      <button className="page-back btn" onClick={onBack}>
        ← 返回首页
      </button>
      <h1>导入</h1>
      <div className="shell-tabs">
        <button
          className={`shell-tab ${mode === "file" ? "active" : ""}`}
          onClick={() => {
            setMode("file");
            setError("");
          }}
        >
          选择文件
        </button>
        <button
          className={`shell-tab ${mode === "paste" ? "active" : ""}`}
          onClick={() => {
            setMode("paste");
            setError("");
          }}
        >
          粘贴文本
        </button>
      </div>

      {mode === "file" ? (
        <>
          <p className="muted">
            规则：`#` 卡包 · `##` 章节 · `###` 卡片问题，其后内容为答案（SPEC §5）。
            <br />
            文档里引用的本地图片会被复制到 FlashMemo 附件目录，卡面用 `attachment:` 引用（SPEC §5.4）。
          </p>
          <div className="form-row">
            <button
              className="btn primary"
              onClick={() =>
                void (isTauri() ? chooseNative() : inputRef.current?.click())
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
              <ConflictOption checked={preferFile} onChange={setPreferFile} />
              <div>
                <button className="btn primary" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "导入中…" : "确认导入"}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            把复制来的一大段文本直接贴进来，一次导入多张卡——规则和文件导入完全一样：
            `#` 卡包 · `##` 章节 · `###` 卡片问题（SPEC §5.5）。
            <br />
            文本里没有 `#` 时，整段会落进下面选的卡包；粘贴带不了图片（没有文件路径），
            图请导入后再用卡片编辑页的「🖼 图片」补上。
          </p>
          <div className="form-row">
            <label>卡包</label>
            <select value={pasteDeck} onChange={(e) => setPasteDeck(e.target.value)}>
              {overview.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
              <option value={NEW}>➕ 新卡包…</option>
            </select>
            {pasteDeck === NEW && (
              <input
                placeholder="新卡包名"
                value={pasteNewDeck}
                onChange={(e) => setPasteNewDeck(e.target.value)}
              />
            )}
          </div>
          <div className="form-row top">
            <label>粘贴文本</label>
            <textarea
              className="paste-input"
              rows={12}
              placeholder={
                "## 事务\n\n### ACID 是什么？\n- **原子性**：不可分割\n\n### 隔离级别有哪些？\n1. 读未提交\n"
              }
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
          </div>
          <div className="card-block">
            <h2>解析预览</h2>
            {pasteText.trim() === "" ? (
              <p className="muted">粘贴文本后这里会显示解析出的章节与卡片。</p>
            ) : (
              <>
                <p>
                  {summary.chapters} 个章节 · {summary.cards} 张卡
                  {summary.deckNames.length > 0 && ` · 卡包：${summary.deckNames.join("、")}`}
                </p>
                {summary.samples.length > 0 && (
                  <ol className="muted small paste-samples">
                    {summary.samples.map((s, i) => (
                      <li key={`${i}-${s}`}>{s}</li>
                    ))}
                  </ol>
                )}
                {summary.cards > summary.samples.length && (
                  <p className="muted small">
                    还有 {summary.cards - summary.samples.length} 张，导入后在卡包页查看。
                  </p>
                )}
                {summary.notice && (
                  <p className={summary.cards === 0 ? "error" : "muted small"}>
                    {summary.notice}
                  </p>
                )}
              </>
            )}
            <ConflictOption checked={preferFile} onChange={setPreferFile} />
            <div>
              <button
                className="btn primary"
                disabled={busy || !pasteDeckName || summary.cards === 0}
                onClick={() => void confirmPaste()}
              >
                {busy ? "导入中…" : `导入 ${summary.cards} 张卡`}
              </button>
              {pasteText !== "" && (
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => {
                    setPasteText("");
                    setError("");
                  }}
                >
                  清空
                </button>
              )}
            </div>
          </div>
        </>
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

/** 两种模式的导入共用同一个取舍：「冲突时以文件为准」还是保留本地编辑（§5.3）。 */
function ConflictOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      冲突时以文件为准（覆盖本地批注）
    </label>
  );
}
