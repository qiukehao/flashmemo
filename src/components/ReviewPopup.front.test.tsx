// @vitest-environment jsdom
// 需求7（SPEC §5.2 / §9.2）：图片型 / 长题干卡面在复习弹窗里的展示。
// 要点：① 富题面用同一套 Markdown 渲染器（图片 + 多行）；② 图片走 F1 的灯箱，
// **不重复实现**预览；③ 单行纯文本题面保持原样（旧卡观感与既有行为不变）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installMockBackend } from "../lib/mockBackend";
import { registerMockAttachment } from "../lib/attachments";
import ReviewPopup from "./ReviewPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C1 = 1;
const DATA_URL = "data:image/png;base64,AAAA";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoke(): Invoke {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("mock 后端未安装");
  return internals.invoke;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, what = "条件", timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await settle(60);
  }
  throw new Error(`waitFor 超时：${what}`);
}

async function mountPopup(ms = 300): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const dom = host;
  root = createRoot(dom);
  await act(async () => {
    root?.render(<ReviewPopup />);
  });
  await settle(ms);
  await waitFor(() => dom.querySelector(".popup-front") !== null, "题面");
  return dom;
}

/** 把示例卡 1 改造成需求7 的形态（mock 的卡对象就是 CardDto，title 即正面）。 */
async function setFront(title: string, contentMd = "答案要点"): Promise<void> {
  await invoke()("update_card", { cardId: C1, title, contentMd });
}

/** 需求7 的真形态：题面在 `front_md` 里，`title` 只当身份键/列表标签。 */
async function setFrontMd(frontMd: string, title: string, contentMd = "答案要点"): Promise<void> {
  await invoke()("update_card", { cardId: C1, title, contentMd, frontMd });
}

beforeAll(() => {
  installMockBackend();
});

beforeEach(() => {
  registerMockAttachment("front-shot.png", DATA_URL);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("图片型 / 长题干题面（需求7）", () => {
  it("单行纯文本题面保持原样（旧卡观感不变）", async () => {
    await setFront("事务的隔离级别有哪些？");
    const dom = await mountPopup();
    const front = dom.querySelector(".popup-front")!;
    expect(front.textContent).toBe("事务的隔离级别有哪些？");
    expect(front.querySelector("img")).toBeNull();
  }, 20000);

  it("图片型题面渲染成卡面图片，点击走 F1 的灯箱（不重复实现预览）", async () => {
    await setFront("![题目](attachment:front-shot.png)");
    const dom = await mountPopup();

    const img = dom.querySelector<HTMLImageElement>(".popup-front img.card-image");
    expect(img, "题面应渲染出卡面图片").toBeTruthy();
    expect(img!.getAttribute("src")).toBe(DATA_URL);

    await act(async () => {
      img!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(150);

    const lightbox = document.querySelector(".image-lightbox");
    expect(lightbox, "题面图片应打开 F1 的灯箱").toBeTruthy();
    expect(document.querySelector(".image-lightbox-img")?.getAttribute("src")).toBe(DATA_URL);
  }, 20000);

  it("图 + 短标题：图片与文字都在题面里", async () => {
    await setFront("![题目](attachment:front-shot.png)\n\n两数之和");
    const dom = await mountPopup();
    expect(dom.querySelector(".popup-front img.card-image")).toBeTruthy();
    expect(dom.querySelector(".popup-front")!.textContent).toContain("两数之和");
  }, 20000);

  it("长题干渲染成多个段落，而不是被压成一行", async () => {
    await setFront(
      "给定一个整数数组 nums 和一个整数目标值 target。\n\n请你在该数组中找出和为目标值的那两个整数，并返回它们的下标。",
    );
    const dom = await mountPopup();
    const front = dom.querySelector(".popup-front")!;
    expect(front.querySelectorAll("p").length).toBe(2);
    expect(front.textContent).toContain("target");
    expect(front.textContent).toContain("返回它们的下标");
    // 题面不进 contenteditable：背面编辑器仍然只有一个。
    expect(dom.querySelectorAll('[contenteditable="true"]').length).toBeLessThanOrEqual(1);
  }, 20000);

  // 下面两条是需求7 的**真形态**：Rust 现在返回 `CardDto.frontMd`（迁移 v8），
  // 浏览器 mock 也会透传它 —— 所以 t11 里"Rust 返回字段后展示侧零改动生效"
  // 这句话从单元级升级成集成级证据。
  it("frontMd 优先：title 只当标签，题面渲染 front_md（图片 + 长题干）", async () => {
    await setFrontMd(
      "![题目](attachment:front-shot.png)\n\n给定一个整数数组 nums 和一个目标值 target。",
      "两数之和",
    );
    const dom = await mountPopup();

    const front = dom.querySelector(".popup-front")!;
    expect(front.querySelector<HTMLImageElement>("img.card-image")?.getAttribute("src")).toBe(DATA_URL);
    expect(front.textContent).toContain("target");
    // 题面不是 title 本身（否则说明仍走旧路径）。
    expect(front.textContent).not.toBe("两数之和");

    await act(async () => {
      front
        .querySelector("img.card-image")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(150);
    expect(document.querySelector(".image-lightbox"), "front_md 里的图片同样走 F1 灯箱").toBeTruthy();
  }, 20000);

  it("背面编辑保存不会动题面（与 Rust 的 COALESCE(?4, front_md) 互为镜像）", async () => {
    const frontMd = "![题目](attachment:front-shot.png)";
    await setFrontMd(frontMd, "标签", "答案要点");
    const dom = await mountPopup();

    await act(async () => {
      [...dom.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").includes("显示答案"))!
        .click();
    });
    await settle(150);

    const editor = dom.querySelector<HTMLElement>(".popup-edit-wysiwyg")!;
    await act(async () => {
      editor.innerHTML = "<p>答案要点</p><p>我加的批注</p>";
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await settle(1300); // 800ms 防抖 + mock 80ms

    const card = (await invoke()("get_card", { cardId: C1 })) as {
      frontMd?: string;
      contentMd?: string;
    };
    expect(card.contentMd, "背面编辑应落盘").toContain("我加的批注");
    expect(card.frontMd, "保存背面绝不能把题面抹掉").toBe(frontMd);
  }, 20000);
});
