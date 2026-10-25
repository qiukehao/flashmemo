/**
 * 暗色主题（SPEC §16，2026-10-25）：`system` 跟随系统、`light` / `dark` 手动锁定。
 * 模式存后端 KV（theme_mode），应用层只负责把当前模式反映成 `<html class="dark">`；
 * 跟随系统时监听 matchMedia 变化即时切换。
 */

let currentMode = "system";

export function themeMode(): string {
  return currentMode;
}

export function applyTheme(mode: string): void {
  currentMode = mode;
  // jsdom 没有 matchMedia：显式模式不受影响，system 在测试里按浅色处理。
  const systemDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = mode === "dark" || (mode === "system" && systemDark);
  document.documentElement.classList.toggle("dark", dark);
}

/** 跟随系统时，系统切换即时生效。返回清理函数。 */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (currentMode === "system") applyTheme("system");
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
