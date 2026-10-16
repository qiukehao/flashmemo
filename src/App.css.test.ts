// App.css 的契约测试：图片放大预览（需求 1 / SPEC §5.4）依赖的类名与关键声明。
// 样式写在 App.css 里，这里把 CSS 当文本解析后逐条断言，防止后续改动悄悄破坏布局契约。
// 用 readFileSync 而不是 `?raw` 导入：vitest 默认 css:false，会把 CSS 模块替换成空字符串。
// @ts-expect-error 本仓库未安装 @types/node，测试跑在 Node 上，这里直接读源文件文本。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss: string = readFileSync(new URL("./App.css", import.meta.url), "utf8");

type Rule = { selector: string; body: string };
type Declaration = { property: string; value: string };

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 只切顶层规则；@media 之类的嵌套块整体算一条规则，不参与本文件的断言。 */
function topLevelRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let prelude = "";
  let body = "";
  for (const char of text) {
    if (char === "{") {
      depth += 1;
      if (depth === 1) body = "";
      else body += char;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({ selector: normalize(prelude), body });
        prelude = "";
      } else {
        body += char;
      }
      continue;
    }
    if (depth === 0) prelude += char;
    else body += char;
  }
  return rules;
}

function declarations(body: string): Declaration[] {
  const result: Declaration[] = [];
  for (const chunk of body.split(";")) {
    const separator = chunk.indexOf(":");
    if (separator < 0) continue;
    const property = chunk.slice(0, separator).trim().toLowerCase();
    const value = normalize(chunk.slice(separator + 1));
    if (!property || !value) continue;
    result.push({ property, value });
  }
  return result;
}

const rules = topLevelRules(appCss);

/** 同名属性声明多次时（渐进增强的 fallback）保留全部值，按书写顺序。 */
function valuesOf(selector: string, property: string): string[] {
  const found: string[] = [];
  for (const rule of rules) {
    if (rule.selector !== selector) continue;
    for (const declaration of declarations(rule.body)) {
      if (declaration.property === property) found.push(declaration.value);
    }
  }
  return found;
}

/** 生效值 = 最后一条声明（浏览器同样如此）。 */
function valueOf(selector: string, property: string): string | undefined {
  const found = valuesOf(selector, property);
  return found.length ? found[found.length - 1] : undefined;
}

function declaredProperties(selector: string): string[] {
  const found = new Set<string>();
  for (const rule of rules) {
    if (rule.selector !== selector) continue;
    for (const declaration of declarations(rule.body)) found.add(declaration.property);
  }
  return [...found];
}

// ImageLightbox.tsx 渲染的 DOM 用到的类名（组件侧不可改名）。
const LIGHTBOX_SELECTORS = [
  ".image-lightbox",
  ".image-lightbox-stage",
  ".image-lightbox-img",
  ".image-lightbox-bar",
  ".image-lightbox-zoom",
  ".image-lightbox-btn",
  ".image-lightbox-btn.close",
];

describe("卡面图片放大预览样式（需求 1 / SPEC §5.4）", () => {
  it("组件用到的每个类名都有对应规则", () => {
    for (const selector of LIGHTBOX_SELECTORS) {
      expect(declaredProperties(selector), `${selector} 缺少样式规则`).not.toHaveLength(0);
    }
  });

  it("遮罩固定铺满视口，自身不产生滚动条", () => {
    expect(valueOf(".image-lightbox", "position")).toBe("fixed");
    expect(valueOf(".image-lightbox", "inset")).toBe("0");
    expect(Number(valueOf(".image-lightbox", "z-index"))).toBeGreaterThanOrEqual(90);
    expect(valueOf(".image-lightbox", "display")).toBe("grid");
    expect(valueOf(".image-lightbox", "place-items")).toBe("center");
    expect(valueOf(".image-lightbox", "overflow")).toBe("hidden");
    expect(valueOf(".image-lightbox", "background")).toMatch(/^rgba?\(/);
  });

  it("放大后的滚动发生在遮罩内部：stage 限制在视口内且 overflow 为 auto", () => {
    expect(valueOf(".image-lightbox-stage", "max-width")).toBe("100vw");
    expect(valueOf(".image-lightbox-stage", "max-height")).toBe("100vh");
    expect(valueOf(".image-lightbox-stage", "overflow")).toBe("auto");
    expect(valueOf(".image-lightbox-stage", "display")).toBe("grid");
    // 溢出时退回 start 对齐，否则放大后图片左侧/顶部会落在不可滚动的溢出区。
    expect(valuesOf(".image-lightbox-stage", "place-items")).toEqual(["center", "safe center"]);
  });

  it("图片用 CSS 变量缩放，而不是 transform: scale()", () => {
    expect(valueOf(".image-lightbox-img", "width")).toBe("auto");
    expect(valueOf(".image-lightbox-img", "height")).toBe("auto");
    expect(valueOf(".image-lightbox-img", "max-width")).toBe(
      "calc((100vw - 48px) * var(--lightbox-zoom, 1))",
    );
    expect(valueOf(".image-lightbox-img", "max-height")).toBe(
      "calc((100vh - 72px) * var(--lightbox-zoom, 1))",
    );
    // transform 不产生可滚动溢出：一旦用 scale 放大，图片边缘既滚不到也点不到。
    expect(valueOf(".image-lightbox-img", "transform")).toBeUndefined();
  });

  it("工具条固定在底部居中，缩放数字不左右跳动", () => {
    expect(valueOf(".image-lightbox-bar", "position")).toBe("fixed");
    expect(valueOf(".image-lightbox-bar", "bottom")).toBe("18px");
    expect(valueOf(".image-lightbox-bar", "left")).toBe("50%");
    expect(valueOf(".image-lightbox-bar", "transform")).toBe("translateX(-50%)");
    expect(valueOf(".image-lightbox-bar", "display")).toBe("flex");
    expect(valueOf(".image-lightbox-bar", "align-items")).toBe("center");
    expect(valueOf(".image-lightbox-bar", "gap")).toBe("6px");
    expect(valueOf(".image-lightbox-bar", "border-radius")).toBe("999px");
    expect(valueOf(".image-lightbox-zoom", "min-width")).toBe("52px");
    expect(valueOf(".image-lightbox-zoom", "text-align")).toBe("center");
    expect(valueOf(".image-lightbox-zoom", "font-variant-numeric")).toBe("tabular-nums");
  });

  it("按钮 32×32，hover 有反馈，关闭键有强调", () => {
    expect(valueOf(".image-lightbox-btn", "width")).toBe("32px");
    expect(valueOf(".image-lightbox-btn", "height")).toBe("32px");
    expect(valueOf(".image-lightbox-btn", "cursor")).toBe("pointer");
    expect(valueOf(".image-lightbox-btn:hover", "background")).toBeTruthy();
    expect(valueOf(".image-lightbox-btn.close", "color")).toBeTruthy();
  });
});

describe("卡面图片光标语义（编辑态不暗示单击放大）", () => {
  it("只读渲染仍是 zoom-in", () => {
    expect(valueOf("img.card-image", "cursor")).toBe("zoom-in");
  });

  it("contenteditable 编辑区内是 default（单击留给光标/选区/右键批注）", () => {
    expect(valueOf(".popup-edit-wysiwyg img.card-image", "cursor")).toBe("default");
  });
});

/** 媒体查询块内部的规则（与顶层同一套解析）。 */
function rulesInBlock(atRulePrefix: string): Rule[] {
  const block = rules.find((rule) => rule.selector.startsWith(atRulePrefix));
  return block ? topLevelRules(block.body) : [];
}

function blockValueOf(atRulePrefix: string, selector: string, property: string): string | undefined {
  const found: string[] = [];
  for (const rule of rulesInBlock(atRulePrefix)) {
    if (rule.selector !== selector) continue;
    for (const declaration of declarations(rule.body)) {
      if (declaration.property === property) found.push(declaration.value);
    }
  }
  return found.length ? found[found.length - 1] : undefined;
}

// 需求 3 / SPEC §15.2：卡包工作区两列独立滚动。
// 滚动容器归属：.deck-workspace 只分栏（overflow:hidden，不是滚动容器）；
// 真正的滚动容器是 .deck-workspace-list 与 .deck-workspace-detail。
describe("卡包工作区两列独立滚动（需求 3 / SPEC §15.2）", () => {
  it("页面撑满内容区，工作区只负责分栏、本身不滚动", () => {
    expect(valueOf(".deck-workspace-page", "display")).toBe("flex");
    expect(valueOf(".deck-workspace-page", "flex-direction")).toBe("column");
    // 定高来源：撑满 .shell-main 的内容区，主窗口才不会出现整页滚动条。
    expect(valueOf(".deck-workspace-page", "height")).toBe("100%");
    expect(valueOf(".deck-workspace", "flex")).toBe("1 1 auto");
    expect(valueOf(".deck-workspace", "min-height")).toBe("0");
    expect(valueOf(".deck-workspace", "overflow")).toBe("hidden");
    // 没有这两条，隐式行会被内容撑高，列内 overflow 永不触发、超出部分被裁掉。
    expect(valueOf(".deck-workspace", "grid-template-rows")).toBe("minmax(0, 1fr)");
  });

  it("两列各自是滚动容器（互不嵌套）", () => {
    expect(valueOf(".deck-workspace-list", "overflow-y")).toBe("auto");
    expect(valueOf(".deck-workspace-list", "min-height")).toBe("0");
    expect(valueOf(".deck-workspace-detail", "overflow-y")).toBe("auto");
    expect(valueOf(".deck-workspace-detail", "min-height")).toBe("0");
  });

  it("窄宽度退化为单列：交回整页滚动，只留列表一层定高滚动", () => {
    const mobile = "@media (max-width: 820px)";
    expect(blockValueOf(mobile, ".deck-workspace-page", "height")).toBe("auto");
    expect(blockValueOf(mobile, ".deck-workspace", "grid-template-columns")).toBe("1fr");
    expect(blockValueOf(mobile, ".deck-workspace", "grid-template-rows")).toBe("auto");
    expect(blockValueOf(mobile, ".deck-workspace", "flex")).toBe("none");
    // 编辑面板不再有第二层滚动条。
    expect(blockValueOf(mobile, ".deck-workspace-detail", "overflow-y")).toBe("visible");
    expect(blockValueOf(mobile, ".deck-workspace-list", "max-height")).toBe("300px");
  });
});

// 需求 2 / SPEC §11.1：共享的关联卡片选择器（CardLinkPicker，弹窗与主窗口共用）。
// 这里只锁「类名存在 + 关键约束」，颜色细节可自由调。
describe("关联卡片选择器样式（需求 2 / SPEC §11.1）", () => {
  const SELECTORS = [
    ".link-editor.compact",
    ".link-chip-title",
    ".link-chip-btn",
    ".link-chip-btn.danger",
    ".link-chip-confirm",
    ".link-chip-cancel",
    ".link-chip.rebinding",
    ".link-add-toggle",
    ".link-search",
    ".link-rebind-hint",
    ".popup-panel",
    ".popup-panel-head",
    ".popup-panel-close",
    ".popup-panel-scrim",
    ".popup-links .link-editor",
    ".popup-link-auto",
    ".popup-link-unlink",
    ".popup-link-confirm",
    ".popup-context-auto",
    ".popup-context-head",
  ];

  it("组件用到的每个类名都有对应规则", () => {
    for (const selector of SELECTORS) {
      expect(declaredProperties(selector), `${selector} 缺少样式规则`).not.toHaveLength(0);
    }
  });

  it("弹窗里的选择器收紧字号，长标题截断而不是撑爆一行", () => {
    expect(valueOf(".link-editor.compact", "font-size")).toBe("12px");
    expect(valueOf(".link-chip-title", "max-width")).toBe("22em");
    expect(valueOf(".link-chip-title", "overflow")).toBe("hidden");
    expect(valueOf(".link-chip-title", "text-overflow")).toBe("ellipsis");
    expect(valueOf(".link-chip-title", "white-space")).toBe("nowrap");
  });

  it("芯片内小按钮 24×24，改绑态有描边高亮", () => {
    expect(valueOf(".link-chip-btn", "width")).toBe("24px");
    expect(valueOf(".link-chip-btn", "height")).toBe("24px");
    expect(valueOf(".link-chip-btn", "cursor")).toBe("pointer");
    expect(valueOf(".link-chip-btn:hover", "background")).toBeTruthy();
    expect(valueOf(".link-chip-btn.danger", "color")).toBeTruthy();
    expect(valueOf(".link-chip.rebinding", "border-color")).toBeTruthy();
  });

  it("顶栏浮层：宽版 + 遮罩，自己滚动，不挤掉卡面", () => {
    expect(valueOf(".popup-panel", "position")).toBe("fixed");
    expect(valueOf(".popup-panel", "width")).toBe("min(600px, calc(100vw - 32px))");
    expect(valueOf(".popup-panel", "overflow")).toBe("auto");
    expect(valueOf(".popup-panel-head", "display")).toBe("flex");
    expect(valueOf(".popup-panel-head", "justify-content")).toBe("space-between");
    expect(valueOf(".popup-panel-close", "cursor")).toBe("pointer");
    expect(valueOf(".popup-panel-scrim", "position")).toBe("fixed");
    expect(valueOf(".popup-links .link-editor", "max-height")).toBe("46vh");
    expect(valueOf(".popup-links .link-editor", "overflow")).toBe("auto");
  });

  it("改绑提示条是 flex 行，标题行左右分栏", () => {
    expect(valueOf(".link-rebind-hint", "display")).toBe("flex");
    expect(valueOf(".link-rebind-hint", "align-items")).toBe("center");
    expect(valueOf(".link-rebind-hint", "gap")).toBe("8px");
    expect(valueOf(".popup-context-head", "display")).toBe("flex");
    expect(valueOf(".popup-context-head", "justify-content")).toBe("space-between");
  });

  it("这批新规则不含 !important（沿用现有配色变量，不做主题分支）", () => {
    for (const rule of rules) {
      const isMine =
        rule.selector.includes("link-") ||
        rule.selector.includes("popup-link") ||
        rule.selector.includes("popup-context-auto") ||
        rule.selector.includes("popup-context-head");
      if (!isMine) continue;
      expect(rule.body.includes("!important"), `${rule.selector} 用了 !important`).toBe(false);
    }
  });
});


// ---------------------------------------------------------------- 2026-10-07 批量反馈
describe("2026-10-07 反馈修复的样式契约", () => {
  /** 表格规则是逗号长选择器列表，按「选择器串里包含目标」查找其声明。 */
  function declarationFor(selectorPart: string, property: string): string | undefined {
    for (const rule of rules) {
      if (!rule.selector.includes(selectorPart)) continue;
      for (const declaration of declarations(rule.body)) {
        if (declaration.property === property) return declaration.value;
      }
    }
    return undefined;
  }

  it("卡面表格有边框线（表格线渲染缺失的修复）", () => {
    for (const container of [
      ".popup-front th",
      ".popup-front-rich th",
      ".popup-edit-wysiwyg th",
      ".popup-panel th",
      ".workspace-wysiwyg th",
      ".workspace-front th",
      ".preview-pane th",
      ".popup-front td",
      ".popup-edit-wysiwyg td",
      ".preview-pane td",
    ]) {
      expect(declarationFor(container, "border"), `${container} border`).toBeTruthy();
    }
    expect(declarationFor(".popup-edit-wysiwyg table", "border-collapse")).toBe("collapse");
  });

  it("备注：编辑器里收成摘要条（focus 展开全文），浮层挂在 body", () => {
    expect(valueOf(".popup-edit-wysiwyg .card-note", "white-space")).toBe("nowrap");
    expect(valueOf(".popup-edit-wysiwyg .card-note:focus-within", "white-space")).toBe("normal");
    expect(valueOf(".note-popover", "position")).toBe("fixed");
    expect(valueOf(".note-popover", "z-index")).toBe("90");
  });

  it("关联卡片红点 + 收起答案 + 顺链计数提示", () => {
    expect(valueOf(".popup-link-dot", "position")).toBe("absolute");
    expect(valueOf(".popup-link-dot", "background")).toBeTruthy();
    expect(valueOf(".popup-back-tools", "display")).toBe("flex");
    expect(valueOf(".popup-chain-note", "color")).toBeTruthy();
  });

  it("strict 徽标与关闭确认条已归位到主样式表（原来误写在 src-tauri/src/App.css）", () => {
    expect(valueOf(".popup-strict-badge", "border-radius")).toBeTruthy();
    expect(valueOf(".popup-confirm-close", "display")).toBe("flex");
  });

  it("AI 独立窗口页面样式（原内嵌侧栏坞样式已删）", () => {
    expect(valueOf(".ai-window", "height")).toBe("100vh");
    expect(valueOf(".ai-window-head", "display")).toBe("flex");
    expect(valueOf(".ai-webview-slot", "flex")).toBe("1");
    // 窗口自己不带 DWM 阴影（src-tauri/src/ai.rs 里 shadow(false)，否则那一圈
    // 阴影会糊在卡面上），两扇窗之间的分界靠这条 1px 线（2026-10-10）。
    expect(valueOf(".ai-window", "border-left")).toBe("1px solid var(--line)");
    // 死代码清理：ai-dock / popup-ai-divider / ai-open 不应再存在。
    expect(rules.some((r) => r.selector.includes("ai-dock"))).toBe(false);
    expect(rules.some((r) => r.selector.includes("popup-ai-divider"))).toBe(false);
    expect(rules.some((r) => r.selector.includes("ai-open"))).toBe(false);
  });
});
