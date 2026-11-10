// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/quick-view.ts, src/views/sessions/chat-dashboard/chat-view-pref.ts

// Lane 4 of the chat dashboard, drawn: the Links and files card with its three
// quick-view buttons and the read view they open, the Preview window tile that
// opens the panel, the figures beside an approval question, and the Changes
// card behind Joe's section switch.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { readSections } = await import("../src/views/sessions/chat-dashboard/chat-view-pref.ts");
const { PREVIEW_OPEN_EVENT } = await import("../src/shared/chat/chat-preview-card.ts");

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const ASK = "mcp__cc_conductor__ask_user_question";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });

/** Fake Tauri: every command answers from `answers` (a function or a value); the calls are kept. */
let calls = [];
let answers = {};
function installTauri() {
  calls = [];
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (!(cmd in answers)) throw new Error(`unmocked ${cmd}`);
        const a = answers[cmd];
        return typeof a === "function" ? a(args) : a;
      },
    },
    event: { listen: async () => () => {} },
  };
  resetTransportForTests();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.querySelectorAll(".cdash-qvm").forEach((e) => e.remove());
  answers = {};
  setSettings({});
  installTauri();
});

function mountPane() {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell"><div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  r.sessionId = "sess-1";
  return { pane, r };
}

const feed = (r, evs) => evs.forEach((e) => r.handleEvent(e));
const send = (input) => { const id = `m${++seq}`; return [toolUseEvent(SEND, input, id), ok(id)]; };
const plan = (steps) => { const id = `p${++seq}`; return [toolUseEvent(PLAN, { steps }, id), ok(id)]; };
const tool = (name, input) => { const id = `t${++seq}`; return [toolUseEvent(name, input, id), ok(id)]; };
const tick = (ms = 20) => new Promise((res) => setTimeout(res, ms));

const meta = (id, over = {}) => ({ id, slug: `slug-${id}`, title: `Title ${id}`, source: "chat", session_id: "sess-1", version: 1, created_at: "", published: null, versions: [], shared: false, ...over });

describe("Links and files", () => {
  it("lists links and files and carries the three quick-view buttons", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("ship the fix"),
      ...send({ kind: "artifact", text: "PR https://github.com/acme/app/pull/42 and the file C:\\proj\\src\\a.ts" }),
      ...tool("Edit", { file_path: "C:\\proj\\src\\b.ts", old_string: "a", new_string: "b" }),
    ]);
    await tick();
    const card = pane.querySelector(".cdash-links");
    expect(card).not.toBeNull();
    const link = card.querySelector("a.cdash-link");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(link.textContent).toContain("PR #42");
    const chips = [...card.querySelectorAll(".file-ref")].map((c) => c.dataset.path);
    expect(chips).toEqual(expect.arrayContaining(["C:\\proj\\src\\a.ts", "C:\\proj\\src\\b.ts"]));
    expect(card.querySelector(".cdash-touched")).not.toBeNull();
    expect([...card.querySelectorAll("[data-act='quick-view']")].map((b) => b.dataset.view)).toEqual(["plan", "decided", "memory"]);
  });

  it("draws no card for a one-question chat", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("what is X?"), ...send({ kind: "answer", verdict: "Y", text: "Y." })]);
    await tick();
    expect(pane.querySelector(".cdash-links")).toBeNull();
  });

  it("opens Decided in a read view and says so when there is none", async () => {
    answers.chat_quick_view = ({ view }) => view === "decided"
      ? { view, title: "Decided", docs: [], message: "Nothing decided yet: this chat has no decisions log." }
      : { view, title: view, docs: [{ name: "x.md", body: "# hi" }], message: "" };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("go"), ...plan([{ text: "s", status: "active" }])]);
    await tick();
    // The first draw looked each view up: Decided has nothing, so it reads muted.
    expect(pane.querySelector("[data-view='decided']").classList.contains("is-none")).toBe(true);
    expect(pane.querySelector("[data-view='plan']").classList.contains("is-none")).toBe(false);
    pane.querySelector("[data-view='decided']").click();
    await tick();
    const dlg = document.querySelector(".cdash-qvm");
    expect(dlg).not.toBeNull();
    expect(dlg.querySelector(".cdash-qvm-none").textContent).toContain("Nothing decided yet");
    expect(calls.filter((c) => c.cmd === "chat_quick_view" && c.args.sessionId === "sess-1" && c.args.view === "decided").length).toBeGreaterThan(0);
    dlg.querySelector(".cdash-qvm-x").click();
    expect(document.querySelector(".cdash-qvm")).toBeNull();
  });

  it("shows Project memory's files with a list to pick from, read-only", async () => {
    answers.chat_quick_view = () => ({
      view: "memory",
      title: "Project memory",
      docs: [{ name: "MEMORY.md", body: "- [a](a.md)" }, { name: "a.md", body: "# Fact A\nbody" }],
      message: "",
    });
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("go"), ...plan([{ text: "s", status: "active" }])]);
    await tick();
    pane.querySelector("[data-view='memory']").click();
    await tick();
    const dlg = document.querySelector(".cdash-qvm");
    expect([...dlg.querySelectorAll(".cdash-qvm-file")].map((b) => b.textContent)).toEqual(["MEMORY.md", "a.md"]);
    dlg.querySelectorAll(".cdash-qvm-file")[1].click();
    expect(dlg.querySelector(".cdash-qvm-doc").textContent).toContain("Fact A");
    expect(dlg.querySelector("textarea, input, [contenteditable]")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cdash-qvm")).toBeNull();
  });
});

describe("Preview window", () => {
  it("draws the newest preview as a tile that opens the panel, with a count of the rest", async () => {
    answers.list_previews = [meta("b"), meta("a")];
    answers.get_preview = { id: "b", html: "<p>hi</p>" };
    answers.render_preview_doc = "http://127.0.0.1:1/doc";
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("show me")]);
    await tick(60);
    const tile = pane.querySelector(".cdash-pv-tile");
    expect(tile).not.toBeNull();
    expect(tile.dataset.slug).toBe("slug-b");
    expect(pane.querySelector(".cdash-pv-title").textContent).toBe("Title b");
    expect(pane.querySelector(".cdash-pv-more").textContent).toContain("+1 more");
    // The page is staged once and the frame points at it.
    await tick(60);
    expect(pane.querySelector(".cdash-pv-frame").getAttribute("src")).toBe("http://127.0.0.1:1/doc");
    let opened = null;
    window.addEventListener(PREVIEW_OPEN_EVENT, (e) => { opened = e.detail.slug; }, { once: true });
    tile.click();
    expect(opened).toBe("slug-b");
  });

  it("draws nothing when the chat has no previews, or Joe switched the section off", async () => {
    answers.list_previews = [];
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("hi")]);
    await tick();
    expect(pane.querySelector(".cdash-preview")).toBeNull();

    answers.list_previews = [meta("p")];
    setSettings({ dashboardSections: { preview: false } });
    const second = mountPane();
    new ChatDashboard(second.pane, second.r);
    feed(second.r, [userEvent("hi")]);
    await tick();
    expect(second.pane.querySelector(".cdash-preview")).toBeNull();
  });
});

describe("Figures on the approval question", () => {
  it("shows the message's table with the question in Waiting on you", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("pick one"),
      ...send({ kind: "call", verdict: "Two options", text: "Compare.", visuals: [{ type: "table", title: "Cost", columns: ["Plan", "Price"], rows: [["A", "1"], ["B", "2"]] }] }),
      toolUseEvent(ASK, { questions: [{ question: "Which plan?", options: [{ label: "A" }, { label: "B" }] }] }, "q1"),
    ]);
    await tick();
    const waiting = pane.querySelector(".cdash-waiting");
    expect(waiting.querySelector(".cdash-figs table")).not.toBeNull();
    // The figures sit above the question card they belong to.
    const figs = waiting.querySelector(".cdash-figs");
    const q = waiting.querySelector(".question-card");
    expect(figs.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Changes", () => {
  it("stays hidden until Joe switches it on, then lists the edited files", async () => {
    const { pane, r } = mountPane();
    const dash = new ChatDashboard(pane, r);
    feed(r, [userEvent("fix"), ...tool("Edit", { file_path: "C:\\p\\a.ts", old_string: "a", new_string: "b" })]);
    await tick();
    expect(pane.querySelector(".cdash-changes")).toBeNull();
    setSettings({ dashboardSections: { changes: true } });
    dash.schedule();
    await tick();
    const card = pane.querySelector(".cdash-changes");
    expect(card).not.toBeNull();
    expect(card.querySelector(".file-ref").dataset.path).toBe("C:\\p\\a.ts");
    expect(card.textContent).toContain("1 edit");
  });

  it("reads only booleans from the saved section choices", () => {
    expect(readSections({})).toEqual({});
    expect(readSections({ dashboardSections: { changes: true, links: "yes", preview: false } })).toEqual({ changes: true, preview: false });
    expect(readSections({ dashboardSections: ["x"] })).toEqual({});
  });
});
