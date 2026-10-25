// @vitest-environment jsdom
// 主题模块（SPEC §16）：显式模式只切换 <html class="dark">；system 模式读取
// matchMedia（jsdom 没有时按浅色，不抛错）。
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, themeMode, watchSystemTheme } from "./theme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("applyTheme", () => {
  it("dark 加类、light 去类；system 在无 matchMedia 环境按浅色", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeMode()).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // jsdom 无 matchMedia：system 不得抛错，按浅色。
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(themeMode()).toBe("system");
  });

  it("watchSystemTheme 在无 matchMedia 环境返回可安全调用的清理函数", () => {
    const dispose = watchSystemTheme();
    expect(() => dispose()).not.toThrow();
  });
});
