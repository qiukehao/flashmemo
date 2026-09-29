import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { triggerReviewNow } from "../lib/env";
import type { TabKey } from "../lib/tabs";

export default function HomePage({
  onNavigate,
}: {
  onNavigate: (tab: TabKey) => void;
}) {
  const [due, setDue] = useState<number | null>(null);

  useEffect(() => {
    api
      .dueCount()
      .then(setDue)
      .catch(() => setDue(0));
  }, []);

  return (
    <section className="page">
      <h1>闪记</h1>
      <p className="muted">把知识点做成闪卡，工作间隙定时弹出来背。</p>
      <div className="home-due">
        <span className="home-due-num">{due ?? "…"}</span>
        <span className="home-due-label">张卡片待复习</span>
      </div>
      <div className="home-actions">
        <button className="btn primary" onClick={() => void triggerReviewNow()}>
          立即复习
        </button>
        <button className="btn" onClick={() => onNavigate("import")}>
          导入 Markdown 笔记
        </button>
        <button className="btn" onClick={() => onNavigate("add")}>
          手动添加卡片
        </button>
      </div>
      <p className="muted small">
        到点会自动弹窗；空闲时窗口会收进系统托盘，不打扰工作。
      </p>
    </section>
  );
}
