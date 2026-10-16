// @vitest-environment jsdom
// SPEC §5.2 rule 13 / §9.4：手动建卡必须能写"长/图题面 + 结构化答案"——
// 题面走 add_card 的 frontMd 参数，标题可留空（由题面投影生成）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import AddCardPage from "./AddCardPage";

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

/** 渲染添加卡片页；探针记录保存期间发出的命令。 */
async function renderAndCapture(): Promise<{
  dom: HTMLDivElement;
  save: () => Promise<Call[]>;
}> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const dom = container;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<AddCardPage onBack={() => {}} onSaved={() => {}} />);
  });
  await settle();

  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => unknown };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");

  const save = async (): Promise<Call[]> => {
    const original = internals.invoke;
    const calls: Call[] = [];
    internals.invoke = (cmd: string, args?: unknown) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return original(cmd, args);
    };
    try {
      const button = [...dom.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("保存并新建下一张"),
      );
      await act(async () => {
        (button as HTMLButtonElement).click();
      });
      await settle();
    } finally {
      internals.invoke = original;
    }
    return calls;
  };

  return { dom, save };
}

/** 按 label 文本找到对应的输入控件（题面 / 要点都是 textarea）。 */
function fieldByLabel(dom: HTMLElement, label: string): HTMLTextAreaElement | HTMLInputElement {
  const row = [...dom.querySelectorAll(".form-row")].find((r) =>
    (r.querySelector("label")?.textContent ?? "").startsWith(label),
  );
  const el = row?.querySelector("textarea, input");
  if (!el) throw new Error(`找不到「${label}」输入控件`);
  return el as HTMLTextAreaElement | HTMLInputElement;
}

function setValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("添加卡片页的题面入口（rule 13）", () => {
  it("题面作为 frontMd 传给 add_card，标题留空由后端投影生成", async () => {
    const { dom, save } = await renderAndCapture();
    await act(async () => {
      setValue(fieldByLabel(dom, "章节"), "LeetCode");
      setValue(fieldByLabel(dom, "题面"), "设计一个满足 LRU 约束的数据结构");
    });

    const calls = await save();
    const add = calls.find((c) => c.cmd === "add_card");
    expect(add, "应调用 add_card").toBeTruthy();
    expect(add!.args.frontMd).toBe("设计一个满足 LRU 约束的数据结构");
    expect(add!.args.title).toBe("");
    expect(dom.textContent).not.toContain("请填写题面或标题");
  });

  it("题面与标题都空时拒绝保存并提示", async () => {
    const { dom, save } = await renderAndCapture();
    const calls = await save();
    expect(calls.some((c) => c.cmd === "add_card")).toBe(false);
    expect(dom.textContent).toContain("请填写题面或标题");
  });

  it("「刷题模板」把思路/复杂度/易错点预填进背面", async () => {
    const { dom } = await renderAndCapture();
    const template = [...dom.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("刷题模板"),
    );
    expect(template, "应有刷题模板按钮").toBeTruthy();
    await act(async () => {
      (template as HTMLButtonElement).click();
    });

    const back = fieldByLabel(dom, "要点") as HTMLTextAreaElement;
    expect(back.value).toContain("**思路**");
    expect(back.value).toContain("**复杂度**");
    expect(back.value).toContain("**易错点**");
  });
});
