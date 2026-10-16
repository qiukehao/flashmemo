import { Component, type ErrorInfo, type ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";
import AiWindowPage from "./components/AiWindowPage";
import MainShell from "./MainShell";
import ReviewPopup from "./components/ReviewPopup";
import { copyText } from "./lib/dom";
import { currentWindowLabel, isTauri } from "./lib/env";
import { logFrontend } from "./lib/logger";

type BoundaryVariant = "main" | "popup";

const appWindow = isTauri() ? getCurrentWebviewWindow() : null;

/** 弹窗白屏必须能自己走出去：用户在那里连「评分 / 跳过」都点不到。 */
function closePopupWindow() {
  if (appWindow) {
    void appWindow.close().catch(() => {});
  } else {
    // Browser mock mode has no second window: go back to the management view.
    window.location.search = "?window=main";
  }
}

/** 一键复制的诊断文本：报错 + React 组件栈 + 环境，用户贴给开发者即可定位。 */
function diagnostics(variant: BoundaryVariant, error: Error, componentStack: string): string {
  return [
    "[闪记 FlashMemo 报错]",
    `窗口: ${variant}`,
    `时间: ${new Date().toISOString()}`,
    `错误: ${error.name}: ${error.message}`,
    `UA: ${navigator.userAgent}`,
    "",
    componentStack.trim(),
  ].join("\n");
}

/**
 * 白屏护栏（SPEC §17 稳定性，t13）：渲染期异常会让 React 卸载整棵树，用户只看到
 * 一片空白——没有报错、没有日志、只能重启。这里把异常截住，写进日志文件
 * （%APPDATA%\FlashMemo\logs），并给出可读报错、一键复制诊断信息与重试入口。
 *
 * 两个窗口各挂一个（`variant` 决定文案与出口）：主窗口可「重新加载」，复习弹窗
 * 额外给「关闭弹窗」，否则用户卡在一个点不动的窗口里。
 * 边界只覆盖渲染与生命周期异常；事件回调、定时器、Promise 里的异常由 logger 的
 * window.onerror / unhandledrejection 钩子记录（见 src/lib/logger.ts）。数据层不受
 * 影响：卡片内容在 SQLite 里，重试即可恢复。
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode; variant?: BoundaryVariant },
  { error: Error | null; componentStack: string }
> {
  state: { error: Error | null; componentStack: string } = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info.componentStack ?? "";
    this.setState({ componentStack });
    void logFrontend(
      "error",
      `react error boundary (${this.props.variant ?? "main"}): ${error.message} | ${componentStack}`.slice(
        0,
        2000,
      ),
    );
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const variant = this.props.variant ?? "main";
    return (
      <div className="crash-screen" role="alert" data-variant={variant}>
        <h1>界面出错了</h1>
        <p className="muted">
          {variant === "popup" ? "这次复习弹窗渲染失败" : "这次界面渲染失败"}
          已记录到日志（%APPDATA%\FlashMemo\logs），你的卡片数据没有丢失。
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button
            className="btn primary"
            onClick={() => this.setState({ error: null, componentStack: "" })}
          >
            重试
          </button>
          <button
            className="btn"
            onClick={() => void copyText(diagnostics(variant, error, componentStack))}
          >
            复制诊断信息
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            重新加载
          </button>
          {variant === "popup" && (
            <button className="btn" onClick={closePopupWindow}>
              关闭弹窗
            </button>
          )}
        </div>
      </div>
    );
  }
}

export default function App() {
  // One bundle, three windows: the popup window renders the review flow, the
  // AI window hosts the embedded AI sites, everything else is the management
  // panel (SPEC §15). In browser mock mode the view is selected with ?window=.
  const label = currentWindowLabel();
  if (label === "popup") {
    return (
      <AppErrorBoundary variant="popup">
        <ReviewPopup />
      </AppErrorBoundary>
    );
  }
  if (label === "ai") {
    return (
      <AppErrorBoundary variant="main">
        <AiWindowPage />
      </AppErrorBoundary>
    );
  }
  return (
    <AppErrorBoundary variant="main">
      <MainShell />
    </AppErrorBoundary>
  );
}
