import { useState } from "react";
import AddCardPage from "./pages/AddCardPage";
import HomePage from "./pages/HomePage";
import ImportPage from "./pages/ImportPage";
import SettingsPage from "./pages/SettingsPage";

const TABS = [
  { key: "home", label: "首页" },
  { key: "import", label: "导入" },
  { key: "add", label: "添加卡片" },
  { key: "settings", label: "设置" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

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
        {tab === "import" && <ImportPage key={bump} onDone={navigate} />}
        {tab === "add" && <AddCardPage key={bump} onSaved={navigate} />}
        {tab === "settings" && <SettingsPage key={bump} />}
      </main>
    </div>
  );
}
