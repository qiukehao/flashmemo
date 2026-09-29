import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AI_PRESETS, parseSites, serializeSites, type AiSite } from "../lib/aiSites";
import { isTauri } from "../lib/env";

/**
 * AI sidebar (SPEC §10): a native child webview pinned to this panel. The
 * placeholder div below is the layout slot — its rect is handed to Rust, which
 * positions the real webview (iframes cannot embed these sites).
 */
export default function AiSidebar({
  width,
  onClose,
}: {
  width: number;
  onClose: () => void;
}) {
  const [sites, setSites] = useState<AiSite[]>(AI_PRESETS);
  const [activeIdx, setActiveIdx] = useState(0);
  const [urlDraft, setUrlDraft] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const openedUrl = useRef<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const loaded = parseSites(s.ai_sites);
        setSites(loaded);
        const idx = Math.min(
          Math.max(Number.parseInt(s.ai_active_index ?? "0", 10) || 0, 0),
          loaded.length - 1,
        );
        setActiveIdx(idx);
        setUrlDraft(loaded[idx]?.url ?? "");
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));
  }, []);

  const active = sites[activeIdx];

  // Hand the slot's rect to the native webview: navigate on site change,
  // otherwise just follow the layout.
  useEffect(() => {
    if (!settingsLoaded || !active || !isTauri()) return;
    const el = slotRef.current;
    if (!el) return;
    const apply = (navigate: boolean) => {
      const r = el.getBoundingClientRect();
      if (navigate || openedUrl.current !== active.url) {
        openedUrl.current = active.url;
        void api.aiSidebarOpen(active.url, r.x, r.y, r.width, r.height).catch(() => {});
      } else {
        void api.aiSidebarResize(r.x, r.y, r.width, r.height).catch(() => {});
      }
    };
    apply(true);
    const ro = new ResizeObserver(() => apply(false));
    ro.observe(el);
    const onResize = () => apply(false);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [active, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    void api.setSettings({ ai_active_index: String(activeIdx) }).catch(() => {});
  }, [activeIdx, settingsLoaded]);

  function switchSite(i: number) {
    setActiveIdx(i);
    setUrlDraft(sites[i]?.url ?? "");
  }

  /** Open the typed URL: jump to a preset, or add/update the 自定义 entry. */
  function applyUrl() {
    const url = urlDraft.trim();
    if (!url) return;
    const preset = AI_PRESETS.findIndex((p) => p.url === url);
    if (preset >= 0) {
      switchSite(preset);
      return;
    }
    const customIdx = sites.findIndex((s) => s.name === "自定义");
    const next = [...sites];
    if (customIdx >= 0) {
      next[customIdx] = { name: "自定义", url };
      setSites(next);
      switchSite(customIdx);
    } else {
      next.push({ name: "自定义", url });
      setSites(next);
      setActiveIdx(next.length - 1);
      setUrlDraft(url);
    }
    void api.setSettings({ ai_sites: serializeSites(next) }).catch(() => {});
  }

  return (
    <aside className="ai-sidebar" style={{ width }}>
      <div className="ai-sidebar-head">
        <span className="ai-title">🤖 AI 助手</span>
        <select
          value={activeIdx}
          onChange={(e) => switchSite(Number(e.target.value))}
          title="切换站点（登录态各自保留）"
        >
          {sites.map((s, i) => (
            <option key={`${s.name}-${i}`} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={onClose} title="收起侧栏">
          收起 ›
        </button>
      </div>
      <div className="ai-sidebar-url">
        <input
          value={urlDraft}
          placeholder="AI 网址（可自定义）"
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyUrl()}
        />
        <button className="btn small" onClick={applyUrl}>
          打开
        </button>
      </div>
      <div className="ai-webview-slot" ref={slotRef}>
        {!isTauri() && (
          <div className="muted small ai-mock-hint">
            浏览器调试模式不加载真实 AI 网页（桌面版会在这里内嵌 Webview）。
            <br />
            当前站点：{active?.url}
          </div>
        )}
      </div>
      <div className="muted small ai-sidebar-hint">
        复制了问题后，在网页输入框 Ctrl+V 即可提问
      </div>
    </aside>
  );
}
