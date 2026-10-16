// @vitest-environment jsdom
// SPEC §5.5：粘贴一大段文本 → 一次导入多张卡。测的是这一页真正接上后端的部分：
// 预览数字、卡片样例、以及 import_markdown 收到的虚拟文件内容。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import ImportPage from "./ImportPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(ms = 260) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeAll(() => {
  installMockBackend();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

type Call = { cmd: string; args: Record<string, unknown> };

async function renderPasteTab(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<ImportPage onBack={() => {}} onDone={() => {}} />);
  });
  await settle();
  const tab = [...dom.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("粘贴文本"),
  );
  if (!tab) throw new Error("找不到「粘贴文本」页签");
  await act(async () => {
    (tab as HTMLButtonElement).click();
  });
  return dom;
}

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function paste(dom: HTMLElement, text: string) {
  const ta = dom.querySelector("textarea.paste-input") as HTMLTextAreaElement | null;
  if (!ta) throw new Error("找不到粘贴文本框");
  await act(async () => {
    setTextarea(ta, text);
  });
}

/** 点「导入 N 张卡」，同时记录这一下发出的 Tauri 命令。 */
async function importCards(dom: HTMLElement): Promise<Call[]> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => unknown };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  const button = [...dom.querySelectorAll("button")].find((b) =>
    /^导入 \d+ 张卡$/.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error("找不到导入按钮");
  const original = internals.invoke;
  const calls: Call[] = [];
  internals.invoke = (cmd: string, args?: unknown) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return original(cmd, args);
  };
  try {
    await act(async () => {
      button.click();
    });
    await settle();
  } finally {
    internals.invoke = original;
  }
  return calls;
}

function selectedDeck(dom: HTMLElement): string {
  return (dom.querySelector("select") as HTMLSelectElement).value;
}

const PASTE = "## 事务\n\n### ACID 是什么？\n- **原子性**：不可分割\n\n### 隔离级别有哪些？\n1. 读未提交\n";

describe("导入页的粘贴模式（SPEC §5.5）", () => {
  it("粘贴后立刻显示章节/卡片数与卡片样例", async () => {
    const dom = await renderPasteTab();
    await paste(dom, PASTE);
    expect(dom.textContent).toContain("1 个章节 · 2 张卡");
    expect(dom.textContent).toContain("事务 · ACID 是什么？");
    expect(dom.textContent).toContain("事务 · 隔离级别有哪些？");
  });

  it("导入命令收到的是补了卡包标题的虚拟 .md（文字原样保留）", async () => {
    const dom = await renderPasteTab();
    await paste(dom, PASTE);
    const deck = selectedDeck(dom);
    expect(deck).toBeTruthy();

    const calls = await importCards(dom);
    const call = calls.find((c) => c.cmd === "import_markdown");
    expect(call, "应调用 import_markdown").toBeTruthy();
    const files = call!.args.files as { name: string; content: string }[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe(`${deck}.md`);
    expect(files[0].content).toBe(`# ${deck}\n\n${PASTE}`);
    // 导入完成后给出报告并清空文本框，避免同一段被贴两次。
    expect(dom.textContent).toContain("导入完成");
    expect((dom.querySelector("textarea.paste-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("没有任何标题的段落：补上「未分类」章节，成为一张题面卡并提示", async () => {
    const dom = await renderPasteTab();
    await paste(dom, "什么是事务？\n事务是一组不可分割的操作。\n");
    expect(dom.textContent).toContain("1 张卡");
    expect(dom.textContent).toContain("###");
    expect(dom.textContent).toContain("未分类 · 什么是事务？");

    const deck = selectedDeck(dom);
    const calls = await importCards(dom);
    const files = (calls.find((c) => c.cmd === "import_markdown")!.args.files as {
      content: string;
    }[]);
    expect(files[0].content).toBe(
      `# ${deck}\n\n## 未分类\n\n什么是事务？\n事务是一组不可分割的操作。\n`,
    );
  });

  it("文本自带 `# 卡包` 时原样导入，不再补标题", async () => {
    const dom = await renderPasteTab();
    const text = "# 我的卡包\n\n### 卡\n要点\n";
    await paste(dom, text);
    expect(dom.textContent).toContain("卡包：我的卡包");
    const calls = await importCards(dom);
    const files = (calls.find((c) => c.cmd === "import_markdown")!.args.files as {
      content: string;
    }[]);
    expect(files[0].content).toBe(text);
  });

  it("没粘贴内容时导入按钮不可点", async () => {
    const dom = await renderPasteTab();
    const button = [...dom.querySelectorAll("button")].find((b) =>
      /^导入 \d+ 张卡$/.test((b.textContent ?? "").trim()),
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
