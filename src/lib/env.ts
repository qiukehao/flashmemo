import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Captured at module-load time, BEFORE `installMockBackend()` patches
 * `window.__TAURI_INTERNALS__` — otherwise the mock would masquerade as Tauri.
 */
const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True when running inside the Tauri webview (false in a plain browser). */
export function isTauri(): boolean {
  return runningInTauri;
}

/**
 * Window label for view routing. In a browser (mock mode) the label comes from
 * the URL: `?window=popup` opens the review popup view.
 */
export function currentWindowLabel(): string {
  if (!runningInTauri) {
    return new URLSearchParams(window.location.search).get("window") ?? "main";
  }
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

/**
 * "立即复习" entry point (home page / tray fast path). In the real app this
 * emits `force-review` and the Rust engine opens the popup window; the browser
 * mock has no engine, so it swaps the current tab to the popup view instead.
 */
export async function triggerReviewNow(): Promise<void> {
  if (runningInTauri) {
    await emit("force-review");
  } else {
    window.location.search = "?window=popup";
  }
}
