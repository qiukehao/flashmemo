import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { isTauri } from "./lib/env";
import type { TabKey } from "./lib/tabs";
import ExamComposer from "./components/ExamComposer";
import AddCardPage from "./pages/AddCardPage";
import DecksPage from "./pages/DecksPage";
import DashboardPage from "./pages/DashboardPage";
import HomePage from "./pages/HomePage";
import ImportPage from "./pages/ImportPage";
import LeechesPage from "./pages/LeechesPage";
import SettingsPage from "./pages/SettingsPage";

const TABS: { key: TabKey; label: string }[] = [
  { key: "home", label: "首页" },
  { key: "dashboard", label: "仪表盘" },
  { key: "decks", label: "卡包" },
  { key: "leeches", label: "疑难卡" },
  { key: "import", label: "导入" },
  { key: "add", label: "添加卡片" },
  { key: "settings", label: "设置" },
];

// The primary navigation keeps the main product areas visible. Import,
// add-card, and leech views are opened from the header's 「＋ 新建」 menu or
// from other pages' actions, so they never compete for room in the header.
const PRIMARY_TABS = TABS.filter((tab) =>
  ["home", "dashboard", "decks", "settings"].includes(tab.key),
);

// Content-creation entry points, kept in one place in the header instead of
// taking two large cards on the home page. Review-style entries (组卷复习)
// live next to 开始复习 on the home hero instead.
const NEW_MENU: { key: TabKey; icon: string; label: string; hint: string }[] = [
  { key: "import", icon: "⇧", label: "导入 Markdown 笔记", hint: "整篇笔记自动拆成卡片" },
  { key: "add", icon: "＋", label: "手动添加卡片", hint: "自己写一张卡" },
];

export default function MainShell() {
  const [tab, setTab] = useState<TabKey>("home");
  const [deckFilter, setDeckFilter] = useState("all");
  // Data-changing actions elsewhere bump this so pages reload on visit.
  const [bump, setBump] = useState(0);
  // Card to auto-open in the deck editor (jump-to-edit from the popup, §11.2).
  const [pendingEditCard, setPendingEditCard] = useState<number | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [showExam, setShowExam] = useState(false);
  const newMenuRef = useRef<HTMLDivElement | null>(null);

  // 主题（SPEC §16）：启动时按设置应用；跟随系统时监听系统切换。
  useEffect(() => {
    api
      .getSettings()
      .then((st) => applyTheme(st.theme_mode ?? "system"))
      .catch(() => {});
    return watchSystemTheme();
  }, []);

  // Jump-to-edit from the popup's 知识铺垫 (§11.2): open the deck editor.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<number>("edit-card", (e) => {
          setTab("decks");
          setBump((k) => k + 1);
          setPendingEditCard(e.payload);
        }),
      )
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 托盘「打开监控设置」：切到设置页并滚到屏幕监控卡片（规则就在那里改）。
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("open-activity-settings", () => {
          setTab("settings");
          setBump((k) => k + 1);
          window.setTimeout(() => {
            document
              .querySelector(".activity-card")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 150);
        }),
      )
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // Browser mock has no cross-window events: the mock `edit_card_in_main`
  // hands the card id over via sessionStorage before switching views.
  useEffect(() => {
    if (isTauri()) return;
    const raw = sessionStorage.getItem("mockEditCardId");
    if (raw === null) return;
    sessionStorage.removeItem("mockEditCardId");
    const id = Number.parseInt(raw, 10);
    if (Number.isFinite(id)) {
      setTab("decks");
      setPendingEditCard(id);
    }
  }, []);

  useEffect(() => {
    const handler = () => {
      setTab("add");
      setBump((k) => k + 1);
    };
    window.addEventListener("flashmemo:add-card", handler);
    return () => window.removeEventListener("flashmemo:add-card", handler);
  }, []);

  // The 新建 menu is a lightweight popover: any click outside it, or Esc, closes
  // it. The nav's backdrop-filter makes it a containing block for fixed
  // descendants, so outside clicks are matched with a document listener
  // instead of a full-screen backdrop element.
  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!newMenuRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [newMenuOpen]);

  // 组卷 is global: the composer can be opened from the home hero and reloads
  // whatever page is visible when it closes.
  function openNewMenuEntry(key: TabKey) {
    setNewMenuOpen(false);
    navigate(key);
  }

  /** AI 助手是独立窗口（2026-10-07 重做）：打开/聚焦它，而不是在本窗口里
   *  挖一块原生覆盖层。隐藏 ≠ 销毁，对话一直在。 */
  const openAiWindow = useCallback(() => {
    if (isTauri()) void api.aiWindowShow("main").catch(() => {});
  }, []);

  function navigate(next: TabKey) {
    setTab(next);
    setBump((k) => k + 1);
  }

  function openCards(filter: string) {
    setDeckFilter(filter);
    navigate("decks");
  }

  return (
    <div className="shell">
      <nav className="shell-nav">
        <div className="shell-brand"><span className="brand-mark">✦</span><span>闪记</span></div>
        <div className="shell-tabs">
        {PRIMARY_TABS.map((t) => (
          <button
            key={t.key}
            className={`shell-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => navigate(t.key)}
          >
            {t.label}
          </button>
        ))}
        </div>
        <div className="shell-actions">
          <div className="new-menu-wrap" ref={newMenuRef}>
            <button
              className={`new-toggle ${newMenuOpen ? "active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen((open) => !open)}
              title="导入笔记、自己写卡、组卷复习"
            >
              <span aria-hidden="true">＋</span> 新建
            </button>
            {newMenuOpen && (
              <div className="new-menu" role="menu">
                {NEW_MENU.map((item) => (
                  <button
                    key={item.key}
                    role="menuitem"
                    className="new-menu-item"
                    onClick={() => openNewMenuEntry(item.key)}
                  >
                    <span className="new-menu-icon" aria-hidden="true">{item.icon}</span>
                    <span className="new-menu-text">
                      <span>{item.label}</span>
                      <span className="muted small">{item.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="shell-tab ai-toggle"
            onClick={openAiWindow}
            title="打开 AI 助手窗口（独立窗口；隐藏不销毁，对话保留）"
          >
            ✦
          </button>
        </div>
      </nav>
      <main className="shell-main">
        {tab === "home" && (
          <HomePage
            key={bump}
            onNavigate={navigate}
            onOpenCards={openCards}
            onComposeExam={() => setShowExam(true)}
          />
        )}
        {tab === "dashboard" && (
          <DashboardPage key={bump} onNavigate={navigate} onOpenCards={openCards} />
        )}
        {tab === "decks" && (
          <DecksPage
            key={bump}
            initialFilter={deckFilter}
            openCardId={pendingEditCard}
            onCardOpened={() => setPendingEditCard(null)}
          />
        )}
        {tab === "leeches" && <LeechesPage key={bump} onBack={() => navigate("home")} />}
        {tab === "import" && (
          <ImportPage key={bump} onBack={() => navigate("home")} onDone={navigate} />
        )}
        {tab === "add" && (
          <AddCardPage key={bump} onBack={() => navigate("home")} onSaved={navigate} />
        )}
        {tab === "settings" && <SettingsPage key={bump} />}
      </main>
      {showExam && (
        <ExamComposer
          onClose={() => {
            setShowExam(false);
            setBump((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
