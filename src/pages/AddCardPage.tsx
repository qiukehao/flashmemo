import { useEffect, useState } from "react";
import { api, type DeckOverview } from "../lib/api";
import { renderCard } from "../lib/markdown";

const NEW = "__new__";

export default function AddCardPage({
  onSaved,
}: {
  onSaved: (tab: "home" | "import" | "add" | "settings") => void;
}) {
  const [overview, setOverview] = useState<DeckOverview[]>([]);
  const [deckSel, setDeckSel] = useState("");
  const [newDeck, setNewDeck] = useState("");
  const [chapter, setChapter] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

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
    if (!title.trim()) return setError("请填写卡片问题");
    try {
      await api.addCard(deckName, chapName, title, content);
      setMsg(`已保存到「${deckName} · ${chapName}」`);
      setTitle("");
      setContent("");
      onSaved("add");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="page">
      <h1>添加卡片</h1>
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
        <label>问题（正面）</label>
        <input
          placeholder="如：事务的 ACID 是什么？"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="form-row top">
        <label>要点（背面，支持 Markdown）</label>
        <textarea
          rows={6}
          placeholder={"- **原子性**：事务不可分割\n- ==高亮== 会被渲染为黄底"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="form-row">
        <button className="btn primary" onClick={() => void saveAndNext()}>
          保存并新建下一张
        </button>
        {msg && <span className="ok">{msg}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div className="form-row top">
        <label>预览</label>
        <div
          className="preview-pane"
          dangerouslySetInnerHTML={{ __html: renderCard(content) }}
        />
      </div>
    </section>
  );
}
