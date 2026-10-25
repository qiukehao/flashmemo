import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AI_PRESETS, parseSites, serializeSites, type AiSite } from "../lib/aiSites";
import { isTauri } from "../lib/env";
import { logFrontend } from "../lib/logger";

/**
 * AI 助手独立窗口 (SPEC §10, 2026-10-07 重做)：整扇窗口只干一件事 —— 顶部一条
 * 站点工具栏，剩下的面积全部交给真实 AI 站点的 webview（由 Rust 以原生子
 * WebView 钉在本组件量出的布局槽里；iframe 嵌不进这些站点）。
 *
 * 侧栏时代的教训：子 WebView 曾经悬浮在主窗口/弹窗内部、靠 JS 逐帧同步坐标，
 * 和卡面编辑叠加就是白屏崩溃。现在它住在自己的窗口里，宿主页面里没有任何
 * 编辑器，坐标同步只剩「窗口自身 resize」一种来源；窗口关闭一律是隐藏，
 * 站点页面不销毁，对话因此得以保留（隐藏再打开 = 回到原对话）。
 */
export default function AiWindowPage() {
  const [sites, setSites] = useState<AiSite[]>(AI_PRESETS);
  const [activeIdx, setActiveIdx] = useState(0);
  const [urlDraft, setUrlDraft] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 首开有 1–2s 的子 WebView 冷启动：给个明确的加载占位，而不是一块死灰板。
  const [attaching, setAttaching] = useState(true);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const openedUrl = useRef<string | null>(null);
  // 网址栏「打开」按下时置位：下一次 attach 必须真的导航（同源不同路径也算）。
  const pendingForce = useRef(false);

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
  // otherwise just follow the window resizes.
  useEffect(() => {
    if (!settingsLoaded || !active || !isTauri()) return;
    const el = slotRef.current;
    if (!el) return;
    // 原生 resize 通道的护栏：ResizeObserver 会因滚动条出现/消失、亚像素抖动
    // 反复触发，而 ai_window_resize 是同步命令、内部直接 set_bounds ——
    // 槽位没有真的变化就不发，避免重复派发。
    let lastRect = "";
    const rectKey = (r: DOMRect) => `${r.x}|${r.y}|${r.width}|${r.height}`;
    const apply = (navigate: boolean) => {
      const r = el.getBoundingClientRect();
      if (navigate || openedUrl.current !== active.url) {
        openedUrl.current = active.url;
        lastRect = rectKey(r);
        setLoadError(null);
        void logFrontend(
          "info",
          `ai window attach: url=${active.url} rect=${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
        void api
          .aiWindowAttach(active.url, r.x, r.y, r.width, r.height, pendingForce.current)
          .catch(() => {
            setLoadError("AI 网页打开失败，请检查网络或更换网址");
          })
          .finally(() => {
            pendingForce.current = false;
            // 子 WebView 已就位（导航与加载在原生层继续）：撤掉加载占位。
            setAttaching(false);
          });
        return;
      }
      const key = rectKey(r);
      if (key === lastRect) return;
      lastRect = key;
      void api
        .aiWindowResize(r.x, r.y, r.width, r.height)
        .catch((e) => void logFrontend("warn", `ai window resize failed: ${String(e)}`));
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
    pendingForce.current = true;
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

  function hideWindow() {
    if (isTauri()) {
      void api.aiWindowHide().catch(() => {});
    } else {
      window.location.search = "?window=main";
    }
  }

  return (
    <div className="ai-window">
      {/* 无边框窗口：这条头就是标题栏（拖拽区），隐藏按钮/站点切换保持可点。 */}
      <div className="ai-window-head" data-tauri-drag-region>
        <span className="ai-title" data-tauri-drag-region>
          🤖 AI 助手
        </span>
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
        <button className="btn small" onClick={hideWindow} title="隐藏窗口（对话保留，随时回来）">
          隐藏
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
        {attaching && isTauri() && !loadError && (
          <div className="ai-loading muted small" role="status">
            <span className="ai-loading-dot" aria-hidden="true" />
            正在打开 {active?.name ?? "AI"} 站点…
          </div>
        )}
        {loadError && isTauri() && (
          <div className="muted small ai-mock-hint">{loadError}</div>
        )}
        {!isTauri() && (
          <div className="muted small ai-mock-hint">
            浏览器调试模式不加载真实 AI 网页（桌面版会在这里内嵌 Webview）。
            <br />
            当前站点：{active?.url}
          </div>
        )}
      </div>
      <div className="muted small ai-sidebar-hint">
        问题会自动填进网页输入框（回车发送）；若站点不支持自动填充，按 Ctrl+V 粘贴。
        关闭/隐藏窗口不会丢对话。
      </div>
    </div>
  );
}
