// @vitest-environment jsdom
// asserts: src/shared/chat/dashboard/drafts-model.ts, src/shared/chat/dashboard/dashboard-model.ts

// The dashboard's Drafts card, as data: write_draft calls driven through a real
// renderer, then what the card would list. One card per draft (not per call),
// newest first, the store's current text once read, copied ones apart, dropped
// and deleted ones gone.

import { describe, it, expect, beforeEach } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { deriveDashboard, ZONES, SECTION_DEFAULTS } = await import("../src/shared/chat/dashboard/dashboard-model.ts");
const { MCP_WRITE_DRAFT_TOOL } = await import("../src/shared/chat/tool-meta.ts");

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.window.__TAURI__ = undefined;
  resetTransportForTests();
});

let seq = 0;

const variant = (recipient, bodies, over = {}) => ({
  recipient,
  handle_n: 1,
  current: bodies.length,
  versions: bodies.map((b, i) => ({ n: i + 1, body: typeof b === "string" ? b : b.body, author: typeof b === "string" ? "ai" : b.author, note: "", created_at: "" })),
  person: null,
  platform: null,
  sent: false,
  ...over,
});
const stored = (id, topic, variants, state = "needs-you") => ({
  id, topic, brief: "", receipts: [], variants, state, origin_session_id: "s", origin_label: "", created_at: "", updated_at: "", seen_by_origin: true,
});

function chat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  const api = {
    r,
    joe(text) { r.handleEvent(userEvent(text)); return api; },
    /** One write_draft call; `answer` is the store row the route answers with, or null for a failed call. */
    draft(input, answer) {
      const id = `d${++seq}`;
      r.handleEvent(toolUseEvent(MCP_WRITE_DRAFT_TOOL, input, id));
      if (answer !== undefined) {
        r.handleEvent({
          type: "tool_result", tool_use_id: id, timestamp: 0,
          is_error: answer === null,
          output: { type: "text", text: answer === null ? "boom" : JSON.stringify({ ok: true, ...answer }) },
        });
      }
      return api;
    },
    drafts(extra = {}) {
      const d = deriveDashboard({ messages: r.messages, plans: r.dashPlans, ...extra });
      return d.left.find((z) => z.id === "drafts")?.state ?? null;
    },
  };
  return api;
}

const A1 = stored("a", "Release date", [variant("Bruno", ["v1 text"])]);
const A3 = stored("a", "Release date", [variant("Bruno", ["v1 text", "v2 text", { body: "v3 by Joe", author: "user" }])]);
const B1 = stored("b", "Fix shipped", [variant("sc-1234", ["fixed"])]);

describe("Drafts zone", () => {
  it("sits on the left under Waiting on you and is on by default", () => {
    expect(ZONES.drafts.column).toBe("left");
    expect(ZONES.drafts.order).toBeGreaterThan(ZONES.waiting.order);
    expect(SECTION_DEFAULTS.drafts).toBe(true);
  });

  it("draws nothing for a chat with no drafts", () => {
    expect(chat().joe("hi").drafts()).toBeNull();
  });

  it("lists a draft from its own row before the store is read", () => {
    const s = chat().joe("draft it").draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "hey" }, { draft: A1 }).drafts();
    expect(s.toSend).toHaveLength(1);
    expect(s.toSend[0]).toMatchObject({ id: "a", topic: "Release date", body: "hey", copied: false });
    expect(s.copied).toEqual([]);
  });

  it("shows one card per draft however often it was revised, with the store's current text", () => {
    const c = chat().joe("draft it")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "v1 text" }, { draft: A1 })
      .draft({ action: "revise", id: "a", body: "v2 text" }, { draft: A3 });
    const before = c.drafts();
    expect(before.toSend).toHaveLength(1);
    expect(before.toSend[0].body).toBe("v2 text");
    const after = c.drafts({ draftStore: { drafts: [A3], ids: ["a"] } });
    expect(after.toSend).toHaveLength(1);
    expect(after.toSend[0]).toMatchObject({ body: "v3 by Joe", version: "v3 · your edit", recipient: "Bruno #1" });
  });

  it("puts the newest draft first", () => {
    const s = chat().joe("two drafts")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 })
      .draft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "y" }, { draft: B1 })
      .drafts();
    expect(s.toSend.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("keeps a draft from an earlier job until it is copied", () => {
    const s = chat().joe("draft one")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 })
      .joe("something else now")
      .drafts();
    expect(s.toSend.map((d) => d.id)).toEqual(["a"]);
  });

  it("moves a copied draft and a posted wording apart, and hides an archived one", () => {
    const posted = stored("p", "Posted", [variant("Liv", ["done"], { sent: true })]);
    const c = chat().joe("drafts")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 })
      .draft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "y" }, { draft: B1 })
      .draft({ action: "add", topic: "Posted", recipient: "Liv", body: "done" }, { draft: posted });
    const s = c.drafts({ draftStore: { drafts: [{ ...A1, state: "copied" }, { ...B1, state: "archived" }, posted], ids: ["a", "b", "p"] } });
    expect(s.toSend).toEqual([]);
    expect(s.copied.map((d) => d.id)).toEqual(["p", "a"]);
    expect(s.copied[0].sent).toBe(true);
  });

  it("drops a draft Claude dropped or Joe deleted, but keeps one written after the last read", () => {
    const c = chat().joe("drafts")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 })
      .draft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "y" }, { draft: B1 })
      .draft({ action: "drop", id: "b" }, { dropped: "b" });
    // "a" was read before and is gone from the store: deleted in the panel.
    expect(c.drafts({ draftStore: { drafts: [], ids: ["a", "b"] } })).toBeNull();
    // A store read made before "a" existed does not hide it.
    expect(c.drafts({ draftStore: { drafts: [], ids: [] } }).toSend.map((d) => d.id)).toEqual(["a"]);
  });

  it("gives each wording of a multi-person draft its own card", () => {
    const two = stored("m", "Standup", [variant("Bruno", ["for bruno"]), variant("Liv", ["for liv"])]);
    const s = chat().joe("draft for both")
      .draft({ action: "add", topic: "Standup", recipient: "Bruno", body: "for bruno" }, { draft: stored("m", "Standup", [variant("Bruno", ["for bruno"])]) })
      .draft({ action: "variant", id: "m", recipient: "Liv", body: "for liv" }, { draft: two })
      .drafts({ draftStore: { drafts: [two], ids: ["m"] } });
    expect(s.toSend.map((d) => d.body)).toEqual(["for bruno", "for liv"]);
    expect(new Set(s.toSend.map((d) => d.key)).size).toBe(2);
  });

  it("skips a call that failed and shows one still waiting for its answer", () => {
    const c = chat().joe("drafts")
      .draft({ action: "add", topic: "Broken", recipient: "X", body: "x" }, null)
      .draft({ action: "add", topic: "Pending", recipient: "Y", body: "y" });
    const s = c.drafts();
    expect(s.toSend).toHaveLength(1);
    expect(s.toSend[0]).toMatchObject({ id: null, topic: "Pending", body: "y" });
  });

  it("draws no second card while a revise waits for its answer", () => {
    const s = chat().joe("draft it")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "v1 text" }, { draft: A1 })
      .draft({ action: "revise", id: "a", body: "v2 text" })
      .drafts();
    expect(s.toSend).toHaveLength(1);
    expect(s.toSend[0]).toMatchObject({ id: "a", body: "v1 text" });
  });

  it("keeps a card's key when the store read lands, so Joe's fold survives it", () => {
    const c = chat().joe("draft it").draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 });
    const before = c.drafts().toSend[0].key;
    const after = c.drafts({ draftStore: { drafts: [A1], ids: ["a"] } }).toSend[0].key;
    expect(after).toBe(before);
  });

  it("lists the chat's own drafts whose rows are on an older history page", () => {
    const old = { ...stored("o", "Old one", [variant("Liv", ["older text"])]), origin_session_id: "me" };
    const other = { ...stored("x", "Other chat", [variant("Ana", ["not mine"])]), origin_session_id: "someone-else" };
    const s = chat().joe("draft it")
      .draft({ action: "add", topic: "Release date", recipient: "Bruno", body: "x" }, { draft: A1 })
      .drafts({ draftStore: { drafts: [A1, old, other], ids: ["a"], sessionId: "me" } });
    expect(s.toSend.map((d) => d.id)).toEqual(["a", "o"]);
  });

  it("is gone when Joe switches the section off", () => {
    const c = chat().joe("draft").draft({ action: "add", topic: "T", recipient: "Bruno", body: "x" }, { draft: A1 });
    expect(c.drafts({ sections: { drafts: false } })).toBeNull();
  });
});
