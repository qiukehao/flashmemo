import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import App from "./App";
import { isTauri } from "./lib/env";

async function bootstrap() {
  // Plain-browser debugging mode: mock the Tauri backend so the UI (including
  // the popup view at ?window=popup) can be inspected with DevTools.
  // The module is code-split so the Tauri bundle never loads it.
  if (!isTauri()) {
    const { installMockBackend } = await import("./lib/mockBackend");
    installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
