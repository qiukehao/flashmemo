import { useEffect, useRef, useState, type ReactNode } from "react";
import { insertImageAtCaret } from "../lib/dom";
import { uploadImageFiles } from "../lib/attachments";
import { logFrontend } from "../lib/logger";
import {
  insertCodeBlock,
  insertHr,
  insertTable,
  setBlockTag,
  toggleBlockquote,
  toggleList,
  wrapSelection,
} from "../lib/wysiwyg";

// Rough menu size, used only to keep the popup inside the viewport.
const MENU_W = 252;
const MENU_H = 320;

const HEADING_ITEMS: { tag: string; label: string }[] = [
  { tag: "h1", label: "一级标题" },
  { tag: "h2", label: "二级标题" },
  { tag: "h3", label: "三级标题" },
  { tag: "h4", label: "四级标题" },
  { tag: "h5", label: "五级标题" },
  { tag: "h6", label: "六级标题" },
  { tag: "p", label: "段落" },
];

/** 单色线性图标（feather 风格），字母形图标直接用文字。 */
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    cut: (
      <>
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <line x1="20" y1="4" x2="8.12" y2="15.88" />
        <line x1="14.47" y1="14.48" x2="20" y2="20" />
        <line x1="8.12" y1="8.12" x2="12" y2="12" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    paste: (
      <>
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
      </>
    ),
    trash: (
      <>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </>
    ),
    code: (
      <>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>
    ),
    marker: <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
    note: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </>
    ),
    listUl: (
      <>
        <line x1="9" y1="6" x2="21" y2="6" />
        <line x1="9" y1="12" x2="21" y2="12" />
        <line x1="9" y1="18" x2="21" y2="18" />
        <circle cx="4" cy="6" r="1" fill="currentColor" />
        <circle cx="4" cy="12" r="1" fill="currentColor" />
        <circle cx="4" cy="18" r="1" fill="currentColor" />
      </>
    ),
    task: (
      <>
        <polyline points="9 11 12 14 22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </>
    ),
    hr: <line x1="4" y1="12" x2="20" y2="12" />,
    table: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="12" y1="3" x2="12" y2="21" />
      </>
    ),
    chevron: <polyline points="9 18 15 12 9 6" />,
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? null}
    </svg>
  );
}

/** 右键批注/Markdown 菜单（2026-10-06，参考用户提供的样式）：图标矩阵 +
 *  标题/插入子菜单。所有块级操作作用于光标所在的根级块（callout 内不动结构）。
 *  剪切/复制/删除走 execCommand；粘贴读剪贴板（失败时留在菜单里提示 Ctrl+V）。
 *  onAskAi：最后一项「问 AI」——由调用方打开 AI 侧栏并把问题填进输入框。 */
export default function EditContextMenu({
  x,
  y,
  editor,
  collapsed,
  bounds,
  onNote,
  onPickImage,
  onChange,
  onAskAi,
  onClose,
}: {
  x: number;
  y: number;
  editor: HTMLElement | null;
  collapsed: boolean;
  /** 允许放置菜单的横向范围（卡面列的 rect）。侧栏（原生子 WebView，永远盖在
   *  DOM 之上）打开时由调用方传入，菜单不得伸进侧栏区 —— 那部分点击会被原生
   *  窗口吞掉，用户看到的是"点了没反应"。null/省略 = 只按视口钳位。 */
  bounds?: { left: number; right: number } | null;
  onNote: () => void;
  onPickImage: () => void;
  onChange: () => void;
  onAskAi?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  // 链接输入框一拿焦点，编辑区的选区就会被清掉——点下「链接」那一刻先把
  // 选区 Range 存起来，确认时用它（而不是当时的 live selection）。
  const linkRangeRef = useRef<Range | null>(null);
  const [openSub, setOpenSub] = useState<"heading" | "insert" | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 菜单吃掉这次 Esc：弹窗的全局热键把 Esc 映射为「跳过卡片」，
      // 不能让菜单打开时的 Esc 一并触发跳评。
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    // 任何滚动（内层面板也在内）都会让菜单漂离锚点，直接收起最稳。
    const onScroll = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  useEffect(() => {
    if (linkMode) linkInputRef.current?.focus();
  }, [linkMode]);

  // 横向钳位：默认只按视口；侧栏开着时钳进卡面列（见 bounds 的说明）。
  const rightEdge = bounds ? bounds.right : window.innerWidth;
  const minLeft = Math.max(8, bounds ? bounds.left + 8 : 8);
  const left = Math.max(minLeft, Math.min(x, Math.max(minLeft, rightEdge - MENU_W - 8)));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));
  // 子菜单往空间更宽的一侧弹出（弹窗窗口窄，靠右开菜单时右侧放不下）。
  const flyoutSide = left > (bounds ? bounds.left + (bounds.right - bounds.left) / 2 : window.innerWidth / 2)
    ? "flyout-left"
    : "flyout-right";

  /** 菜单项动作统一出口：动作返回 false（如粘贴失败）则留在菜单里给提示。 */
  async function run(action: () => boolean | void | Promise<boolean | void>) {
    try {
      const result = action();
      if (result instanceof Promise) {
        const ok = await result;
        if (ok === false) {
          setHint("无法读取剪贴板，请直接用 Ctrl+V 粘贴");
          return;
        }
      }
    } catch (e) {
      // 编辑器命令不该把整棵树打崩（Bug4「白屏」里有一条就是这个形状：动作抛错
      // 逃逸出 onClick → React 卸载整棵子树）。就地留提示 + 日志，菜单继续可用。
      void logFrontend("error", `edit menu action failed: ${String(e)}`);
      setHint("这个操作没成功，已记录日志");
      return;
    }
    onClose();
  }

  function wrap(tag: string) {
    return () => {
      if (!editor) return;
      wrapSelection(editor, tag);
      onChange();
    };
  }

  function clip(cmd: "copy" | "cut" | "delete") {
    return () => {
      if (document.execCommand(cmd)) onChange();
    };
  }

  async function pasteFromClipboard(): Promise<boolean> {
    if (!editor) return false;
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await item.getType(type);
            const refs = await uploadImageFiles([new File([blob], "paste.png", { type })]);
            let ok = false;
            for (const ref of refs) ok = insertImageAtCaret(editor, ref) || ok;
            if (ok) onChange();
            return ok;
          }
        }
      }
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      document.execCommand("insertText", false, text);
      onChange();
      return true;
    } catch {
      return false;
    }
  }

  function block(action: () => boolean) {
    return () => {
      if (!editor) return;
      action();
      onChange();
    };
  }

  function applyLink() {
    const url = linkValue.trim();
    const range = linkRangeRef.current;
    if (!editor || !range || !url) return;
    if (!editor.contains(range.commonAncestorContainer)) return;
    const a = document.createElement("a");
    a.href = url;
    a.textContent = range.toString() || url;
    range.deleteContents();
    range.insertNode(a);
    // 光标挪到链接后面，方便继续打字。
    const sel = window.getSelection();
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    onChange();
    onClose();
  }

  return (
    <div
      className="edit-context-menu"
      role="menu"
      ref={ref}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="edit-context-row">
        <button
          type="button"
          className="edit-context-ico"
          title="剪切"
          aria-label="剪切"
          disabled={collapsed}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(clip("cut"))}
        >
          <Icon name="cut" />
        </button>
        <button
          type="button"
          className="edit-context-ico"
          title="复制"
          aria-label="复制"
          disabled={collapsed}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(clip("copy"))}
        >
          <Icon name="copy" />
        </button>
        <button
          type="button"
          className="edit-context-ico"
          title="粘贴（剪贴板文本或截图）"
          aria-label="粘贴"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(() => pasteFromClipboard())}
        >
          <Icon name="paste" />
        </button>
        <button
          type="button"
          className="edit-context-ico"
          title="删除选中文字"
          aria-label="删除选中文字"
          disabled={collapsed}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(clip("delete"))}
        >
          <Icon name="trash" />
        </button>
      </div>

      <div className="edit-context-row">
        <button type="button" className="edit-context-ico" title="加粗（Ctrl+B）" aria-label="加粗" disabled={collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrap("strong"))}>
          <b>B</b>
        </button>
        <button type="button" className="edit-context-ico" title="斜体" aria-label="斜体" disabled={collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrap("em"))}>
          <i>I</i>
        </button>
        <button type="button" className="edit-context-ico" title="删除线" aria-label="删除线" disabled={collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrap("del"))}>
          <s>S</s>
        </button>
        <button type="button" className="edit-context-ico" title="行内代码" aria-label="行内代码" disabled={collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrap("code"))}>
          <Icon name="code" />
        </button>
        <button type="button" className="edit-context-ico" title="高亮（==文字==）" aria-label="高亮" disabled={collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrap("mark"))}>
          <Icon name="marker" />
        </button>
        <button
          type="button"
          className="edit-context-ico"
          title="链接"
          aria-label="链接"
          disabled={collapsed}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setHint(null);
            const sel = window.getSelection();
            linkRangeRef.current =
              sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
            setLinkMode(true);
          }}
        >
          <Icon name="link" />
        </button>
      </div>

      <div className="edit-context-row">
        <button type="button" className="edit-context-ico" title="引用块" aria-label="引用块" onMouseDown={(e) => e.preventDefault()} onClick={() => run(block(() => toggleBlockquote(editor!)))}>
          ❝
        </button>
        <button type="button" className="edit-context-ico" title="无序列表" aria-label="无序列表" onMouseDown={(e) => e.preventDefault()} onClick={() => run(block(() => toggleList(editor!, "ul")))}>
          <Icon name="listUl" />
        </button>
        <button type="button" className="edit-context-ico" title="有序列表" aria-label="有序列表" onMouseDown={(e) => e.preventDefault()} onClick={() => run(block(() => toggleList(editor!, "ol")))}>
          <small>1.</small>
        </button>
        <button type="button" className="edit-context-ico" title="任务列表（- [ ] ）" aria-label="任务列表" onMouseDown={(e) => e.preventDefault()} onClick={() => run(block(() => toggleList(editor!, "task")))}>
          <Icon name="task" />
        </button>
        <button type="button" className="edit-context-ico" title="备注：段落后插一条批注（不改原文，悬浮批注看全文）" aria-label="备注" onMouseDown={(e) => e.preventDefault()} onClick={() => run(onNote)}>
          <Icon name="note" />
        </button>
      </div>

      <div className="edit-context-subwrap">
        <button
          type="button"
          className={`edit-context-item ${openSub === "heading" ? "active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenSub(openSub === "heading" ? null : "heading")}
          onMouseEnter={() => openSub && setOpenSub("heading")}
        >
          <span className="edit-context-icon">
            <b>H</b>
          </span>
          <span className="edit-context-label">标题</span>
          <span className="edit-context-chevron">
            <Icon name="chevron" />
          </span>
        </button>
        <button
          type="button"
          className={`edit-context-item ${openSub === "insert" ? "active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenSub(openSub === "insert" ? null : "insert")}
          onMouseEnter={() => openSub && setOpenSub("insert")}
        >
          <span className="edit-context-icon">＋</span>
          <span className="edit-context-label">插入</span>
          <span className="edit-context-chevron">
            <Icon name="chevron" />
          </span>
        </button>
      </div>

      {openSub === "heading" && (
        <div className={`edit-context-flyout ${flyoutSide}`} role="menu" aria-label="标题">
          {HEADING_ITEMS.map((item) => (
            <button
              key={item.tag}
              type="button"
              role="menuitem"
              className="edit-context-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(block(() => setBlockTag(editor!, item.tag)))}
            >
              <span className="edit-context-icon">
                {item.tag === "p" ? "¶" : item.tag.replace("h", "H")}
              </span>
              <span className="edit-context-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {openSub === "insert" && (
        <div className={`edit-context-flyout ${flyoutSide}`} role="menu" aria-label="插入">
          <button
            type="button"
            role="menuitem"
            className="edit-context-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(onPickImage)}
          >
            <span className="edit-context-icon">
              <Icon name="image" />
            </span>
            <span className="edit-context-label">图像</span>
            <span className="edit-context-hint">可 Ctrl+V</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="edit-context-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(block(() => insertHr(editor!)))}
          >
            <span className="edit-context-icon">
              <Icon name="hr" />
            </span>
            <span className="edit-context-label">水平分割线</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="edit-context-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(block(() => insertTable(editor!)))}
          >
            <span className="edit-context-icon">
              <Icon name="table" />
            </span>
            <span className="edit-context-label">表格</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="edit-context-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(block(() => insertCodeBlock(editor!)))}
          >
            <span className="edit-context-icon">
              <Icon name="code" />
            </span>
            <span className="edit-context-label">代码块</span>
          </button>
        </div>
      )}

      {onAskAi && (
        <div className="edit-context-subwrap">
          <button
            type="button"
            role="menuitem"
            className="edit-context-item edit-context-ask"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onAskAi();
              onClose();
            }}
          >
            <span className="edit-context-icon">🤖</span>
            <span className="edit-context-label">问 AI</span>
            <span className="edit-context-hint">打开侧栏并填入问题</span>
          </button>
        </div>
      )}

      {linkMode && (
        <div className="edit-context-linkrow">
          <input
            ref={linkInputRef}
            value={linkValue}
            placeholder="https://链接地址"
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkMode(false);
              }
            }}
          />
          <button type="button" className="btn small-btn" onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>
            确定
          </button>
        </div>
      )}

      {hint && <div className="edit-context-hintline">{hint}</div>}
    </div>
  );
}
