// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/shared/chat/chat-draft-card.ts

// The Drafts card, drawn: a write_draft lands as one card in the left column,
// the newest open; Copy marks it copied in the store, Edit hands it to the
// Drafts panel, the chevron folds it, and copied drafts fold under "N copied".

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { DRAFT_OPEN_EVENT } = await import("../src/shared/chat/chat-draft-card.ts");
const { MCP_WRITE_DRAFT_TOOL } = await import("../src/shared/chat/tool-meta.ts");

let calls = [];
let answers = {};
let onDraftsChanged = null;
function installTauri() {
  calls = [];
  onDraftsChanged = null;
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (!(cmd in answers)) throw new Error(`unmocked ${cmd}`);
        const a = answers[cmd];
        return typeof a === "function" ? a(args) : a;
      },
    },
    event: {
      listen: async (name, cb) => {
        if (name === "message-drafts-changed") onDraftsChanged = cb;
        return () => {};
      },
    },
  };
  resetTransportForTests();
}

beforeEach(() => {
  document.body.innerHTML = "";
  answers = { list_previews: [] };
  setSettings({});
  installTauri();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async () => {}, writeText: async () => {} } });
});

const variant = (recipient, body, n = 1, author = "ai") => ({
  recipient, handle_n: 1, current: n,
  versions: [{ n, body, author, note: "", created_at: "" }],
  person: null, platform: null, sent: false,
});
const stored = (id, topic, v, state = "needs-you") => ({
  id, topic, brief: "", receipts: [], variants: [v], state, origin_session_id: "sess-1", origin_label: "", created_at: "", updated_at: "", seen_by_origin: true,
});

let seq = 0;
function writeDraft(input, draft) {
  const id = `w${++seq}`;
  return [
    toolUseEvent(MCP_WRITE_DRAFT_TOOL, input, id),
    { type: "tool_result", tool_use_id: id, timestamp: 0, is_error: false, output: { type: "text", text: JSON.stringify({ ok: true, draft }) } },
  ];
}

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
const tick = (ms = 120) => new Promise((res) => setTimeout(res, ms));

const BRUNO = stored("a", "Release date", variant("Bruno", "Hey **Bruno**, Thursday."));
const SC = stored("b", "Fix shipped", variant("sc-1234", "Fixed in v0.2.150."));

describe("Drafts card", () => {
  it("draws the newest draft open and older ones folded, with the store's version", async () => {
    const store = [BRUNO, { ...SC, variants: [variant("sc-1234", "Fixed, edited by Joe.", 2, "user")] }];
    answers.list_message_drafts = { drafts: store };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("draft a reply to bruno and a comment on sc-1234"),
      ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "Hey **Bruno**, Thursday." }, BRUNO),
      ...writeDraft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "Fixed in v0.2.150." }, SC),
    ]);
    await tick(300);
    const card = pane.querySelector(".cdash-left .cdash-drafts");
    expect(card).not.toBeNull();
    expect(card.querySelector(".cdash-count").textContent).toBe("2 to send");
    const rows = [...card.querySelectorAll(".msg.draft-card")];
    expect(rows).toHaveLength(2);
    // Newest first, open, with the store's text and Joe's edit named.
    expect(rows[0].classList.contains("open")).toBe(true);
    expect(rows[0].querySelector(".dc-body").textContent).toContain("Fixed, edited by Joe.");
    expect(rows[0].querySelector(".dc-ver").textContent).toBe("v2 · your edit");
    expect(rows[1].classList.contains("open")).toBe(false);
    // Edit, not the transcript's pop-out arrow.
    expect(rows[0].querySelector("[data-draft-pop] .ph-pencil-simple")).not.toBeNull();
    // The transcript's live-refresh sweep must not reach these cards.
    expect(card.querySelector("[data-draft-id]")).toBeNull();
  });

  it("Edit opens the Drafts panel on that draft", async () => {
    answers.list_message_drafts = { drafts: [BRUNO] };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("draft it"), ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO)]);
    await tick();
    const opened = [];
    const on = (e) => opened.push(e.detail.id);
    window.addEventListener(DRAFT_OPEN_EVENT, on);
    pane.querySelector(".cdash-drafts [data-draft-pop]").click();
    window.removeEventListener(DRAFT_OPEN_EVENT, on);
    expect(opened).toEqual(["a"]);
  });

  it("the chevron folds and unfolds a draft", async () => {
    answers.list_message_drafts = { drafts: [BRUNO] };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("draft it"), ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO)]);
    await tick();
    const row = () => pane.querySelector(".cdash-drafts .msg.draft-card");
    expect(row().classList.contains("open")).toBe(true);
    row().querySelector("[data-draft-toggle]").click();
    expect(row().classList.contains("open")).toBe(false);
    row().querySelector("[data-draft-toggle]").click();
    expect(row().classList.contains("open")).toBe(true);
  });

  it("Copy marks the draft copied, and it folds under '1 copied' once the store says so", async () => {
    let store = [BRUNO, SC];
    answers.list_message_drafts = () => ({ drafts: store });
    answers.set_draft_state = ({ id }) => {
      store = store.map((d) => (d.id === id ? { ...d, state: "copied" } : d));
      return null;
    };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("two drafts"),
      ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO),
      ...writeDraft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "y" }, SC),
    ]);
    await tick();
    pane.querySelector(".cdash-drafts .msg.draft-card [data-draft-copy]").click();
    await tick();
    expect(calls.find((c) => c.cmd === "set_draft_state")?.args).toEqual({ sessionId: "sess-1", id: "b", next: "copied" });
    // The daemon announces the change; the card reads the store again.
    onDraftsChanged?.({ payload: null });
    await tick(250);
    const card = pane.querySelector(".cdash-drafts");
    expect(card.querySelectorAll(".msg.draft-card")).toHaveLength(1);
    const fold = card.querySelector("[data-act='drafts-copied']");
    expect(fold.textContent).toContain("1 copied");
    fold.click();
    // The click redraws the card, so it is looked up again.
    const rows = [...pane.querySelectorAll(".cdash-drafts .msg.draft-card")];
    expect(rows).toHaveLength(2);
    expect(rows[1].classList.contains("copied")).toBe(true);
  });

  it("reads the store again after a failed read", async () => {
    ChatDashboard.draftRetryMs = 60;
    let fail = true;
    answers.list_message_drafts = () => {
      if (fail) { fail = false; throw new Error("daemon busy"); }
      return { drafts: [{ ...BRUNO, variants: [variant("Bruno", "edited", 2, "user")] }] };
    };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("draft it"), ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO)]);
    await tick(300);
    ChatDashboard.draftRetryMs = 5000;
    expect(calls.filter((c) => c.cmd === "list_message_drafts").length).toBeGreaterThanOrEqual(2);
    expect(pane.querySelector(".cdash-drafts .dc-ver").textContent).toBe("v2 · your edit");
  });

  it("stops reading after three failed reads in a row (a chat the daemon does not know)", async () => {
    ChatDashboard.draftRetryMs = 20;
    answers.list_message_drafts = () => { throw new Error("unknown session"); };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("draft it"), ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO)]);
    await tick(600);
    const reads = () => calls.filter((c) => c.cmd === "list_message_drafts").length;
    const settled = reads();
    // The open read (no draft rows yet) may overlap the first read naming "a";
    // the three failures that count come after it.
    expect(settled).toBeGreaterThanOrEqual(3);
    expect(settled).toBeLessThanOrEqual(4);
    r.handleEvent(userEvent("and another flush"));
    await tick(300);
    ChatDashboard.draftRetryMs = 5000;
    expect(reads()).toBe(settled);
    // The card still draws from the chat's own rows.
    expect(pane.querySelector(".cdash-drafts .msg.draft-card")).not.toBeNull();
  });

  it("draws no Drafts card when Joe switched the section off", async () => {
    setSettings({ dashboardSections: { drafts: false } });
    answers.list_message_drafts = { drafts: [BRUNO] };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("draft it"), ...writeDraft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, BRUNO)]);
    await tick();
    expect(pane.querySelector(".cdash-drafts")).toBeNull();
  });
});
