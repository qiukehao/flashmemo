import { useEffect, useRef, useState } from "react";
import type { TabKey } from "../lib/tabs";
import { api, type DeckOverview, errText } from "../lib/api";
import { insertPastedImageMarkdown, insertPickedImageMarkdown } from "../lib/imageInsert";
import { renderCard } from "../lib/markdown";

const NEW = "__new__";

/** 刷题模板（评审建议 §2.4）：背面按"思路 / 复杂度 / 易错点"预填，
 *  用户按 LeetCode 流程写答案，正面放题面或截图。 */
const DRILL_TEMPLATE = [
  "**思路**",
  "",
  "**复杂度** 时间 O( ) / 空间 O( )",
  "",
  "**易错点**",
  "",
  "**代码**（可选）",
].join("\n");

export default function AddCardPage({
  onBack,
  onSaved,
}: {
  onBack: () => void;
  onSaved: (tab: TabKey) => void;
}) {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [deckSel, setDeckSel] = useState("");
  const [newDeck, setNewDeck] = useState("");
  const [chapter, setChapter] = useState("");
  const [title, setTitle] = useState("");
  const [front, setFront] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const frontRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    api
      .listOverview()
      .then((o) => {
        setOverview(o);
        if (o.length > 0) setDeckSel((sel) => sel || o[0].name);
      })
      .catch(() => {});
  }, []);

  const deckName = deckSel === NEW ? newDeck.trim() : deckSel;
  const chapName = chapter.trim() || "未分类";

  async function saveAndNext() {
    setError("");
    setMsg("");
    if (!deckName) return setError("请填写卡包名");
    // 题面与标题至少给一个：标题留空时由题面的首行自动生成（后端投影）。
    if (!title.trim() && !front.trim()) return setError("请填写题面或标题");
    try {
      await api.addCard(deckName, chapName, title, content, front);
      setMsg(`已保存到「${deckName} · ${chapName}」`);
      setTitle("");
      setFront("");
      setContent("");
      onSaved("add");
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <section className="page">
      <button className="page-back btn" onClick={onBack}>
        ← 返回首页
      </button>
      <h1>添加卡片</h1>
      <p className="muted">
        要一次加多张？去「导入」页的<span className="muted">「粘贴文本」</span>
        把复制来的一整段笔记贴进去（SPEC §5.5）。
      </p>
      <div className="form-row">
        <label>卡包</label>
        <select value={deckSel} onChange={(e) => setDeckSel(e.target.value)}>
          {overview.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}
            </option>
          ))}
          <option value={NEW}>➕ 新卡包…</option>
        </select>
        {deckSel === NEW && (
          <input
            placeholder="新卡包名"
            value={newDeck}
            onChange={(e) => setNewDeck(e.target.value)}
          />
        )}
      </div>
      <div className="form-row">
        <label>章节</label>
        <input
          placeholder="章节名（如：事务），留空为「未分类」"
          value={chapter}
          onChange={(e) => setChapter(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label>标题（可选）</label>
        <input
          placeholder="留空则自动取题面首行，如：LC146 LRU 缓存"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="form-row top">
        <label>题面（正面，支持 Markdown）</label>
        <div className="popup-edit-toolbar">
          <button
            className="btn small"
            onClick={() => {
              const ta = frontRef.current;
              if (ta) void insertPickedImageMarkdown(ta);
            }}
            title="插入图片：图片会复制到 FlashMemo 的附件目录，卡面只保存引用"
          >
            🖼 插入图片
          </button>
          <span className="muted small">长题干 / 截图题面都放这里，支持粘贴截图（Ctrl+V）</span>
        </div>
        <textarea
          ref={frontRef}
          rows={4}
          placeholder={"设计一个满足 LRU 约束的数据结构……\n（留空时正面显示上面的标题）"}
          value={front}
          onChange={(e) => setFront(e.target.value)}
          onPaste={(e) => {
            // A screenshot on the clipboard becomes a stored image + markdown ref.
            const ta = frontRef.current;
            if (ta) void insertPastedImageMarkdown(ta, e.nativeEvent);
          }}
        />
      </div>
      <div className="form-row top">
        <label>要点（背面，支持 Markdown）</label>
        <div className="popup-edit-toolbar">
          <button
            className="btn small"
            onClick={() => {
              const ta = contentRef.current;
              if (ta) void insertPickedImageMarkdown(ta);
            }}
            title="插入图片：图片会复制到 FlashMemo 的附件目录，卡面只保存引用"
          >
            🖼 插入图片
          </button>
          <button
            className="btn small"
            onClick={() => setContent((c) => (c.trim() ? `${c}\n\n${DRILL_TEMPLATE}` : DRILL_TEMPLATE))}
            title="按刷题流程预填：思路 / 复杂度 / 易错点 / 代码"
          >
            🧩 刷题模板
          </button>
          <span className="muted small">支持粘贴截图（Ctrl+V）</span>
        </div>
        <textarea
          ref={contentRef}
          rows={6}
          placeholder={"- **原子性**：事务不可分割\n- ==高亮== 会被渲染为黄底"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onPaste={(e) => {
            // A screenshot on the clipboard becomes a stored image + markdown ref.
            const ta = contentRef.current;
            if (ta) void insertPastedImageMarkdown(ta, e.nativeEvent);
          }}
        />
      </div>
      <div className="form-row">
        <button className="btn primary" onClick={() => void saveAndNext()}>
          保存并新建下一张
        </button>
        {msg && <span className="ok">{msg}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      {front.trim() && (
        <div className="form-row top">
          <label>题面预览</label>
          <div
            className="preview-pane"
            dangerouslySetInnerHTML={{ __html: renderCard(front) }}
          />
        </div>
      )}
      <div className="form-row top">
        <label>要点预览</label>
        <div
          className="preview-pane"
          dangerouslySetInnerHTML={{ __html: renderCard(content) }}
        />
      </div>
    </section>
  );
}
