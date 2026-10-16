// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorHooks, logFrontend } from "./logger";

// No Tauri environment in tests, so logFrontend always takes the console
// branch (the same one browser mock debugging uses).
afterEach(() => vi.restoreAllMocks());

describe("logFrontend (browser mock mode)", () => {
  it("routes errors to console.error with a level tag", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await logFrontend("error", "boom");
    expect(spy).toHaveBeenCalledWith("[frontend:error] boom");
  });

  it("routes warnings to console.warn", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await logFrontend("warn", "careful");
    expect(spy).toHaveBeenCalledWith("[frontend:warn] careful");
  });

  it("routes info and debug to console.log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logFrontend("info", "note");
    await logFrontend("debug", "trace");
    expect(logSpy).toHaveBeenCalledWith("[frontend:info] note");
    expect(logSpy).toHaveBeenCalledWith("[frontend:debug] trace");
  });
});

// t13（白屏可观测性）：白屏判据 = 日志里有没有这些行。两个钩子必须在
// bootstrap 里最先装上（main.tsx），这里锁住它们的行为。
describe("installGlobalErrorHooks (t13)", () => {
  it("window error 与 unhandledrejection 都会写进前端日志", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installGlobalErrorHooks();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom-async", filename: "app.js", lineno: 12, colno: 3 }),
    );
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new Error("promise-died") }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("window.onerror: boom-async"));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("unhandled rejection: Error: promise-died"),
    );
  });
});
