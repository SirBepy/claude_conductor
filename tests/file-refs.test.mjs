// @vitest-environment jsdom

// Absolute paths in assistant messages become clickable chips: Windows and
// Unix forms, inline code included, fenced code and user messages left alone.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, remote } = vi.hoisted(() => ({ invokeMock: vi.fn(), remote: { on: false } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.on }));

const { linkifyFilePaths, findFileRefs, handleFileRefClick, handleFileRefContextMenu } = await import("../src/shared/chat/file-refs.ts");
const { setCodeModeOpener } = await import("../src/shared/chat/code-mode-bridge.ts");
const { renderMarkdown } = await import("../src/shared/chat/chat-transforms.ts");

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

  it("labels a folder path by its last segment with a folder icon, never an empty chip", () => {
    const root = mount(String.raw`<p>Filed in <code>C:\Users\x\.claude\.claude\todos\</code> done</p>`);
    linkifyFilePaths(root);
    const chip = root.querySelector(".file-ref");
    expect(chip.textContent).toBe("todos");
    expect(chip.querySelector(".ph-folder")).not.toBeNull();
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

// The chip is built from rendered text, so whatever markdown does to a path is
// what the click opens: `\.` used to render as `.`, sending
// C:\Users\x\.claude\settings.json to the nonexistent C:\Users\x.claude\.
describe("paths through the real markdown renderer", () => {
  const rendered = (src, breaks = false) => {
    const root = mount(renderMarkdown(src, breaks));
    linkifyFilePaths(root);
    return root;
  };
  const chipPaths = (root) => chips(root).map((c) => c[0]);

  it.each([
    ["a dot folder", String.raw`C:\Users\x\.claude\settings.json`],
    ["a leading-underscore folder", String.raw`C:\Users\x\_private\a.txt`],
    ["a dash after a separator", String.raw`C:\proj\a-b\-c\x.txt`],
    ["an emphasis-shaped name", String.raw`C:\proj\__init__.txt`],
    ["forward slashes", "C:/proj/__init__/a_b_c.txt"],
    ["a Unix path", "/home/joe/__init__/a.txt"],
  ])("keeps %s intact in the chip", (_label, path) => {
    expect(chipPaths(rendered(`open ${path}, then save`))).toEqual([path]);
  });

  it("keeps the path in the message that breaks single newlines too", () => {
    const path = String.raw`C:\Users\x\.claude\settings.json`;
    expect(chipPaths(rendered(`open ${path}\nthen save`, true))).toEqual([path]);
  });

  it("keeps a line suffix and a sentence-ending dot out of the path", () => {
    const root = rendered(String.raw`See C:\Users\x\.claude\a.ts:12.`);
    expect(chips(root)).toEqual([[String.raw`C:\Users\x\.claude\a.ts`, "12", "a.ts:12"]]);
    expect(root.textContent.trim()).toBe("See a.ts:12.");
  });

  it("still chips a path in an inline code span", () => {
    const path = String.raw`C:\Users\x\.claude\settings.json`;
    expect(chipPaths(rendered("open `" + path + "` now"))).toEqual([path]);
  });

  it("leaves markdown around and away from paths working", () => {
    const root = mount(renderMarkdown(String.raw`**C:\x\.y\a.txt** and \*literal\* and _soft_ and https://a.com/_b_/c`));
    expect(root.querySelector("strong").textContent).toBe(String.raw`C:\x\.y\a.txt`);
    expect(root.querySelector("em").textContent).toBe("soft");
    expect(root.textContent).toContain("*literal*");
    expect(root.querySelector("a").getAttribute("href")).toBe("https://a.com/_b_/c");
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

  it("opens a path outside the chat's repo in the app's Files window, not VS Code", () => {
    const root = mount(String.raw`<p>C:\Users\x\a.ts:9</p>`);
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock).toHaveBeenCalledWith("open_file_window", { path: String.raw`C:\Users\x\a.ts`, line: 9 });
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("open_in_editor");
  });

  it("forwards the chip's line", () => {
    const root = mount("<p>/home/joe/project/a.rs:42:7</p>");
    linkifyFilePaths(root);
    click(root);
    expect(invokeMock.mock.calls[0][1]).toEqual({ path: "/home/joe/project/a.rs", line: 42 });
  });

  it("passes no line for a chip without one", () => {
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    click(root);
    const args = invokeMock.mock.calls[0][1];
    expect(args.path).toBe("/home/joe/project/a.rs");
    expect(args.line).toBeNull();
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

  it("keeps Open for a path outside the chat's repo: it opens in the Files window", () => {
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    expect(items(root)).toEqual(["Open", "Open in VS Code", "Copy path", "Reveal in file manager"]);
  });

  it("keeps Open on the phone and drops the desktop-disk actions", () => {
    remote.on = true;
    repo = "/home/joe/project/";
    const root = mount("<p>/home/joe/project/a.rs</p>");
    linkifyFilePaths(root);
    expect(items(root)).toEqual(["Open", "Copy path"]);
  });
});
