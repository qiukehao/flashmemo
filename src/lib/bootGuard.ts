/**
 * 启动期白屏护栏（t13）：`bootstrap()` 在 React 挂载之前失败时，error boundary
 * 还没机会存在，页面就是纯白——没有任何提示，日志里也只有一条 unhandled
 * rejection。这里用不依赖 React 的原生 DOM 画一个最小报错页，并给「复制诊断
 * 信息」按钮，让这种白屏也可读、可上报。
 */
export function renderBootstrapFailure(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const text = [
    "[闪记 FlashMemo 启动失败]",
    `时间: ${new Date().toISOString()}`,
    `错误: ${String(error)}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");

  root.textContent = "";
  const box = document.createElement("div");
  box.className = "crash-screen";
  box.setAttribute("role", "alert");
  box.setAttribute("data-variant", "bootstrap");

  const title = document.createElement("h1");
  title.textContent = "启动失败";
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "这次启动没能完成，错误已写入日志（%APPDATA%\\FlashMemo\\logs）。";
  const detail = document.createElement("pre");
  detail.className = "crash-detail";
  detail.textContent = String(error);

  const actions = document.createElement("div");
  actions.className = "crash-actions";
  const copy = document.createElement("button");
  copy.className = "btn primary";
  copy.textContent = "复制诊断信息";
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });
  const reload = document.createElement("button");
  reload.className = "btn";
  reload.textContent = "重新加载";
  reload.addEventListener("click", () => window.location.reload());
  actions.append(copy, reload);

  box.append(title, hint, detail, actions);
  root.appendChild(box);
}
