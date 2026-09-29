import { useState } from "react";
import type { TabKey } from "./lib/tabs";
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

export default function MainShell() {
  const [tab, setTab] = useState<TabKey>("home");
  // Data-changing actions elsewhere bump this so pages reload on visit.
  const [bump, setBump] = useState(0);

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
      </nav>
      <main className="shell-main">
        {tab === "home" && <HomePage key={bump} onNavigate={navigate} />}
        {tab === "decks" && <DecksPage key={bump} />}
        {tab === "leeches" && <LeechesPage key={bump} />}
        {tab === "import" && <ImportPage key={bump} onDone={navigate} />}
        {tab === "add" && <AddCardPage key={bump} onSaved={navigate} />}
        {tab === "settings" && <SettingsPage key={bump} />}
      </main>
    </div>
  );
}
