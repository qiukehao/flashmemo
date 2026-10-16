import { describe, expect, it } from "vitest";
import { registerMockAttachment } from "./attachments";
import { frontLabel, frontMarkdown, isRichFront, renderCard } from "./markdown";
import { frontTitleProjection } from "./markdownImport";

describe("renderCard", () => {
  it("renders lists, bold and tables", () => {
    const html = renderCard("- **原子性**：不可分割\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<strong>原子性</strong>");
    expect(html).toContain("<table>");
  });

  it("renders ==highlight== via markdown-it-mark", () => {
    expect(renderCard("这是 ==重点== 内容")).toContain("<mark>重点</mark>");
  });

  it("renders %%remark%% as the card-note block (SPEC §9.1)", () => {
    const html = renderCard("正文 %%这里是我的备注%% 结尾");
    expect(html).toContain('class="card-note"');
    expect(html).toContain("📝");
    expect(html).toContain("这里是我的备注");
    expect(html).not.toContain("%%");
  });

  it("renders markdown inside a remark", () => {
    const html = renderCard("%%注意 **这个词**%%");
    expect(html).toContain('class="card-note"');
    expect(html).toContain("<strong>这个词</strong>");
  });

  it("leaves a lone %% untouched", () => {
    expect(renderCard("折扣 50% 起")).toContain("50%");
  });

  it("syntax-highlights fenced code blocks", () => {
    const html = renderCard("```js\nconst a = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("hljs-keyword");
  });

  it("renders Obsidian callouts with icon, title and body", () => {
    const html = renderCard("> [!note] 傻瓜讲解\n> 可以把事务想象成一次银行转账。");
    expect(html).toContain('class="callout callout-note"');
    expect(html).toContain("📘");
    expect(html).toContain("傻瓜讲解");
    expect(html).toContain("可以把事务想象成一次银行转账。");
    expect(html).not.toContain("[!note]");
  });

  it("handles uppercase markers and marker-only first lines", () => {
    const html = renderCard("> [!NOTE] ✏️ 面试回答\n>\n> **要点**：内容");
    expect(html).toContain("callout-note");
    expect(html).toContain("✏️ 面试回答");
    expect(html).toContain("<strong>要点</strong>");
    expect(html).not.toContain("[!NOTE]");
  });

  it("uses a default title when the marker has none", () => {
    const html = renderCard("> [!warning]\n> 注意这里");
    expect(html).toContain("callout-warning");
    expect(html).toContain("注意");
  });

  it("leaves plain blockquotes untouched", () => {
    const html = renderCard("> 普通引用");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
  });

  it("renders adjacent callouts as siblings, not nested", () => {
    const html = renderCard(
      "> [!note] 傻瓜讲解\n> 正文一\n\n> [!NOTE] 面试回答\n>\n> 正文二",
    );
    expect(html.match(/class="callout /g)?.length).toBe(2);
    // Two sibling divs: the rendered HTML must close the first before the second opens.
    const firstClose = html.indexOf("</div>");
    const secondOpen = html.indexOf('class="callout callout-note"', firstClose);
    expect(secondOpen).toBeGreaterThan(firstClose);
    expect(html).not.toContain("<div class=\"callout callout-note\"><div class=\"callout callout-note\">");
  });

  it("escapes raw html for safety", () => {
    const html = renderCard('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // ---- Full syntax matrix (2026-10-03 audit, task: 「是否所有 markdown 语法都支持」) ----

  it("renders headings level 1 through 6", () => {
    for (let level = 1; level <= 6; level++) {
      const html = renderCard(`${"#".repeat(level)} 标题${level}`);
      expect(html).toContain(`<h${level}>标题${level}</h${level}>`);
    }
  });

  it("renders emphasis: bold, italic, bold-italic, strikethrough", () => {
    expect(renderCard("**粗体**")).toContain("<strong>粗体</strong>");
    expect(renderCard("*斜体*")).toContain("<em>斜体</em>");
    const bi = renderCard("***全都要***");
    expect(bi).toContain("<strong>");
    expect(bi).toContain("<em>");
    expect(bi).toContain("全都要");
    // markdown-it renders GFM strikethrough with <s>, not <del>.
    expect(renderCard("~~删除线~~")).toContain("<s>删除线</s>");
  });

  it("renders inline code without interpreting markdown inside", () => {
    const html = renderCard("运行 `npm run **dev**` 命令");
    expect(html).toContain("<code>npm run **dev**</code>");
  });

  it("renders ordered, unordered and nested lists", () => {
    expect(renderCard("1. 第一\n2. 第二")).toContain("<ol>");
    expect(renderCard("- 甲\n- 乙")).toContain("<ul>");
    const nested = renderCard("- 甲\n  - 甲一\n  - 甲二\n- 乙");
    expect(nested).toContain("<ul>");
    expect((nested.match(/<ul>/g) ?? []).length).toBe(2);
  });

  it("renders GFM task lists as checkboxes", () => {
    const html = renderCard("- [x] 已完成的事\n- [ ] 还没做的事");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("已完成的事");
    expect(html).toContain("还没做的事");
  });

  it("renders links, autolinks and reference links", () => {
    expect(renderCard("[官网](https://example.com)")).toContain('<a href="https://example.com">');
    // Bare URLs become links (linkify: true).
    expect(renderCard("看 https://example.com/docs 就懂了")).toContain('<a href="https://example.com/docs">');
    // Reference style, used by the real notes as [\[注\]].
    const ref = renderCard("见 [注][1]。\n\n[1]: https://example.com/ref");
    expect(ref).toContain('<a href="https://example.com/ref">注</a>');
  });

  it("renders horizontal rules", () => {
    expect(renderCard("上\n\n---\n\n下")).toContain("<hr>");
  });

  describe("card images (SPEC §5.4)", () => {
    it("resolves attachment refs to a loadable src and keeps the markdown", () => {
      registerMockAttachment("abc.png", "data:image/png;base64,AAAA");
      const html = renderCard("![示意图](attachment:abc.png)");
      expect(html).toContain('src="data:image/png;base64,AAAA"');
      expect(html).toContain('data-md-raw="![示意图](attachment:abc.png)"');
      expect(html).toContain('class="card-image"');
    });

    it("keeps the title when re-rendering an attachment", () => {
      registerMockAttachment("t.png", "data:image/png;base64,AAAA");
      const html = renderCard('![图](attachment:t.png "标题")');
      expect(html).toContain("data-md-raw=");
      expect(html).toContain("attachment:t.png");
      expect(html).toContain("标题");
    });

    it("shows a placeholder for a ref that cannot be resolved", () => {
      const html = renderCard("![缺图](images/nope.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain("card-image-missing");
      expect(html).toContain("图片未找到");
      expect(html).toContain("images/nope.png");
    });

    it("blocks remote images instead of leaking a network request", () => {
      const html = renderCard("![远程](https://example.com/a.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain("远程图片未加载");
    });

    it("refuses attachment refs that try to escape the store", () => {
      const html = renderCard("![逃逸](attachment:../secret.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain("card-image-missing");
    });
  });

  it("renders footnotes with refs and a definition section", () => {
    const html = renderCard("B+ 树是[^1]常见索引。\n\n[^1]: 一种平衡多路搜索树。");
    expect(html).toContain("footnote-ref");
    expect(html).toContain("footnotes");
    expect(html).toContain("一种平衡多路搜索树。");
  });

  it("renders inline html-ish entities safely", () => {
    expect(renderCard("a &lt; b")).toContain("a &lt; b");
    expect(renderCard("5 & 6")).toContain("&amp;");
  });

  // 需求7（SPEC §5.2）：题面（正面）不再是"一行纯文本标题"。
  describe("题面 / 图片型与长题干（需求7）", () => {
    it("frontMarkdown：front_md 优先，缺省退回 title（旧卡行为不变）", () => {
      expect(frontMarkdown("事务的隔离级别有哪些？")).toBe("事务的隔离级别有哪些？");
      expect(frontMarkdown("标签", "")).toBe("标签");
      expect(frontMarkdown("标签", "   ")).toBe("标签");
      expect(frontMarkdown("标签", "![题](attachment:a.png)")).toBe("![题](attachment:a.png)");
    });

    it("isRichFront：只在含图片引用或换行时为真（纯文本保持旧样式）", () => {
      expect(isRichFront("事务的隔离级别有哪些？")).toBe(false);
      expect(isRichFront("")).toBe(false);
      expect(isRichFront("![题](attachment:a.png)")).toBe(true);
      expect(isRichFront("第一行\n第二行")).toBe(true);
      // 行内普通文字里的方括号不算图片。
      expect(isRichFront("见 [注] 一节")).toBe(false);
    });

    it("frontLabel：单行投影，图片折成 🖼、换行折成 ·（纯文本恒等）", () => {
      expect(frontLabel("事务的隔离级别有哪些？")).toBe("事务的隔离级别有哪些？");
      expect(frontLabel("![题目](attachment:a.png)")).toBe("🖼");
      expect(frontLabel("![题目](attachment:a.png)\n\n给定一个整数数组 nums")).toBe(
        "🖼 · 给定一个整数数组 nums",
      );
    });

    // 跨语言一致性：这个投影在真机里是 Rust `parser::front_title_projection`
    // （parser.rs:22/35），并且被**存成 title**——两边一旦漂移，浏览器里的
    // 列表标签/「继续下一张」按钮就与真机不一致。下面这几条用 Rust 用例的同一
    // 输入（parser::tests::front_title_is_single_line_projection）与实现里的
    // 边界（未闭合图片引用、CRLF、相邻图片、alt 里带 `]`）把等价钉住。
    it("frontLabel 与 Rust front_title_projection 等价（同一投影 = 同一 title）", () => {
      // Rust: assert_eq!(c.title, "行一 · 行二 · 🖼 · 行三")
      expect(frontLabel("行一\n行二\n![图](u.png)\n行三")).toBe("行一 · 行二 · 🖼 · 行三");
      // 边界：未闭合 / 非紧邻的图片引用都按字面保留（两侧都不折）。
      expect(frontLabel("![a](b")).toBe("![a](b");
      expect(frontLabel("![a] (b)")).toBe("![a] (b)");
      expect(frontLabel("![a]b](c)")).toBe("![a]b](c)");
      // 相邻图片各折一个 🖼。
      expect(frontLabel("![一](a.png)![二](b.png)")).toBe("🖼🖼");
      // CRLF 与结尾换行都不留残余（Rust `lines()` 吃 \r，TS 靠 trim）。
      expect(frontLabel("行一\r\n行二\n")).toBe("行一 · 行二");
      expect(frontLabel("   ")).toBe("");
      expect(frontLabel("")).toBe("");
    });

    // 现在这个投影在仓库里有**三份**实现：Rust `parser::front_title_projection`、
    // `markdown.frontLabel`（渲染侧用）、`markdownImport.frontTitleProjection`
    // （解析侧算 title 用，t17 新增）。三份必须逐字一致，否则"解析时算出来的
    // title"与"渲染时显示的标签"会不同——所以这里把两个 TS 实现钉在一起。
    it("两个 TS 投影实现逐字一致（frontLabel ≡ markdownImport.frontTitleProjection）", () => {
      const cases = [
        "事务的隔离级别有哪些？",
        "![题目](attachment:a.png)",
        "行一\n行二\n![图](u.png)\n行三",
        "  ![图](x.png)  \n\n  正文  ",
        "![a](b",
        "![a] (b)",
        "![a]b](c)",
        "![一](a.png)![二](b.png)",
        "行一\r\n行二\n",
        "   ",
        "",
      ];
      for (const src of cases) {
        expect(frontTitleProjection(src), `投影不一致：${JSON.stringify(src)}`).toBe(frontLabel(src));
      }
    });

    // 投影的**幂等性**是"两处混用"安全的前提（弹窗拿 title 再走 frontLabel）：
    // title 本身已经是投影（无 `![` 可折、无换行可拼），再投影必须原样返回。
    // 反过来说，若有人把 frontLabel 直接用在 `front_md` 上，它等价于
    // frontTitleProjection —— 上一条护栏已覆盖。
    it("投影幂等：对投影结果再投影必须原样返回（title 与 front_md 混用安全）", () => {
      const cases = [
        "事务的隔离级别有哪些？",
        "![题目](attachment:a.png)",
        "行一\n行二\n![图](u.png)\n行三",
        "![a](b",
        "![a] (b)",
        "![a]b](c)",
        "![一](a.png)![二](b.png)",
        "![a](b) ![c](d",
        "行一\r\n行二\n",
        "![a](b\n)",
        "![a]\n(b)",
        "",
      ];
      for (const src of cases) {
        const once = frontTitleProjection(src);
        expect(frontTitleProjection(once), `不幂等：${JSON.stringify(src)}`).toBe(once);
        expect(frontLabel(once), `不幂等(frontLabel)：${JSON.stringify(src)}`).toBe(once);
      }
    });

    it("图片型题面能渲染成可放大的卡面图片", () => {
      registerMockAttachment("front.png", "data:image/png;base64,AAAA");
      const html = renderCard(frontMarkdown("标签", "![题目](attachment:front.png)"));
      expect(html).toContain('class="card-image"');
      expect(html).toContain('src="data:image/png;base64,AAAA"');
      expect(html).toContain('data-md-raw="![题目](attachment:front.png)"');
    });

    it("长题干渲染成多个块，而不是一行", () => {
      const html = renderCard(
        frontMarkdown("标签", "给定一个整数数组 nums 和一个目标值 target。\n\n请返回两个数的下标。"),
      );
      expect((html.match(/<p>/g) ?? []).length).toBe(2);
      expect(html).toContain("target");
      expect(html).toContain("两个数的下标");
    });
  });

  it("renders blockquote", () => {
    const html = renderCard("> 一句引用");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("一句引用");
  });

  // Bug6（t10）渲染侧契约：WYSIWYG 保存下来的引用结构，重新渲染必须还是同样的
  // 结构 —— 相邻两个引用不能合并、中间的空引用行是"段落分隔"而不是新引用、
  // 单行引用不渲染出空的尾随块（那些正是用户看到的"错位 / 空块"）。
  describe("引用块往返契约（Bug6 / t10）", () => {
    it("相邻两个引用渲染成两个 blockquote，不合并", () => {
      const html = renderCard("> 上面\n\n> 下面");
      expect((html.match(/<blockquote>/g) ?? []).length).toBe(2);
      expect(html).toContain("上面");
      expect(html).toContain("下面");
    });

    it("引用中间的空引用行是段落分隔，不是新引用", () => {
      const html = renderCard("> a\n> \n> b");
      expect((html.match(/<blockquote>/g) ?? []).length).toBe(1);
      expect((html.match(/<p>/g) ?? []).length).toBe(2);
    });

    it("单行引用不渲染出空的尾随块", () => {
      const html = renderCard("> 引用");
      expect((html.match(/<blockquote>/g) ?? []).length).toBe(1);
      expect(html).not.toContain("<br>");
      expect((html.match(/<p>/g) ?? []).length).toBe(1);
    });
  });
});
