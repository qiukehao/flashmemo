// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTextEntryTarget } from "./dom";

describe("isTextEntryTarget", () => {
  it("treats the editable card and form fields as text entry", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editor.appendChild(span);
    document.body.appendChild(editor);
    expect(isTextEntryTarget(span)).toBe(true);
    expect(isTextEntryTarget(editor)).toBe(true);

    const input = document.createElement("input");
    expect(isTextEntryTarget(input)).toBe(true);
    const textarea = document.createElement("textarea");
    expect(isTextEntryTarget(textarea)).toBe(true);
  });

  it("lets shortcuts through everywhere else", () => {
    expect(isTextEntryTarget(document.body)).toBe(false);
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(isTextEntryTarget(button)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    // A read-only rendered card is not a text entry target.
    const readOnly = document.createElement("div");
    document.body.appendChild(readOnly);
    expect(isTextEntryTarget(readOnly)).toBe(false);
  });
});
