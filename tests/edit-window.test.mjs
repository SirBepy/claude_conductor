import { describe, it, expect } from "vitest";
import { renderEditWindow } from "../src/shared/chat/edit-window.ts";

const editView = {
  path: "src/foo.ts",
  basename: "foo.ts",
  kind: "edit",
  hunks: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
  addedLines: 0,
  removedLines: 0,
};

const writeView = {
  path: "/new.ts",
  basename: "new.ts",
  kind: "write",
  hunks: [{ oldText: "", newText: "hello\nworld" }],
  addedLines: 2,
  removedLines: 0,
};

describe("renderEditWindow", () => {
  it("wraps output in <details class='edit-window'> collapsed by default", () => {
    const html = renderEditWindow(editView);
    expect(html.startsWith("<details class=\"edit-window\"")).toBe(true);
    expect(html).not.toContain(" open");
    expect(html).toContain("<summary");
  });

  it("renders basename, kind icon, and +N/-M badge in summary", () => {
    const view = { ...editView, addedLines: 3, removedLines: 1 };
    const html = renderEditWindow(view);
    expect(html).toContain("foo.ts");
    expect(html).toContain("data-kind=\"edit\"");
    expect(html).toContain(">+3<");
    expect(html).toContain(">-1<");
  });

  it("renders side-by-side before/after in body", () => {
    const html = renderEditWindow(editView);
    expect(html).toContain("edit-window-side");
    expect(html).toContain("data-side=\"before\"");
    expect(html).toContain("data-side=\"after\"");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("const a = 2;");
  });

  it("write kind uses '(new file)' as before label", () => {
    const html = renderEditWindow(writeView);
    expect(html).toContain("new file");
    expect(html).toContain("hello");
    expect(html).toContain("world");
  });

  it("escapes HTML inside diff content", () => {
    const view = { ...editView, hunks: [{ oldText: "<script>", newText: "<b>" }] };
    const html = renderEditWindow(view);
    expect(html).not.toContain(">.<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;");
  });
});
