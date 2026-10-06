// @vitest-environment jsdom

// Code mode: the explorer's pure pieces (tree, scope data, markup) and the
// mode itself driven through its DOM - enter/leave, tabs, commits, push.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMock = { impl: async () => null };
const calls = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => {
    calls.push([cmd, args]);
    return ipcMock.impl(cmd, args);
  }),
}));
const remote = { on: false };
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.on, isTauri: () => !remote.on }));
const backHandlers = [];
vi.mock("../src/shared/back-button.ts", () => ({
  registerOverlayBack: (fn) => { backHandlers.push(fn); return () => backHandlers.splice(backHandlers.indexOf(fn), 1); },
}));

const { buildTree, allDirs, repoRelative, OUTSIDE_DIR } = await import("../src/views/sessions/code-mode/tree.ts");
const { chatFiles, loadScope } = await import("../src/views/sessions/code-mode/data.ts");
const { explorerHtml } = await import("../src/views/sessions/code-mode/explorer-html.ts");
const { changeStarts } = await import("../src/shared/chat/file-surface.ts");
const { openCodeMode, closeCodeMode, isCodeModeOpen } = await import("../src/views/sessions/code-mode/code-mode.ts");

// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView = function () {};

const CWD = "C:\\repo";
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

function edit(path, kind = "edit") {
  return { path, basename: path.split(/[\\/]/).pop(), kind, hunks: [{ oldText: "a", newText: "b" }], addedLines: 1, removedLines: 1 };
}

function scopeFile(path, status, wt = false) {
  return { path, status, added: 1, removed: 0, wt, surface: { path, fileAtRev: async () => ({ content: "", truncated: false }) } };
}

function model(over = {}) {
  return {
    scope: { kind: "unpushed" },
    data: null,
    collapsed: new Set(),
    activePath: null,
    menuOpen: false,
    menuCounts: {},
    git: null,
    commitsOpen: false,
    branchOpen: false,
    gitBusy: null,
    gitError: null,
    ...over,
  };
}

function render(m) {
  const el = document.createElement("div");
  el.innerHTML = explorerHtml(m);
  return el;
}

describe("tree helpers", () => {
  it("nests paths into folders", () => {
    const t = buildTree(["src/a.ts", "src/x/b.ts", "README.md"]);
    expect(t.files).toEqual(["README.md"]);
    expect([...t.dirs.keys()]).toEqual(["src"]);
    expect(t.dirs.get("src").dirs.get("x").files).toEqual(["src/x/b.ts"]);
  });

  it("lists every folder a file sits under", () => {
    expect([...allDirs(["a/b/c.ts", "a/d.ts"])].sort()).toEqual(["a", "a/b"]);
  });

  it("makes a Windows path repo-relative, case-insensitively", () => {
    expect(repoRelative("C:\\Repo", "c:\\repo\\src\\a.ts")).toBe("src/a.ts");
    expect(repoRelative("C:/Repo/", "C:/Repo/b.ts")).toBe("b.ts");
  });

  it("files outside the repo land under their own folder", () => {
    expect(repoRelative(CWD, "C:\\Users\\me\\.claude\\notes.md")).toBe(`${OUTSIDE_DIR}/notes.md`);
  });

  it("leaves an already-relative path alone", () => {
    expect(repoRelative(CWD, "./src/a.ts")).toBe("src/a.ts");
  });
});

describe("This chat scope", () => {
  it("one row per file, A when the chat created it, M otherwise", () => {
    const files = chatFiles({
      cwd: CWD,
      edits: [edit("C:\\repo\\src\\new.ts", "write"), edit("C:\\repo\\src\\old.ts"), edit("C:\\repo\\src\\old.ts")],
    });
    expect([...files.keys()].sort()).toEqual(["src/new.ts", "src/old.ts"]);
    expect(files.get("src/new.ts").status).toBe("A");
    expect(files.get("src/old.ts").status).toBe("M");
    expect(files.get("src/old.ts").surface.sessionEdits).toHaveLength(2);
    expect(files.get("src/old.ts").added).toBe(2);
  });
});

describe("Unpushed scope", () => {
  it("marks files under an untracked folder WT (git status reports just the folder)", async () => {
    ipcMock.impl = async (cmd) => {
      if (cmd === "get_commit_sync") return { ahead: [], behind: [], has_upstream: true };
      if (cmd === "get_git_dirty") return ["src/new/", "src/edited.ts"];
      if (cmd === "get_range_files") return [
        { path: "src/new/a.ts", status: "A", added: 1, removed: 0, old_path: null },
        { path: "src/edited.ts", status: "M", added: 1, removed: 1, old_path: null },
        { path: "src/pushed-later.ts", status: "M", added: 1, removed: 1, old_path: null },
      ];
      return null;
    };
    const d = await loadScope({ cwd: CWD, edits: [] }, { kind: "unpushed" });
    expect(d.changed.get("src/new/a.ts").wt).toBe(true);
    expect(d.changed.get("src/edited.ts").wt).toBe(true);
    expect(d.changed.get("src/pushed-later.ts").wt).toBe(false);
  });
});

describe("explorer markup", () => {
  const data = (files, paths) => ({ changed: new Map(files.map((f) => [f.path, f])), paths: paths ?? files.map((f) => f.path), error: null });

  it("badges changed files and marks uncommitted ones WT", () => {
    const el = render(model({ data: data([scopeFile("src/a.ts", "M", true), scopeFile("src/b.ts", "A")]) }));
    const a = el.querySelector('[data-file="src/a.ts"]');
    expect(a.classList.contains("wt")).toBe(true);
    expect(a.querySelector(".cm-wt")).not.toBeNull();
    expect(a.querySelector(".pr-file-status").textContent).toBe("M");
    expect(el.querySelector('[data-file="src/b.ts"] .pr-file-status').textContent).toBe("A");
  });

  it("inside a commit an M badge says nothing, so it is hidden; A/D stay", () => {
    const el = render(model({
      scope: { kind: "commit", sha: "abc1234def", title: "FIX: thing" },
      data: data([scopeFile("a.ts", "M"), scopeFile("b.ts", "D")]),
    }));
    expect(el.querySelector('[data-file="a.ts"] .pr-file-status')).toBeNull();
    expect(el.querySelector('[data-file="b.ts"] .pr-file-status').textContent).toBe("D");
  });

  it("a collapsed folder holding changes shows a dot", () => {
    const el = render(model({ data: data([scopeFile("src/a.ts", "M")]), collapsed: new Set(["src"]) }));
    expect(el.querySelector('[data-dir="src"] .cm-dot')).not.toBeNull();
    expect(el.querySelector('[data-file="src/a.ts"]')).toBeNull();
  });

  it("All files lists unchanged files too, changed ones still marked", () => {
    const el = render(model({ scope: { kind: "all" }, data: data([scopeFile("a.ts", "M")], ["a.ts", "b.ts"]) }));
    expect(el.querySelector(".cm-qtitle .n").textContent).toBe("2");
    expect(el.querySelector('[data-file="a.ts"]').classList.contains("chg")).toBe(true);
    expect(el.querySelector('[data-file="b.ts"]').classList.contains("chg")).toBe(false);
  });

  it("the header is a quiet text menu with the scope and its count", () => {
    const el = render(model({ scope: { kind: "chat" }, data: data([scopeFile("a.ts", "M"), scopeFile("b.ts", "A")]) }));
    expect(el.querySelector(".cm-qtitle").textContent).toContain("This chat");
    expect(el.querySelector(".cm-qtitle .n").textContent).toBe("2");
  });

  it("the open menu offers the three change scopes, a divider, then All files", () => {
    const el = render(model({ menuOpen: true, data: data([]) }));
    const items = Array.from(el.querySelectorAll(".cm-scope-menu .cm-mi"), (i) => i.dataset.scope);
    expect(items).toEqual(["chat", "unpushed", "uncommitted", "all"]);
    expect(el.querySelector('.cm-mi[data-scope="unpushed"]').getAttribute("aria-checked")).toBe("true");
  });

  it("an opened commit's header copies its title and hash", () => {
    const el = render(model({ scope: { kind: "commit", sha: "abc1234def", title: "FIX: thing" }, data: data([scopeFile("a.ts", "M")]) }));
    const copies = Array.from(el.querySelectorAll(".cm-copy"), (c) => c.dataset.copy);
    expect(copies).toEqual(["FIX: thing", "abc1234def"]);
    expect(el.querySelector(".cm-csha").textContent).toContain("1 file");
  });

  const git = (sync, branch = "master", upstream = "origin/master") => ({ sync, branch, upstream });

  it("the commits fold summarises what is unpushed, Push follows them, and Show older commits is the last row", () => {
    const el = render(model({
      data: data([]),
      commitsOpen: true,
      git: git({ ahead: [{ short_sha: "aaa", message: "one" }, { short_sha: "bbb", message: "two" }], behind: [], has_upstream: true }),
    }));
    expect(el.querySelector(".cm-fold .cm-qn").textContent).toBe("2 unpushed");
    const rows = Array.from(el.querySelectorAll(".cm-commits > .cm-commit"));
    expect(rows.at(-2).classList.contains("cm-pushrow")).toBe(true);
    expect(rows.at(-1).classList.contains("cm-older-trigger")).toBe(true);
    expect(el.querySelector('[data-act="push"]').textContent).toContain("Push 2 commits");
    expect(el.querySelector(".cm-branchbtn").textContent).toContain("origin/master");
    // Commit rows are keyboard-reachable buttons.
    expect(el.querySelector('[data-commit="aaa"]').getAttribute("tabindex")).toBe("0");
  });

  it("no upstream offers Publish; behind offers Pull", () => {
    const pub = render(model({ data: data([]), commitsOpen: true, git: git({ ahead: [], behind: [], has_upstream: false }, "feat/x", null) }));
    expect(pub.querySelector('[data-act="push"]').textContent).toContain("Publish feat/x");
    const behind = render(model({ data: data([]), commitsOpen: true, git: git({ ahead: [], behind: [{ short_sha: "c", message: "m" }], has_upstream: true }) }));
    expect(behind.querySelector('[data-act="pull"]').textContent).toContain("Pull 1 commit");
    expect(behind.querySelector('[data-act="push"]').disabled).toBe(true);
  });
});

describe("change navigation stops", () => {
  it("each run of added/removed rows is one stop", () => {
    const t = document.createElement("table");
    t.innerHTML = ["fs-hunk", "fs-ctx", "fs-del", "fs-add", "fs-ctx", "fs-add", "fs-ctx"].map((c) => `<tr class="${c}"><td></td></tr>`).join("");
    expect(changeStarts(Array.from(t.querySelectorAll("tr")))).toEqual([2, 5]);
  });
});

describe("Code mode", () => {
  let layout;
  let pane;
  const SYNC = { ahead: [{ short_sha: "abc1234", message: "FEAT: one" }], behind: [], has_upstream: true };

  function chat(over = {}) {
    return {
      key: "s1",
      sessionId: "s1",
      cwd: CWD,
      layout,
      title: () => "My chat",
      busy: () => true,
      latestLine: () => "Working on it",
      edits: () => [edit("C:\\repo\\src\\a.ts"), edit("C:\\repo\\src\\b.ts", "write")],
      mention: vi.fn(),
      onGitChanged: vi.fn(),
      ...over,
    };
  }

  beforeEach(() => {
    calls.length = 0;
    document.body.innerHTML = `<div class="sessions-layout"><aside class="sessions-sidebar"></aside><main id="session-pane"></main></div>`;
    layout = document.querySelector(".sessions-layout");
    pane = document.querySelector("#session-pane");
    ipcMock.impl = async (cmd, args) => {
      if (cmd === "get_commit_sync") return SYNC;
      if (cmd === "get_git_info") return { branch: "master" };
      if (cmd === "get_recent_branches") return [{ name: "master", current: true, short_sha: "abc1234", upstream: "origin/master" }];
      if (cmd === "get_range_files") return args.to === "abc1234"
        ? [{ path: "src/z.ts", status: "M", added: 1, removed: 0, old_path: null }, { path: "src/a.ts", status: "A", added: 3, removed: 0, old_path: null }]
        : [];
      if (cmd === "get_git_dirty") return [];
      if (cmd === "get_file_diff") return "@@ -1 +1 @@\n-a\n+b";
      if (cmd === "get_file_at_rev") return { content: "x", truncated: false };
      return null;
    };
  });

  afterEach(() => {
    closeCodeMode();
    remote.on = false;
  });

  const root = () => document.querySelector(".code-mode");

  it("covers the chat list and the chat, with the back pill naming the chat", async () => {
    openCodeMode(chat());
    await settle();
    expect(layout.classList.contains("code-mode-on")).toBe(true);
    expect(root().querySelector(".cm-bc-title").textContent).toBe("My chat");
    expect(root().querySelector(".cm-bc-text").textContent).toBe("Working on it");
    expect(root().querySelector(".cm-live").classList.contains("on")).toBe(true);
    // This chat's two edits, as the default scope.
    expect(root().querySelectorAll(".cm-row.cm-file").length).toBe(2);
  });

  it("Esc leaves, and the back pill leaves", async () => {
    openCodeMode(chat());
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isCodeModeOpen()).toBe(false);
    expect(layout.classList.contains("code-mode-on")).toBe(false);

    openCodeMode(chat());
    await settle();
    root().querySelector(".cm-backchat").click();
    expect(isCodeModeOpen()).toBe(false);
  });

  it("opens a file as a tab, and tabs survive leaving and re-entering", async () => {
    openCodeMode(chat());
    await settle();
    root().querySelector('[data-file="src/a.ts"]').click();
    await settle();
    expect(Array.from(root().querySelectorAll(".cm-tab"), (t) => t.dataset.tab)).toEqual(["src/a.ts"]);
    closeCodeMode();
    openCodeMode(chat());
    await settle();
    expect(root().querySelector(".cm-tab.on").dataset.tab).toBe("src/a.ts");
    root().querySelector('.cm-tab [data-close="src/a.ts"]').click();
    expect(root().querySelectorAll(".cm-tab").length).toBe(0);
  });

  it("a commit row opens that commit: its header, its files, its first file", async () => {
    openCodeMode(chat({ key: "s2" }), { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-commit="abc1234"]').click();
    await settle();
    expect(root().querySelector(".cm-ctitle").textContent).toBe("FEAT: one");
    expect(calls).toContainEqual(["get_range_files", { cwd: CWD, from: null, to: "abc1234" }]);
    expect(root().querySelector(".cm-tab.on").dataset.tab).toBe("src/a.ts");
    root().querySelector('[data-act="scope-back"]').click();
    await settle();
    expect(root().querySelector(".cm-qtitle").textContent).toContain("Unpushed");
  });

  it("Unpushed diffs the upstream against the working tree", async () => {
    openCodeMode(chat({ key: "s3" }), { kind: "scope", scope: "unpushed" });
    await settle();
    expect(calls).toContainEqual(["get_range_files", { cwd: CWD, from: "@{u}", to: null }]);
  });

  it("Push sends, then reloads and tells the chat its git changed", async () => {
    const c = chat({ key: "s4" });
    openCodeMode(c, { kind: "scope", scope: "unpushed", commitsOpen: true });
    await settle();
    root().querySelector('[data-act="push"]').click();
    await settle();
    expect(calls).toContainEqual(["push_commits", { cwd: CWD, publish: false }]);
    expect(c.onGitChanged).toHaveBeenCalled();
  });

  it("right-click on empty tree space offers folder-wide expand / collapse", async () => {
    openCodeMode(chat({ key: "s5" }));
    await settle();
    root().querySelector(".cm-tree").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    const items = Array.from(document.querySelectorAll(".cm-ctx .cm-mi"), (i) => i.dataset.ctx);
    expect(items).toEqual(["expand", "collapse"]);
    document.querySelector('.cm-ctx [data-ctx="collapse"]').click();
    expect(root().querySelector('[data-dir="src"]').getAttribute("aria-expanded")).toBe("false");
  });

  it("right-click on a file offers mention, editor, reveal and copy", async () => {
    const c = chat({ key: "s6" });
    openCodeMode(c);
    await settle();
    root().querySelector('[data-file="src/a.ts"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const items = Array.from(document.querySelectorAll(".cm-ctx .cm-mi"), (i) => i.dataset.ctx);
    expect(items).toEqual(["mention", "vscode", "reveal", "copy", "copyrel"]);
    document.querySelector('.cm-ctx [data-ctx="mention"]').click();
    expect(c.mention).toHaveBeenCalledWith("src/a.ts");
    // The message box is under the mode, so mentioning returns to the chat.
    expect(isCodeModeOpen()).toBe(false);
  });

  it("a PR opens scoped to its commits with a pinned Description tab first", async () => {
    const tpl = document.createElement("template");
    tpl.innerHTML = `<div class="pr-modal-body-content"><h1 class="pr-body-title">My PR</h1><p>Body text</p></div>`;
    openCodeMode(chat({ key: "s7" }), { kind: "pr", title: "My PR", commits: [{ sha: "abc1234", msg: "one" }], desc: tpl });
    await settle();
    const first = root().querySelector(".cm-tab");
    expect(first.classList.contains("cm-desc-tab")).toBe(true);
    expect(first.querySelector(".cm-x")).toBeNull();
    expect(root().querySelector(".cm-desc").textContent).toContain("Body text");
    expect(root().querySelector(".cm-ctitle").textContent).toBe("My PR");
  });
  it("on the phone: explorer, then the file as its own screen; back walks out", async () => {
    remote.on = true;
    openCodeMode(chat({ key: "s8" }));
    await settle();
    const body = root().querySelector(".cm-body");
    expect(root().classList.contains("cm-phone")).toBe(true);
    expect(body.dataset.screen).toBe("explorer");
    // No pop-out on the phone.
    expect(root().querySelector('[data-act="popout"]')).toBeNull();

    root().querySelector('[data-file="src/a.ts"]').click();
    await settle();
    expect(body.dataset.screen).toBe("file");

    expect(backHandlers.at(-1)()).toBe(true);
    expect(body.dataset.screen).toBe("explorer");
    expect(backHandlers.at(-1)()).toBe(true);
    expect(isCodeModeOpen()).toBe(false);
    expect(backHandlers).toHaveLength(0);
  });
});
