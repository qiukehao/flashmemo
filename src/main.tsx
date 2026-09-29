import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import App from "./App";
import { isTauri } from "./lib/env";

async function bootstrap() {
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
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
