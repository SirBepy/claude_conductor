// @vitest-environment jsdom

// The write_draft card: an outbound draft becomes its own message row on BOTH
// the live and scrollback paths, and its tool_result is absorbed rather than
// rendered - that result is the only place the draft id exists for an `add`, so
// losing it is what would silently turn the live card back into a snapshot.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue({ drafts: [] }),
  listenMock: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ listen: listenMock }),
}));

const {
  draftFieldsOf,
  draftResultFieldsOf,
  renderDraftCardHtml,
  mountDraftCard,
  DRAFT_OPEN_EVENT,
} = await import("../src/shared/chat/chat-draft-card.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");
const { isWriteDraftTool, MCP_WRITE_DRAFT_TOOL } = await import("../src/shared/chat/tool-meta.ts");

const ADD = {
  type: "tool_use",
  tool_name: MCP_WRITE_DRAFT_TOOL,
  input: { action: "add", topic: "Sprint slip", recipient: "Bruno", body: "hey **there**" },
  id: "tu-1",
  timestamp: 0n,
  parent_tool_use_id: null,
};

/** The shape `/drafts/write` answers with, as the text block the MCP relay
 *  hands back (`resp.to_string()`, since write_draft declares no success text). */
function resultBlock(draft) {
  return { type: "text", text: JSON.stringify({ ok: true, draft }) };
}

const DRAFT = {
  id: "abcdef12-3456",
  topic: "Sprint slip",
  brief: "",
  receipts: [],
  variants: [
    {
      recipient: "Bruno",
      handle_n: 2,
      current: 1,
      versions: [{ n: 1, body: "hey **there**", author: "ai", note: "", created_at: "2026-09-26T00:00:00Z" }],
    },
  ],
  state: "needs-you",
  origin_session_id: "s1",
  origin_label: "chat A",
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
  seen_by_origin: true,
};

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
  invokeMock.mockResolvedValue({ drafts: [DRAFT] });
  listenMock.mockClear();
});

describe("write_draft field extraction", () => {
  it("recognizes only the MCP wire name", () => {
    expect(isWriteDraftTool(MCP_WRITE_DRAFT_TOOL)).toBe(true);
    expect(isWriteDraftTool("Write")).toBe(false);
  });

  it("reads topic, recipient and body off an add", () => {
    const f = draftFieldsOf(ADD.input);
    expect(f.draftAction).toBe("add");
    expect(f.draftTopic).toBe("Sprint slip");
    expect(f.draftRecipient).toBe("Bruno");
    expect(f.draftBody).toBe("hey **there**");
  });

  it("keeps each of the four actions rather than collapsing them", () => {
    for (const action of ["add", "revise", "variant", "drop"]) {
      expect(draftFieldsOf({ action }).draftAction).toBe(action);
    }
  });

  it("falls back to add for a missing or unknown action", () => {
    expect(draftFieldsOf({}).draftAction).toBe("add");
    expect(draftFieldsOf({ action: "obliterate" }).draftAction).toBe("add");
  });

  it("leaves the topic empty on a revise, which sends only id+body", () => {
    const f = draftFieldsOf({ action: "revise", id: "abc", body: "new text" });
    expect(f.draftTopic).toBe("");
    expect(f.draftBody).toBe("new text");
  });
});

describe("tool_result parsing", () => {
  it("pulls the draft id out of the route's JSON response", () => {
    const f = draftResultFieldsOf(resultBlock(DRAFT));
    expect(f.draftId).toBe("abcdef12-3456");
    expect(f.draftTopic).toBe("Sprint slip");
    expect(f.draftRecipient).toBe("Bruno");
    expect(f.draftVersion).toBe(1);
  });

  it("reads a drop's id off the `dropped` key", () => {
    const f = draftResultFieldsOf({ type: "text", text: JSON.stringify({ ok: true, dropped: "abcdef12-3456" }) });
    expect(f.draftId).toBe("abcdef12-3456");
  });

  it("takes the LAST variant, which is the one a `variant` call just appended", () => {
    const two = {
      ...DRAFT,
      variants: [
        DRAFT.variants[0],
        { recipient: "Ana", handle_n: 3, current: 1, versions: [{ n: 1, body: "plain", author: "ai", note: "", created_at: "x" }] },
      ],
    };
    expect(draftResultFieldsOf(resultBlock(two)).draftRecipient).toBe("Ana");
  });

  it("returns null rather than throwing on anything that is not the route's JSON", () => {
    expect(draftResultFieldsOf(null)).toBeNull();
    expect(draftResultFieldsOf({ type: "text", text: "not json at all" })).toBeNull();
    expect(draftResultFieldsOf({ type: "text", text: JSON.stringify({ ok: false, error: "nope" }) })).toBeNull();
    expect(draftResultFieldsOf({ type: "image", mime: "image/png", data: "x" })).toBeNull();
  });
});

describe("scrollback path", () => {
  it("maps a write_draft tool_use to a draft row, not hidden narration", () => {
    const m = eventToRenderedMessage(ADD);
    expect(m.kind).toBe("draft");
    expect(m.draftTopic).toBe("Sprint slip");
  });

  it("leaves a subagent's own write as a plain tool_use", () => {
    expect(eventToRenderedMessage({ ...ADD, parent_tool_use_id: "parent-1" }).kind).toBe("tool_use");
  });
});

describe("card markup", () => {
  function card(m) {
    const el = document.createElement("div");
    el.className = "msg draft-card open";
    el.innerHTML = renderDraftCardHtml(m);
    return el;
  }

  it("shows the recipient, the topic and the rendered body", () => {
    const el = card(draftFieldsOf(ADD.input));
    expect(el.querySelector(".dc-to").textContent).toBe("Bruno");
    expect(el.querySelector(".dc-topic").textContent).toBe("Sprint slip");
    expect(el.querySelector(".dc-body strong").textContent).toBe("there");
  });

  it("offers Copy and the panel hand-off", () => {
    const el = card(draftFieldsOf(ADD.input));
    expect(el.querySelector("[data-draft-copy]")).not.toBeNull();
    expect(el.querySelector("[data-draft-pop]")).not.toBeNull();
  });

  it("gives a drop neither Copy nor the hand-off - there is nothing to copy", () => {
    const el = card(draftFieldsOf({ action: "drop", id: "abc" }));
    expect(el.querySelector("[data-draft-copy]")).toBeNull();
    expect(el.querySelector(".dc-label").textContent).toBe("Dropped draft");
  });

  it("escapes a topic rather than letting it inject markup", () => {
    const el = card(draftFieldsOf({ action: "add", topic: "<img src=x>", recipient: "B", body: "x" }));
    expect(el.querySelector(".dc-topic img")).toBeNull();
  });

  it("names the action so a revise does not read as a second new draft", () => {
    expect(card(draftFieldsOf({ action: "revise", body: "x" })).querySelector(".dc-label").textContent)
      .toBe("Revised draft");
    expect(card(draftFieldsOf({ action: "variant", recipient: "Ana", body: "x" })).querySelector(".dc-label").textContent)
      .toBe("New wording");
  });
});

describe("mount", () => {
  function mounted(m, sessionId = "s1") {
    const el = document.createElement("div");
    el.className = "msg draft-card open";
    el.innerHTML = renderDraftCardHtml(m);
    document.body.appendChild(el);
    mountDraftCard(el, m, sessionId);
    return el;
  }

  it("stamps the identity a live refresh needs", () => {
    const el = mounted({ ...draftFieldsOf(ADD.input), draftId: "abcdef12-3456", draftVersion: 1 });
    expect(el.dataset.draftId).toBe("abcdef12-3456");
    expect(el.dataset.draftSession).toBe("s1");
    expect(el.dataset.draftRecipient).toBe("Bruno");
  });

  it("marks a row whose call never resolved instead of pretending it landed", () => {
    const el = mounted({ ...draftFieldsOf(ADD.input), draftFailed: true });
    expect(el.classList.contains("unresolved")).toBe(true);
    expect(el.dataset.draftId).toBeUndefined();
    expect(el.querySelector(".dc-foot-text").textContent).toContain("never written");
  });

  it("repaints the body from the store, not from the tool input", async () => {
    const edited = {
      ...DRAFT,
      variants: [{
        ...DRAFT.variants[0],
        current: 2,
        versions: [
          DRAFT.variants[0].versions[0],
          { n: 2, body: "his own wording", author: "user", note: "", created_at: "x" },
        ],
      }],
    };
    invokeMock.mockResolvedValue({ drafts: [edited] });
    const el = mounted({ ...draftFieldsOf(ADD.input), draftId: DRAFT.id, draftVersion: 1 });
    await vi.waitFor(() => expect(el.querySelector(".dc-ver").textContent).not.toBe(""));
    // Row is v1, store is at v2: the row folds and keeps showing ITS version,
    // so a pile of revise rows does not repeat one body verbatim.
    expect(el.classList.contains("superseded")).toBe(true);
    expect(el.classList.contains("open")).toBe(false);
    expect(el.querySelector(".dc-ver").textContent).toBe("v1 · superseded by v2");
    expect(el.querySelector(".dc-body").textContent).toContain("hey");
  });

  it("shows the live version, including his own edit, on the newest row", async () => {
    const edited = {
      ...DRAFT,
      variants: [{
        ...DRAFT.variants[0],
        current: 2,
        versions: [
          DRAFT.variants[0].versions[0],
          { n: 2, body: "his own wording", author: "user", note: "", created_at: "x" },
        ],
      }],
    };
    invokeMock.mockResolvedValue({ drafts: [edited] });
    const el = mounted({ ...draftFieldsOf(ADD.input), draftId: DRAFT.id, draftVersion: 2 });
    await vi.waitFor(() => expect(el.querySelector(".dc-ver").textContent).toBe("v2 · your edit"));
    expect(el.querySelector(".dc-body").textContent).toContain("his own wording");
    expect(el.classList.contains("superseded")).toBe(false);
  });

  it("keeps a deleted draft's row readable rather than emptying it", async () => {
    invokeMock.mockResolvedValue({ drafts: [] });
    const el = mounted({ ...draftFieldsOf(ADD.input), draftId: DRAFT.id });
    await vi.waitFor(() => expect(el.classList.contains("gone")).toBe(true));
    expect(el.querySelector(".dc-foot-text").textContent).toContain("Deleted");
    expect(el.querySelector(".dc-body").textContent).toContain("hey");
  });

  it("reflects the copied state, which is also what drops it out of the injection", async () => {
    invokeMock.mockResolvedValue({ drafts: [{ ...DRAFT, state: "copied" }] });
    const el = mounted({ ...draftFieldsOf(ADD.input), draftId: DRAFT.id });
    await vi.waitFor(() => expect(el.classList.contains("copied")).toBe(true));
  });
});

describe("panel hand-off", () => {
  it("announces the draft id on the window so shared/chat never imports the view", () => {
    expect(DRAFT_OPEN_EVENT).toBe("cc-draft-open");
  });
});
