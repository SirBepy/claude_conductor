// @vitest-environment jsdom
//
// Per-tool chips: in the rows model each tool is its own placeable chip
// (`tool:Read`, ...) rendered inline in its row, still opening its OWN
// drill-down popover listing that tool's distinct targets. The global
// hideZero setting drops zero-count chips. This drives the real
// SessionStatusbar so a regression in the chip build or the popover DOM is
// caught. Tauri `invoke` is mocked (jsdom has no backend).

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { setCodeModeOpener } = await import("../src/shared/chat/code-mode-bridge.ts");

/** Captures what a file row asks Code mode to open. */
function codeModeTargets() {
  const targets = [];
  setCodeModeOpener((t) => targets.push(t));
  return targets;
}

const TOOL_ROW = [["tool:Read", "tool:Grep", "tool:Edit", "tool:Bash"]];

function mount(rows = TOOL_ROW, opts = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, rows, { sessionId: "sess-1", hideZero: true, ...opts });
  return { el, sb };
}

function item(over) {
  return { label: "", kind: "file", path: undefined, filename: undefined, count: 1, ...over };
}

function sampleTally() {
  return {
    byType: [
      { tool: "Read", count: 4, items: [
        item({ label: "a.ts", kind: "file", path: "/proj/src/a.ts", count: 1 }),
        item({ label: "b.ts", kind: "file", path: "/proj/src/b.ts", count: 2 }),
        item({ label: "shot.png", kind: "image", path: "/proj/shot.png", filename: "shot.png", count: 1 }),
      ] },
      { tool: "Grep", count: 3, items: [
        item({ label: "foo.*bar", kind: "text", count: 3 }),
      ] },
      { tool: "Edit", count: 6, items: [item({ label: "c.ts", kind: "file", path: "/proj/src/c.ts", count: 6 })] },
      { tool: "Bash", count: 5, items: [item({ label: "List files", kind: "text", count: 5 })] },
    ],
  };
}

function openChip(el, tool) {
  el.querySelector(`.sb-tally-chip[data-tool="${tool}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("per-tool chips", () => {
  it("renders one chip per placed tool type with friendly labels, counts and data-tool", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    const chips = [...el.querySelectorAll(".sb-tally-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Read x4", "Grep x3", "File Changes x6", "Ran x5"]);
    const tools = [...el.querySelectorAll(".sb-tally-chip")].map((c) => c.dataset.tool);
    expect(tools).toEqual(["Read", "Grep", "Edit", "Bash"]);
  });

  it("renders each configured row as its own .sb-row line", () => {
    const { el } = mount([["clock"], ["clock"]]);
    expect(el.querySelectorAll(".sb-row").length).toBe(2);
  });

  it("global hideZero drops zero-count tool chips", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    expect(el.querySelectorAll(".sb-tally-chip").length).toBe(4);
    sb.updateToolTally({ byType: [] }); // every count now 0
    expect(el.querySelectorAll(".sb-tally-chip").length).toBe(0);
  });

  it("with hideZero off, zero-count tool chips still show x0", () => {
    const { el, sb } = mount(TOOL_ROW, { hideZero: false });
    sb.updateToolTally({ byType: [{ tool: "Read", count: 0, items: [] }] });
    const read = el.querySelector('.sb-tally-chip[data-tool="Read"]');
    expect(read).not.toBeNull();
    expect(read.textContent).toBe("Read x0");
  });

  it("opens a per-tool popover listing that tool's files and images", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    const pop = document.body.querySelector(".sb-tally-popover");
    expect(pop).not.toBeNull();
    expect(pop.querySelector(".sb-tally-tab")).toBeNull();
    const files = [...pop.querySelectorAll(".sb-tally-file .sb-tally-name")].map((n) => n.textContent);
    expect(files).toEqual(["a.ts", "b.ts"]);
    const media = [...pop.querySelectorAll(".sb-tally-media .sb-tally-name")].map((n) => n.textContent);
    expect(media).toEqual(["shot.png"]);
  });

  it("lists text targets (Grep patterns) for a text tool", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Grep");
    const pop = document.body.querySelector(".sb-tally-popover");
    const texts = [...pop.querySelectorAll(".sb-tally-text .sb-tally-name")].map((n) => n.textContent);
    expect(texts).toEqual(["foo.*bar"]);
  });

  it("toggles a chip's popover closed on second click and swaps between chips", () => {
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    expect(document.body.querySelector(".sb-tally-popover")).not.toBeNull();
    openChip(el, "Read");
    expect(document.body.querySelector(".sb-tally-popover")).toBeNull();
    openChip(el, "Grep");
    const texts = [...document.body.querySelectorAll(".sb-tally-text .sb-tally-name")].map((n) => n.textContent);
    expect(texts).toEqual(["foo.*bar"]);
  });

  it("opens a file row's file in Code mode", () => {
    const targets = codeModeTargets();
    const { el, sb } = mount();
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    document.body.querySelector(".sb-tally-file").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(targets).toEqual([{ kind: "file", path: "/proj/src/a.ts" }]);
    // The popover gets out of the way of the mode it opened.
    expect(document.body.querySelector(".sb-tally-popover")).toBeNull();
  });
});

describe("custom-view provider (reuses the in-chat views)", () => {
  it("renders the provider HTML for custom tools and opens files in Code mode", () => {
    const targets = codeModeTargets();
    const { el, sb } = mount([["tool:Read", "tool:Skill", "tool:AskUserQuestion"]]);
    sb.setToolViewProvider((tool) => {
      if (tool === "Read") return '<button class="tool-file-row" data-path="/p/x.ts"><span class="tool-file-name">x.ts</span></button>';
      if (tool === "Skill") return '<div class="tool-skill-row"><span class="tool-skill-name">commit</span></div>';
      if (tool === "AskUserQuestion") return '<div class="tool-qa"><div class="tool-qa-q">Q?</div></div>';
      return null;
    });
    sb.updateToolTally({ byType: [
      { tool: "Read", count: 1, items: [] },
      { tool: "Skill", count: 2, items: [] },
      { tool: "AskUserQuestion", count: 1, items: [] },
    ] });

    openChip(el, "Skill");
    expect(document.body.querySelector(".sb-tally-popover .tool-skill-row .tool-skill-name").textContent).toBe("commit");
    openChip(el, "Skill"); // close

    openChip(el, "AskUserQuestion");
    expect(document.body.querySelector(".sb-tally-popover .tool-qa .tool-qa-q").textContent).toBe("Q?");
    openChip(el, "AskUserQuestion"); // close

    openChip(el, "Read");
    const fileRow = document.body.querySelector(".sb-tally-popover .tool-file-row");
    expect(fileRow).not.toBeNull();
    fileRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(targets).toEqual([{ kind: "file", path: "/p/x.ts" }]);
  });

  it("falls back to the target list when no provider is set", () => {
    const { el, sb } = mount([["tool:Read"]]);
    sb.updateToolTally(sampleTally());
    openChip(el, "Read");
    expect(document.body.querySelector(".sb-tally-popover .sb-tally-file")).not.toBeNull();
  });
});
