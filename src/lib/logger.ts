import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";

export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Send a diagnostic message to the app log file (%APPDATA%\FlashMemo\logs)
 * via the `frontend_log` command, so a bug report needs only one artifact.
 * In browser mock mode there is no backend: messages go to the console so
 * DevTools debugging keeps working. Logging must never break the caller —
 * every failure is swallowed.
 */
export async function logFrontend(level: LogLevel, message: string): Promise<void> {
  if (!isTauri()) {
    const line = `[frontend:${level}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }
  try {
    await invoke("frontend_log", { level, message });
  } catch {
    // A broken log channel must never surface to the user.
  }
}

/**
 * Capture anything async/React code lets slip (uncaught exceptions, unhandled
 * promise rejections) into the log file. Install once at bootstrap.
 */
export function installGlobalErrorHooks(): void {
  window.addEventListener("error", (e) => {
    void logFrontend(
      "error",
      `window.onerror: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    void logFrontend("error", `unhandled rejection: ${String(e.reason)}`);
  });
}
