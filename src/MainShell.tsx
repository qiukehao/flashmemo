import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { isTauri } from "./lib/env";
import type { TabKey } from "./lib/tabs";
import AiSidebar from "./components/AiSidebar";
import AddCardPage from "./pages/AddCardPage";
import DecksPage from "./pages/DecksPage";
import HomePage from "./pages/HomePage";
import ImportPage from "./pages/ImportPage";
import LeechesPage from "./pages/LeechesPage";
import SettingsPage from "./pages/SettingsPage";

const TABS: { key: TabKey; label: string }[] = [
  { key: "home", label: "首页" },
  { key: "decks", label: "卡包" },
  { key: "leeches", label: "疑难卡" },
  { key: "import", label: "导入" },
  { key: "add", label: "添加卡片" },
  { key: "settings", label: "设置" },
];

const AI_MIN_WIDTH = 320;
const AI_MAX_WIDTH = 720;

export default function MainShell() {
  const [tab, setTab] = useState<TabKey>("home");
  // Data-changing actions elsewhere bump this so pages reload on visit.
  const [bump, setBump] = useState(0);
  // AI sidebar (SPEC §10): open state + width are remembered across launches.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiWidth, setAiWidth] = useState(420);
  const [aiReady, setAiReady] = useState(false);
  const aiWidthRef = useRef(aiWidth);

  useEffect(() => {
    aiWidthRef.current = aiWidth;
  }, [aiWidth]);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setAiOpen((s.ai_sidebar_open ?? "0") === "1");
        const w = Number.parseInt(s.ai_sidebar_width ?? "420", 10);
        if (Number.isFinite(w)) {
          setAiWidth(Math.min(Math.max(w, AI_MIN_WIDTH), AI_MAX_WIDTH));
        }
      })
      .catch(() => {})
      .finally(() => setAiReady(true));
  }, []);

  // "问 AI" from the popup / card editor asks the sidebar to expand.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("ai-expand", () => setAiOpen(true)))
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!aiReady) return;
    void api.setSettings({ ai_sidebar_open: aiOpen ? "1" : "0" }).catch(() => {});
  }, [aiOpen, aiReady]);

  const closeAi = useCallback(() => {
    setAiOpen(false);
    if (isTauri()) void api.aiSidebarClose().catch(() => {});
  }, []);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setAiWidth(
        Math.min(Math.max(window.innerWidth - ev.clientX, AI_MIN_WIDTH), AI_MAX_WIDTH),
      );
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void api
        .setSettings({ ai_sidebar_width: String(Math.round(aiWidthRef.current)) })
        .catch(() => {});
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function navigate(next: TabKey) {
    setTab(next);
    setBump((k) => k + 1);
  }

  return (
    <div className="shell">
      <nav className="shell-nav">
        <div className="shell-brand">闪记</div>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`shell-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => navigate(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button
          className={`shell-tab ai-toggle ${aiOpen ? "active" : ""}`}
          onClick={() => (aiOpen ? closeAi() : setAiOpen(true))}
          title="内嵌 AI 网页，复习遇到不会的随时问"
        >
          🤖 AI 侧栏
        </button>
      </nav>
      <main className="shell-main">
        {tab === "home" && <HomePage key={bump} onNavigate={navigate} />}
        {tab === "decks" && <DecksPage key={bump} />}
        {tab === "leeches" && <LeechesPage key={bump} />}
        {tab === "import" && <ImportPage key={bump} onDone={navigate} />}
        {tab === "add" && <AddCardPage key={bump} onSaved={navigate} />}
        {tab === "settings" && <SettingsPage key={bump} />}
      </main>
      {aiOpen && (
        <>
          <div className="ai-divider" onMouseDown={startDrag} title="拖动调整宽度" />
          <AiSidebar width={aiWidth} onClose={closeAi} />
        </>
      )}
    </div>
  );
}
