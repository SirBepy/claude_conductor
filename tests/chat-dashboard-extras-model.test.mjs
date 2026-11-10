// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/dashboard/links-model.ts

// Lane 4 of the chat dashboard: the Links and files card, the Preview window
// card, figures on a question, and the optional Changes card. These drive real
// events through a real renderer and check what each zone would show.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent, assistantEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, ZONES, SECTION_DEFAULTS, sectionOn } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { classifyUrl, extractLinks, extractFiles, changedFiles } = await import("../src/shared/chat/dashboard/links-model.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const ASK = "mcp__cc_conductor__ask_user_question";

let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 });

function chat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  const api = {
    r,
    joe(text) { r.handleEvent(userEvent(text)); return api; },
    send(input) { const id = `m${++seq}`; r.handleEvent(toolUseEvent(SEND, input, id)); r.handleEvent(ok(id)); return api; },
    plan(steps) { const id = `p${++seq}`; r.handleEvent(toolUseEvent(PLAN, { steps }, id)); r.handleEvent(ok(id)); return api; },
    tool(name, input) { const id = `t${++seq}`; r.handleEvent(toolUseEvent(name, input, id)); r.handleEvent(ok(id)); return api; },
    ask(question) { r.handleEvent(toolUseEvent(ASK, { questions: [{ question, options: [{ label: "A" }] }] }, `q${++seq}`)); return api; },
    dash(extra = {}) { return deriveDashboard({ messages: r.messages, plan: r.dashPlan, ...extra }); },
  };
  return api;
}

const zone = (d, id) => [...d.left, ...d.right].find((z) => z.id === id)?.state ?? null;
const meta = (id, over = {}) => ({ id, slug: id, title: `Title ${id}`, source: "chat", session_id: "s", version: 1, created_at: "", published: null, versions: [], shared: false, ...over });

describe("classifyUrl", () => {
  it("names a PR, a CI run, an issue, a commit and a tracker ticket", () => {
    expect(classifyUrl("https://github.com/acme/app/pull/42")).toEqual({ kind: "pr", label: "PR #42 in acme/app" });
    expect(classifyUrl("https://github.com/acme/app/actions/runs/9001")).toEqual({ kind: "ci", label: "CI run 9001 in acme/app" });
    expect(classifyUrl("https://github.com/acme/app/issues/7").kind).toBe("ticket");
    expect(classifyUrl("https://github.com/acme/app/commit/abcdef1234567").label).toBe("Commit abcdef12");
    expect(classifyUrl("https://linear.app/acme/issue/abc-123/some-title")).toEqual({ kind: "ticket", label: "ABC-123" });
    expect(classifyUrl("https://app.shortcut.com/acme/story/12345/x")).toEqual({ kind: "ticket", label: "Story 12345" });
    expect(classifyUrl("https://acme.atlassian.net/browse/PROJ-9")).toEqual({ kind: "ticket", label: "PROJ-9" });
  });

  it("falls back to host and path for any other address", () => {
    expect(classifyUrl("https://www.example.com/docs/page")).toEqual({ kind: "link", label: "example.com/docs/page" });
    expect(classifyUrl("https://example.com/")).toEqual({ kind: "link", label: "example.com" });
  });
});

describe("Links and files", () => {
  it("collects links from a message's text and details, newest first, each address once", () => {
    const c = chat()
      .joe("ship it")
      .send({ kind: "report", verdict: "Opened", text: "PR is https://github.com/acme/app/pull/42.\nCI: https://github.com/acme/app/actions/runs/9001", details: [{ id: "d", label: "d", body_md: "see https://example.com/spec and https://github.com/acme/app/pull/42" }] })
      .send({ kind: "artifact", text: "Ticket https://linear.app/acme/issue/ABC-123/x" });
    const links = extractLinks(c.r.messages);
    // Newest message first; inside one message the later text wins.
    expect(links.map((l) => l.label)).toEqual(["ABC-123", "PR #42 in acme/app", "example.com/spec", "CI run 9001 in acme/app"]);
    expect(links.filter((l) => l.kind === "pr")).toHaveLength(1);
    // A trailing full stop is prose, not part of the address.
    expect(links.find((l) => l.kind === "pr").url).toBe("https://github.com/acme/app/pull/42");
  });

  it("ignores a refused or retracted message and a sub's card", () => {
    const c = chat().send({ kind: "answer", verdict: "Yes", text: "https://example.com/kept" });
    expect(extractLinks(c.r.messages).map((l) => l.url)).toEqual(["https://example.com/kept"]);
    const refused = { ...c.r.messages[0], failed: true };
    expect(extractLinks([refused])).toEqual([]);
    expect(extractLinks([{ ...c.r.messages[0], retracted: true }])).toEqual([]);
    expect(extractLinks([{ ...c.r.messages[0], subCard: { sub_id: "x", id: "y", kind: "report" } }])).toEqual([]);
  });

  it("lists a pr_preview draft as a title with no address", () => {
    const c = chat();
    c.r.handleEvent(toolUseEvent("mcp__cc_conductor__pr_preview", { title: "Add Trello", body: "b", commits: [] }, "pr1"));
    c.r.handleEvent(ok("pr1"));
    const links = extractLinks(c.r.messages);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "draft", url: null, label: "PR draft: Add Trello" });
  });

  it("lists files the chat edited or named, an edited file marked touched, each path once", () => {
    const c = chat()
      .joe("fix it")
      .send({ kind: "answer", verdict: "Found", text: "The bug is in C:\\proj\\src\\a.ts:12 and /home/u/proj/b.ts" })
      .tool("Edit", { file_path: "C:\\proj\\src\\a.ts", old_string: "x", new_string: "y" })
      .tool("Write", { file_path: "C:\\proj\\src\\new.ts", content: "z" });
    const files = extractFiles(c.r.messages);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.touched]));
    expect(byPath["C:\\proj\\src\\a.ts"]).toBe(true);
    expect(byPath["C:\\proj\\src\\new.ts"]).toBe(true);
    expect(byPath["/home/u/proj/b.ts"]).toBe(false);
    expect(files.filter((f) => f.path.toLowerCase().endsWith("a.ts"))).toHaveLength(1);
  });

  it("draws only with content: a one-question chat has no card, a chat with a plan has it for the buttons", () => {
    const quick = chat().joe("what is X?").send({ kind: "answer", verdict: "Y", text: "Y." });
    expect(zone(quick.dash(), "links")).toBeNull();
    const job = chat().joe("build it").plan([{ text: "step", status: "active" }]);
    expect(zone(job.dash(), "links")).toEqual({ links: [], files: [] });
    const linked = chat().joe("?").send({ kind: "artifact", text: "https://example.com/x" });
    expect(zone(linked.dash(), "links").links).toHaveLength(1);
  });

  it("sits in the right column below Plan", () => {
    expect(ZONES.links.column).toBe("right");
    expect(ZONES.links.order).toBeGreaterThan(ZONES.plan.order);
    expect(ZONES.preview.column).toBe("right");
    expect(ZONES.preview.order).toBeGreaterThan(ZONES.plan.order);
  });
});

describe("Preview window", () => {
  it("shows the newest preview and how many more the panel holds", () => {
    const c = chat().joe("show me");
    expect(zone(c.dash(), "preview")).toBeNull();
    const state = zone(c.dash({ previews: [meta("new"), meta("old"), meta("older")] }), "preview");
    expect(state.newest.id).toBe("new");
    expect(state.others).toBe(2);
  });

  it("is switched off by Joe's section choice", () => {
    const c = chat().joe("show me");
    expect(zone(c.dash({ previews: [meta("p")], sections: { preview: false } }), "preview")).toBeNull();
  });
});

describe("Figures on the approval question", () => {
  const table = { type: "table", title: "Cost", columns: ["Plan", "Price"], rows: [["A", "1"], ["B", "2"]] };

  it("carries the visuals of the message sent just before the question", () => {
    const c = chat().joe("go").send({ kind: "call", verdict: "Two options", text: "Compare.", visuals: [table] }).ask("Which plan?");
    const waiting = zone(c.dash(), "waiting");
    expect(waiting.items).toHaveLength(1);
    expect(waiting.items[0].type).toBe("question");
    expect(waiting.items[0].figures).toHaveLength(1);
    expect(waiting.items[0].figures[0].type).toBe("table");
  });

  it("carries none when Joe wrote in between, or the message had no visuals", () => {
    const wrote = chat().send({ kind: "call", verdict: "v", text: "t", visuals: [table] }).joe("hm").ask("Which plan?");
    expect(zone(wrote.dash(), "waiting").items[0].figures).toEqual([]);
    const plain = chat().joe("go").send({ kind: "call", verdict: "v", text: "t" }).ask("Which plan?");
    expect(zone(plain.dash(), "waiting").items[0].figures).toEqual([]);
  });

  it("does not borrow the figures of an earlier question's message", () => {
    const c = chat().joe("go").send({ kind: "call", verdict: "v", text: "t", visuals: [table] }).ask("First?").ask("Second?");
    const items = zone(c.dash(), "waiting").items;
    expect(items[0].figures).toHaveLength(1);
    expect(items[1].figures).toEqual([]);
  });
});

describe("Changes", () => {
  it("is off unless Joe turns it on", () => {
    expect(SECTION_DEFAULTS.changes).toBe(false);
    const c = chat().joe("fix").tool("Edit", { file_path: "C:\\p\\a.ts", old_string: "a", new_string: "b" });
    expect(zone(c.dash(), "changes")).toBeNull();
    expect(zone(c.dash({ sections: { changes: true } }), "changes").files).toEqual([{ path: "C:\\p\\a.ts", edits: 1 }]);
  });

  it("counts edits per file since Joe last wrote, most edited first", () => {
    const c = chat()
      .joe("round one")
      .tool("Edit", { file_path: "C:\\p\\old.ts", old_string: "a", new_string: "b" })
      .joe("round two")
      .tool("Edit", { file_path: "C:\\p\\a.ts", old_string: "a", new_string: "b" })
      .tool("MultiEdit", { file_path: "C:\\p\\b.ts", edits: [] })
      .tool("Edit", { file_path: "C:\\p\\b.ts", old_string: "a", new_string: "b" });
    const files = zone(c.dash({ sections: { changes: true } }), "changes").files;
    expect(files).toEqual([{ path: "C:\\p\\b.ts", edits: 2 }, { path: "C:\\p\\a.ts", edits: 1 }]);
    expect(changedFiles(c.r.messages, 0).map((f) => f.path)).toContain("C:\\p\\old.ts");
  });

  it("ignores a file a sub-agent touched", () => {
    const c = chat().joe("fix");
    c.r.handleEvent({ ...toolUseEvent("Edit", { file_path: "C:\\p\\x.ts" }, "e1"), parent_tool_use_id: "agent1" });
    expect(zone(c.dash({ sections: { changes: true } }), "changes")).toBeNull();
  });
});

describe("section switches", () => {
  it("default Links and Preview on and Changes off, and leave the other zones alone", () => {
    expect(sectionOn(undefined, "links")).toBe(true);
    expect(sectionOn(undefined, "preview")).toBe(true);
    expect(sectionOn(undefined, "changes")).toBe(false);
    expect(sectionOn({ links: false }, "links")).toBe(false);
    expect(sectionOn({ links: false }, "plan")).toBe(true);
  });

  it("hides Links and files when Joe switches it off", () => {
    const c = chat().joe("?").send({ kind: "artifact", text: "https://example.com/x" });
    expect(zone(c.dash({ sections: { links: false } }), "links")).toBeNull();
  });
});

void assistantEvent;
