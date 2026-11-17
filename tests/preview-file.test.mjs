// asserts: src/shared/preview-file.ts, src/views/sessions/preview-panel-document.ts
// previewFile(path) builds the page the Preview panel shows for a file:
// markdown rendered with a Source switch, an image, code, and a plain error
// for a missing or binary file (never a blank panel).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { previewFile, loadFileDocument, looksBinary } = await import("../src/shared/preview-file.ts");
const { buildFilePreviewHtml } = await import("../src/views/sessions/preview-panel-document.ts");

// Answers only the two commands previewFile owns. Anything else in the module graph that
// happens to call invoke gets undefined, so a rejection meant for the read never leaks to it.
function backend(handlers) {
  invokeMock.mockImplementation(async (cmd, args) => (handlers[cmd] ? handlers[cmd](args) : undefined));
}
const text = (content, truncated = false) => backend({ read_text_file: () => ({ content, truncated }) });
const readFails = (err) => backend({ read_text_file: () => { throw err; } });

beforeEach(() => invokeMock.mockReset());

describe("previewFile", () => {
  it("renders markdown by default and keeps the source behind a switch", async () => {
    text("# Title\n\nHello **world**\n");
    const r = await previewFile("C:/proj/README.md");
    expect(r.kind).toBe("markdown");
    expect(r.title).toBe("README.md");
    expect(invokeMock).toHaveBeenCalledWith("read_text_file", { path: "C:/proj/README.md" });
    // Rendered view is the checked radio; the Source pane holds the raw text.
    expect(r.html).toMatch(/id="pf-v-r" checked/);
    expect(r.html).not.toMatch(/id="pf-v-s" checked/);
    expect(r.html).toContain("<h1>Title</h1>");
    expect(r.html).toContain("<strong>world</strong>");
    expect(r.html).toMatch(/<pre class="pf-source"[^>]*># Title\n\nHello \*\*world\*\*\n<\/pre>/);
  });

  it("hides html comments from the rendered markdown like the Code mode viewer", async () => {
    text("<!-- claim note -->\n# Todo\n");
    const r = await previewFile("C:/proj/todo.md");
    expect(r.html).not.toContain("claim note");
  });

  it("draws a markdown blockquote through renderMarkdown's quote bubble", async () => {
    text("> **Joe:**\n> hi\n");
    const r = await previewFile("C:/proj/a.md");
    expect(r.html).toContain("md-quote");
  });

  it("shows a code file as escaped monospace text with no Rendered switch", async () => {
    text("const a = 1 < 2 && \"x\";\n");
    const r = await previewFile("C:/proj/src/a.ts");
    expect(r.kind).toBe("code");
    expect(r.html).toContain("const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;");
    expect(r.html).not.toContain('type="radio"');
  });

  it("never lets file text inject markup", async () => {
    text("</pre><script>alert(1)</script>");
    const r = await previewFile("C:/proj/evil.txt");
    expect(r.html).not.toContain("<script>alert(1)");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("shows an image through read_image_file as a data URL", async () => {
    backend({ read_image_file: () => ({ mime: "image/png", base64: "AAAA" }) });
    const r = await previewFile("C:/proj/shot.PNG", "s1");
    expect(r.kind).toBe("image");
    expect(invokeMock).toHaveBeenCalledWith("read_image_file", { path: "C:/proj/shot.PNG", sessionId: "s1" });
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
  });

  it("refuses an image answer that is not an image", async () => {
    backend({ read_image_file: () => ({ mime: "application/octet-stream", base64: "AAAA" }) });
    const r = await previewFile("C:/proj/x.png");
    expect(r.kind).toBe("error");
    expect(r.html).not.toContain("<img");
  });

  it("says a missing file was not found instead of showing a blank panel", async () => {
    readFails("file not found: The system cannot find the file specified. (os error 2)");
    const r = await previewFile("C:/proj/gone.md");
    expect(r.kind).toBe("error");
    expect(r.html).toContain("gone.md was not found");
    expect(r.html).toContain('role="alert"');
  });

  it("names any other read failure", async () => {
    readFails(new Error("Access is denied. (os error 5)"));
    const r = await previewFile("C:/proj/locked.txt");
    expect(r.kind).toBe("error");
    expect(r.html).toContain("locked.txt could not be read: Access is denied.");
  });

  it("refuses a binary extension without reading it", async () => {
    const r = await previewFile("C:/proj/app.exe");
    expect(r.kind).toBe("error");
    expect(r.html).toContain("binary file");
    expect(invokeMock.mock.calls.filter((c) => c[0] === "read_text_file")).toEqual([]);
  });

  it("refuses a file whose content is binary under a text extension", async () => {
    text("PK\u0003\u0004\u0000\u0000data");
    const r = await previewFile("C:/proj/odd.dat");
    expect(r.kind).toBe("error");
    expect(r.html).toContain("binary file");
  });

  it("notes a truncated file", async () => {
    text("big", true);
    const r = await previewFile("C:/proj/big.log");
    expect(r.html).toContain("only its start is shown");
  });

  it("loadFileDocument never throws", async () => {
    readFails(new Error("boom"));
    await expect(loadFileDocument("C:/proj/a.md")).resolves.toMatchObject({ kind: "error" });
  });
});

describe("looksBinary", () => {
  it("flags NUL bytes and mostly-replacement text, not ordinary text", () => {
    expect(looksBinary("a\0b")).toBe(true);
    expect(looksBinary("\uFFFD\uFFFD\uFFFD\uFFFDabc")).toBe(true);
    expect(looksBinary("héllo wörld ✓")).toBe(false);
    expect(looksBinary("")).toBe(false);
  });
});

describe("buildFilePreviewHtml", () => {
  it("escapes the path in the title and header", () => {
    const html = buildFilePreviewHtml({ kind: "error", path: "C:/a/<b>.md", message: "x" });
    expect(html).not.toContain("<b>.md");
    expect(html).toContain("&lt;b&gt;.md");
  });
});
