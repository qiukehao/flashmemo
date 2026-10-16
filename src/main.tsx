import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import App from "./App";
import { initAttachments } from "./lib/attachments";
import { renderBootstrapFailure } from "./lib/bootGuard";
import { isTauri } from "./lib/env";
import { installGlobalErrorHooks, logFrontend } from "./lib/logger";

async function bootstrap() {
  // 全局错误钩子必须最先装上：它之后的一切（含下面可能失败的初始化）都要留痕。
  installGlobalErrorHooks();
  try {
    // Plain-browser debugging mode: mock the Tauri backend so the UI (including
    // the popup view at ?window=popup) can be inspected with DevTools.
    // The module is code-split so the Tauri bundle never loads it. A transient
    // dev-server hiccup must not blank the page: fall back to rendering as-is.
    if (!isTauri()) {
      try {
        const { installMockBackend } = await import("./lib/mockBackend");
        installMockBackend();
      } catch (e) {
        console.error("[mock] 调试后端加载失败，将以无数据模式启动：", e);
      }
    }
    // Card images resolve against the attachment folder, so it must be known
    // before the first render; a failure must not block startup (cards then show
    // the 图片未找到 placeholder instead).
    await initAttachments();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (e) {
    // 启动期白屏护栏（t13）：React 还没挂载，error boundary 兜不住，这里用原生
    // DOM 画一个可读报错页，别让用户对着纯白窗口。
    void logFrontend("error", `bootstrap failed: ${String(e)}`);
    renderBootstrapFailure(e);
  }
}

void bootstrap();
