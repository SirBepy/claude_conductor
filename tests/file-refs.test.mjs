// @vitest-environment jsdom

// Absolute paths in assistant messages become clickable chips: Windows and
// Unix forms, inline code included, fenced code and user messages left alone.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, remote } = vi.hoisted(() => ({ invokeMock: vi.fn(), remote: { on: false } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.on }));

const { linkifyFilePaths, findFileRefs, handleFileRefClick } = await import("../src/shared/chat/file-refs.ts");

function mount(html, cls = "msg assistant") {
  const root = document.createElement("div");
  root.innerHTML = `<div class="${cls}">${html}</div>`;
  document.body.appendChild(root);
  return root;
}
const chips = (root) => [...root.querySelectorAll(".file-ref")].map((c) => [c.dataset.path, c.dataset.line ?? null, c.textContent]);

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  remote.on = false;
  document.body.innerHTML = "";
});

describe("linkifyFilePaths", () => {
  it("chips Windows and Unix paths, keeping a line suffix", () => {
    const root = mount(String.raw`<p>See C:\Users\x\proj\src\a.ts:12 and C:/Users/x/b.ts and /home/joe/project/a.rs:3:4.</p>`);
    linkifyFilePaths(root);
    expect(chips(root)).toEqual([
      [String.raw`C:\Users\x\proj\src\a.ts`, "12", "a.ts:12"],
      ["C:/Users/x/b.ts", null, "b.ts"],
      ["/home/joe/project/a.rs", "3", "a.rs:3:4"],
    ]);
    expect(root.textContent).toBe(String.raw`See a.ts:12 and b.ts and a.rs:3:4.`);
  });

  it("strips trailing punctuation and keeps the full path in the tooltip", () => {
    const root = mount("<p>Edited (/home/joe/project/a.rs), then /home/joe/project/b.rs.</p>");
    linkifyFilePaths(root);
    expect(chips(root).map((c) => c[0])).toEqual(["/home/joe/project/a.rs", "/home/joe/project/b.rs"]);
    expect(root.querySelector(".file-ref").title).toBe("/home/joe/project/a.rs");
    expect(root.textContent).toBe("Edited (a.rs), then b.rs.");
  });

  it("links a path inside an inline code span", () => {
    const root = mount("<p>Open <code>/home/joe/project/a.rs</code> now</p>");
    linkifyFilePaths(root);
    expect(root.querySelector("code .file-ref")).not.toBeNull();
  });

  it("leaves fenced code blocks, URLs, short unix paths and user messages alone", () => {
    const fenced = mount("<pre><code>cat /home/joe/project/a.rs</code></pre>");
    const url = mount("<p>https://example.com/a/b/c and https://x.io/home/joe/p.rs and /usr/bin</p>");
    const user = mount("<p>/home/joe/project/a.rs</p>", "msg user");
    for (const r of [fenced, url, user]) linkifyFilePaths(r);
    expect(chips(fenced)).toEqual([]);
    expect(chips(url)).toEqual([]);
    expect(chips(user)).toEqual([]);
  });
});

describe("findFileRefs", () => {
  it("does not treat a bare drive as a path", () => {
    expect(findFileRefs(String.raw`C:\ and D:/`)).toEqual([]);
  });
});

describe("click", () => {
  const click = (root) => {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector(".file-ref .file-ref-name").dispatchEvent(e);
    handleFileRefClick(e);
  };

  it("opens the file through open_in_editor", () => {
    const root = mount(String.raw`<p>C:\Users\x\a.ts:9</p>`);
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock).toHaveBeenCalledWith("open_in_editor", { path: String.raw`C:\Users\x\a.ts` });
  });

  it("only copies the path on the phone", () => {
    remote.on = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("/home/joe/project/a.rs");
  });
});
