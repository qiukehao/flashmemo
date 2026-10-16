/**
 * 备注的悬浮弹窗 (2026-10-07 用户反馈：备注改成弹窗、鼠标悬浮弹出)。
 *
 * `%%备注%%` 在卡面里渲染成 `.card-note` 块。编辑态里它现在被 CSS 压成一行
 * 摘要条（:focus-within 时展开成整块继续编辑，DOM 不加类、回写保真不受影响）；
 * 悬浮摘要时这个模块在 body 上弹一个浮层展示全文。
 *
 * 设计约束：浮层绝不能挂在 contenteditable 内部（进编辑器会被序列化进保存
 * 内容），所以事件委托 + portal 到 body，返回清理函数。
 */

let active: { host: HTMLElement; pop: HTMLDivElement; timer: number } | null = null;

function removePopover() {
  if (!active) return;
  window.clearTimeout(active.timer);
  active.pop.remove();
  active = null;
}

function showPopover(host: HTMLElement) {
  removePopover();
  const pop = document.createElement("div");
  pop.className = "note-popover";
  // 备注内容是 renderCard 产出的受控 HTML（markdown-it 转义了原始 HTML），
  // 复制展示是安全的；图标是装饰，不进浮层。
  const content = host.cloneNode(true) as HTMLElement;
  content.querySelectorAll(".card-note-icon").forEach((n) => n.remove());
  if (!(content.textContent ?? "").trim()) {
    const hint = document.createElement("span");
    hint.className = "muted small";
    hint.textContent = "（空批注 —— 点击备注条输入内容）";
    content.appendChild(hint);
  }
  pop.appendChild(content);
  document.body.appendChild(pop);
  const r = host.getBoundingClientRect();
  const width = pop.offsetWidth;
  let left = r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  const height = pop.offsetHeight;
  let top = r.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 6);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  // 悬浮离开留缓冲，避免从摘要条挪向浮层的瞬间闪烁。
  pop.addEventListener("mouseenter", () => window.clearTimeout(active?.timer));
  pop.addEventListener("mouseleave", removePopover);
  active = { host, pop, timer: 0 };
}

/**
 * Wire hover popovers for every `.card-note` inside `container`. Returns a
 * cleanup function (call when the container is re-rendered/unmounted).
 */
export function attachNotePopover(container: HTMLElement): () => void {
  const onOver = (e: Event) => {
    const target = e.target as HTMLElement;
    const host = target.closest?.(".card-note") as HTMLElement | null;
    if (!host || !container.contains(host)) return;
    // 正在编辑（焦点在备注里）时它自己是展开的，不需要浮层。
    if (host.contains(document.activeElement)) {
      removePopover();
      return;
    }
    if (active?.host === host) return;
    window.clearTimeout(active?.timer);
    showPopover(host);
  };
  const onOut = (e: Event) => {
    if (!active) return;
    const target = e.target as HTMLElement;
    if (!active.host.contains(target)) return;
    const to = (e as MouseEvent).relatedTarget as Node | null;
    if (to && (active.host.contains(to) || active.pop.contains(to))) return;
    // 400ms：从摘要条挪到浮层要跨过间隙，太快会让"悬浮查看"变成碰运气。
    const timer = window.setTimeout(removePopover, 400);
    window.clearTimeout(active.timer);
    active.timer = timer;
  };
  // 换卡/滚动时浮层挂在 body 上不会跟着走，直接收掉。
  const reset = () => removePopover();
  container.addEventListener("mouseover", onOver);
  container.addEventListener("mouseout", onOut);
  container.addEventListener("scroll", reset, true);
  return () => {
    container.removeEventListener("mouseover", onOver);
    container.removeEventListener("mouseout", onOut);
    container.removeEventListener("scroll", reset, true);
    removePopover();
  };
}
