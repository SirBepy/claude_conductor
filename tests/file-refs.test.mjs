// @vitest-environment jsdom

// Absolute paths in assistant messages become clickable chips: Windows and
// Unix forms, inline code included, fenced code and user messages left alone.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, remote } = vi.hoisted(() => ({ invokeMock: vi.fn(), remote: { on: false } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.on }));

const { linkifyFilePaths, findFileRefs, handleFileRefClick, handleFileRefContextMenu } = await import("../src/shared/chat/file-refs.ts");
const { setCodeModeOpener } = await import("../src/shared/chat/code-mode-bridge.ts");

function mount(html, cls = "msg assistant") {
  const root = document.createElement("div");
  root.innerHTML = `<div class="${cls}">${html}</div>`;
  document.body.appendChild(root);
  return root;
}
const chips = (root) => [...root.querySelectorAll(".file-ref")].map((c) => [c.dataset.path, c.dataset.line ?? null, c.textContent]);

// No chat repo by default: every path is outside it, the editor fallback.
const opened = [];
let repo = null;
const inRepo = (p) => !!repo && p.replace(/\\/g, "/").toLowerCase().startsWith(repo);

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  remote.on = false;
  repo = null;
  opened.length = 0;
  setCodeModeOpener((t) => opened.push(t), inRepo);
  document.body.innerHTML = "";
});

describe("shell metacharacters and overlong line numbers", () => {
  it("never carries & ^ % ! into a chip path", () => {
    for (const bad of String.raw`C:\x&calc.exe|C:\x^y\a.ts|C:\%TEMP%\a.ts|C:\x!y\a.ts`.split("|")) {
      const paths = findFileRefs(`open ${bad} now`).map((r) => r.path);
      expect(paths.some((p) => /[&^%!]/.test(p))).toBe(false);
    }
  });

  it("drops a suffix whose number does not fit a u32 instead of carrying it", () => {
    const [ref] = findFileRefs("see /home/joe/project/a.rs:99999999999 here");
    expect(ref.path).toBe("/home/joe/project/a.rs");
    expect(ref.line).toBeNull();
    const [ok] = findFileRefs("see /home/joe/project/a.rs:123456789:7 here");
    expect([ok.line, ok.col]).toEqual([123456789, 7]);
  });
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

  it("opens a path inside the chat's repo in Code mode at the chip's line, not the editor", () => {
    repo = "c:/users/x/";
    const root = mount(String.raw`<p>C:\Users\x\a.ts:9</p>`);
    linkifyFilePaths(root);
    click(root);
    expect(opened).toEqual([{ kind: "file", path: String.raw`C:\Users\x\a.ts`, line: 9 }]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("opens in Code mode on the phone too", () => {
    remote.on = true;
    repo = "/home/joe/project/";
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    click(root);
    expect(opened).toEqual([{ kind: "file", path: "/home/joe/project/a.rs", line: undefined }]);
  });

  it("opens a path outside the chat's repo through open_in_editor", () => {
    const root = mount(String.raw`<p>C:\Users\x\a.ts:9</p>`);
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock).toHaveBeenCalledWith("open_in_editor", { path: String.raw`C:\Users\x\a.ts`, line: 9 });
  });

  it("forwards the chip's line and column", () => {
    const root = mount("<p>/home/joe/project/a.rs:42:7</p>");
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ path: "/home/joe/project/a.rs", line: 42, col: 7 });
  });

  it("passes no line for a chip without one", () => {
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    click(root);
    const args = invokeMock.mock.calls[0][1];
    expect(args.path).toBe("/home/joe/project/a.rs");
    expect(args.line).toBeUndefined();
    expect(args.col).toBeUndefined();
  });

  it("only copies a path outside the chat's repo on the phone", () => {
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

describe("right-click menu", () => {
  const items = (root) => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    root.querySelector(".file-ref .file-ref-name").dispatchEvent(e);
    handleFileRefContextMenu(e);
    const labels = [...document.querySelectorAll(".smore-item")].map((b) => b.textContent);
    document.querySelectorAll(".session-more-menu, .smore-item").forEach((n) => n.remove());
    return labels;
  };

  it("offers Open (Code mode) and Open in VS Code for a path in the chat's repo", () => {
    repo = "/home/joe/project/";
    const root = mount("<p>/home/joe/project/a.rs:3</p>");
    linkifyFilePaths(root);
    expect(items(root)).toEqual(["Open", "Open in VS Code", "Copy path", "Reveal in file manager"]);
  });

  it("drops Open for a path outside the chat's repo", () => {
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    expect(items(root)).toEqual(["Open in VS Code", "Copy path", "Reveal in file manager"]);
  });

  it("keeps Open on the phone and drops the desktop-disk actions", () => {
    remote.on = true;
    repo = "/home/joe/project/";
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    expect(items(root)).toEqual(["Open", "Copy path"]);
  });
});
