// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readonlyReason } from "../src/shared/chat/file-editor.ts";
import { markdownForDisplay, resolveLink } from "../src/shared/chat/file-surface.ts";
import { fileWindowTargetFromHash } from "../src/boot/window-mode-hash.ts";

const writable = { mtime_us: 1, writable: true };

describe("readonlyReason: only files that round-trip unchanged are editable", () => {
  it("allows a plain LF or CRLF file in a project", () => {
    expect(readonlyReason("a\nb\n", writable, false)).toBeNull();
    expect(readonlyReason("a\r\nb\r\n", writable, false)).toBeNull();
  });

  it("refuses a file outside every project", () => {
    expect(readonlyReason("a\n", { mtime_us: 1, writable: false }, false)).toBe("Read-only: outside your projects");
  });

  it("refuses a truncated read, which would drop the file's tail on save", () => {
    expect(readonlyReason("a\n", writable, true)).toBe("Read-only: too large to edit here");
  });

  it("refuses content the lossy UTF-8 read had to patch", () => {
    expect(readonlyReason("ok \uFFFD bytes\n", writable, false)).toBe("Read-only: not UTF-8 text");
  });

  it("refuses mixed CRLF and LF endings, which one separator can't rejoin", () => {
    expect(readonlyReason("a\r\nb\nc\r\n", writable, false)).toBe("Read-only: mixed line endings");
    expect(readonlyReason("a\nb\r\n", writable, false)).toBe("Read-only: mixed line endings");
  });
});

describe("markdownForDisplay", () => {
  it("drops HTML comments and the BOM, keeps the rest", () => {
    const src = "\uFEFF<!-- Claim before executing -->\n<!-- cleanup: x -->\n# Title\n\nBody <!-- inline --> text\n";
    expect(markdownForDisplay(src)).toBe("# Title\n\nBody text\n");
  });

  it("drops a multi-line comment", () => {
    expect(markdownForDisplay("<!--\nnote\n-->\n# T\n")).toBe("# T\n");
  });
});

describe("resolveLink", () => {
  const from = "C:/Projects/alpha/docs/guide.md";

  it("resolves a relative link against the file's folder", () => {
    expect(resolveLink(from, "other.md")).toBe("C:/Projects/alpha/docs/other.md");
    expect(resolveLink(from, "../src/main.ts#L4")).toBe("C:/Projects/alpha/src/main.ts");
    expect(resolveLink(from, "./a%20b.md")).toBe("C:/Projects/alpha/docs/a b.md");
  });

  it("keeps an absolute path and unwraps file://", () => {
    expect(resolveLink(from, "C:/Other/x.txt")).toBe("C:/Other/x.txt");
    expect(resolveLink(from, "file:///C:/Other/x.txt")).toBe("C:/Other/x.txt");
  });

  it("follows nothing for an in-page anchor, another scheme, or bad escapes", () => {
    expect(resolveLink(from, "#section")).toBeNull();
    expect(resolveLink(from, "javascript:alert(1)")).toBeNull();
    expect(resolveLink(from, "%E0%A4%A")).toBeNull();
    expect(resolveLink(null, "other.md")).toBeNull();
  });
});

describe("fileWindowTargetFromHash", () => {
  function at(url) {
    window.history.replaceState(null, "", url);
    return fileWindowTargetFromHash();
  }

  it("reads the path and line the backend put in the URL", () => {
    // form_urlencoded: spaces as +, & and # escaped.
    expect(at("/index.html?filewindow=1#file?path=C%3A%5CJoe+Doe%5Ca%26b+%23c.md&line=7"))
      .toEqual({ path: "C:\\Joe Doe\\a&b #c.md", line: 7 });
  });

  it("is null outside the Files window, and drops a bad line", () => {
    expect(at("/index.html#file?path=x")).toBeNull();
    expect(at("/index.html?filewindow=1#file?path=C%3A%5Cx.md&line=abc")).toEqual({ path: "C:\\x.md", line: null });
  });
});
