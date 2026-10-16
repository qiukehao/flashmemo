import { describe, expect, it } from "vitest";
import { composeQuestion } from "./aiAsk";

describe("composeQuestion (问 AI 的组句)", () => {
  const content = "> [!note] 傻瓜讲解\n> 把隔离级别想象成四个档位。";

  it("没有划选时：标题 + 卡面内容", () => {
    const text = composeQuestion("事务的隔离级别有哪些？", content, "");
    expect(text).toBe(`闪卡问题：事务的隔离级别有哪些？\n\n${content}`);
  });

  it("划选时：标题 + 内容 + 针对选中处的提问（提问在最后）", () => {
    const text = composeQuestion("事务的隔离级别有哪些？", content, "间隙锁");
    expect(text).toContain("闪卡问题：事务的隔离级别有哪些？");
    expect(text).toContain(content);
    expect(text.trimEnd().endsWith("想问的是这一段：「间隙锁」")).toBe(true);
  });

  it("空内容不产生空段落，划选文本两端空白被裁掉", () => {
    expect(composeQuestion("标题", "   ", "")).toBe("闪卡问题：标题");
    const text = composeQuestion("标题", "", "  间隙锁  ");
    expect(text).toBe("闪卡问题：标题\n\n想问的是这一段：「间隙锁」");
  });
});

describe("composeQuestion 空白收拾（2026-10-10 用户反馈：AI 输入框里间距混乱）", () => {
  it("CRLF / CR 一律归一成 LF", () => {
    expect(composeQuestion("T", "第一行\r\n\r\n第二行\r第三行", "")).toBe(
      "闪卡问题：T\n\n第一行\n\n第二行\n第三行",
    );
  });

  it("去掉行尾空白（含 Markdown 硬换行的两个空格）", () => {
    expect(composeQuestion("T", "第一行  \n第二行\t", "")).toBe(
      "闪卡问题：T\n\n第一行\n第二行",
    );
  });

  it("连续空行最多保留一个", () => {
    expect(composeQuestion("T", "第一段\n\n\n\n\n第二段", "")).toBe(
      "闪卡问题：T\n\n第一段\n\n第二段",
    );
  });

  it("围栏代码块里的空行与行尾空格原样保留", () => {
    const code = "```python\na = 1  \n\n\nb = 2\n```";
    expect(composeQuestion("T", `看这段：\n\n${code}`, "")).toBe(
      `闪卡问题：T\n\n看这段：\n\n${code}`,
    );
  });

  it("~~~ 围栏同样受保护，代码块之外照旧收拾", () => {
    const content = "前言  \n\n\n~~~\ncode  \n\n\n~~~\n\n\n后记  ";
    expect(composeQuestion("T", content, "")).toBe(
      "闪卡问题：T\n\n前言\n\n~~~\ncode  \n\n\n~~~\n\n后记",
    );
  });

  it("划选片段里的空白也一并收拾", () => {
    const text = composeQuestion("T", "正文", "上一行\n\n\n\n下一行  ");
    expect(text).toBe("闪卡问题：T\n\n正文\n\n想问的是这一段：「上一行\n\n下一行」");
  });
});
