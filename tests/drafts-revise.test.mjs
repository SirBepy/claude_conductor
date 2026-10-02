// @vitest-environment jsdom
//
// The draft editor's Revise menu sends a one-click instruction to the chat
// that wrote the draft. The prompt must carry the full current text (the
// per-turn injection only has an excerpt) and, when text was highlighted,
// confine the change to that span.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// sendRevision's own send path (sessionEvents + sendWithFailureRecovery) is
// exercised for real; only the daemon-facing leaf is mocked. The Revise menu's
// open/scope/send wiring (`ReviseMenuController`) now lives in drafts-revise.ts
// itself, so a prior version of this test that mocked `sendRevision` as seen
// by drafts-editor.ts's import no longer intercepts anything: the controller
// calls the module-local `sendRevision` directly, not through its own export.
const { invokeMock, sendWithFailureRecoveryMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sendWithFailureRecoveryMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({
  sendWithFailureRecovery: (...a) => sendWithFailureRecoveryMock(...a),
}));

const { buildRevisionPrompt, presetAsk, REVISE_PRESETS } = await import("../src/views/sessions/drafts-revise.ts");
const { state } = await import("../src/views/sessions/state.ts");

const target = {
  topic: "Deploy slip",
  handle: "Bruno #2",
  version: 3,
  body: "Hey Bruno.\n\nThe backfill is slow.",
  selection: "",
};

describe("buildRevisionPrompt", () => {
  it("names the draft, carries the instruction and the full quoted body", () => {
    const p = buildRevisionPrompt(target, "Make it shorter.");
    expect(p.split("\n")[0]).toBe("[re: draft Bruno #2 v3 - Deploy slip]");
    expect(p).toContain("Make it shorter.");
    expect(p).toContain("> Hey Bruno.\n> \n> The backfill is slow.");
    expect(p).toContain('write_draft (action revise, id "Bruno #2")');
    expect(p).not.toContain("Only change this part");
  });

  it("confines the change to the highlighted span when there is one", () => {
    const p = buildRevisionPrompt({ ...target, selection: "The backfill is slow." }, "Explain it better.");
    expect(p).toContain("Only change this part, leave the rest as it is:\n> The backfill is slow.");
  });
});

describe("presets", () => {
  it("offers the five quick revisions Joe picked", () => {
    expect(REVISE_PRESETS.map((p) => p.label)).toEqual([
      "Shorter",
      "Explain better",
      "More casual",
      "More direct",
      "Check accuracy",
    ]);
  });

  it("the accuracy check asks for subagents", () => {
    expect(presetAsk("accuracy")).toMatch(/subagents/);
    expect(presetAsk("nope")).toBeUndefined();
  });
});

describe("DraftsEditor Revise menu", () => {
  const priorSessions = state.sessions;

  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    sendWithFailureRecoveryMock.mockReset().mockResolvedValue(undefined);
    // The draft's origin_session_id ("origin") is deliberately absent, so
    // sendRevision must fall back to the editor's own sessionId ("here") -
    // exercising the same fallback this test exercised when `sendRevision`
    // itself was mocked, before the Revise wiring moved into drafts-revise.ts.
    state.sessions = [{ session_id: "here", cwd: "/tmp" }];
    document.body.innerHTML = "";
  });

  afterEach(() => {
    state.sessions = priorSessions;
  });

  async function mountEditor() {
    const { DraftsEditor } = await import("../src/views/sessions/drafts-editor.ts");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const draft = {
      id: "d1",
      topic: "Deploy slip",
      brief: "",
      receipts: [],
      variants: [
        {
          recipient: "Bruno",
          handle_n: 2,
          current: 1,
          versions: [{ n: 1, body: "Hey Bruno.", author: "ai", note: "", created_at: "2026-10-01T00:00:00Z" }],
        },
      ],
      state: "needs-you",
      origin_session_id: "origin",
      origin_label: "chat A",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      seen_by_origin: true,
    };
    new DraftsEditor(root, draft, { sessionId: "here", onBack() {}, onChanged() {} });
    return root;
  }

  it("opens on Revise and sends a preset to the authoring chat, falling back to this one", async () => {
    const root = await mountEditor();
    root.querySelector("[data-revise]").click();
    const items = root.querySelectorAll("[data-revise-preset]");
    expect(items.length).toBe(5);

    root.querySelector('[data-revise-preset="shorter"]').click();
    await vi.waitFor(() => expect(sendWithFailureRecoveryMock).toHaveBeenCalledTimes(1));
    const [sessionId, , blocks] = sendWithFailureRecoveryMock.mock.calls[0];
    expect(sessionId).toBe("here");
    const text = blocks[0].text;
    expect(text).toContain("[re: draft Bruno #2 v1 - Deploy slip]");
    expect(text).toContain("Make it shorter.");
    expect(root.querySelector(".dr-rv-menu")).toBeNull();
  });

  it("sends free text on Enter", async () => {
    const root = await mountEditor();
    root.querySelector("[data-revise]").click();
    const input = root.querySelector("[data-revise-free]");
    input.value = "Mention the Thursday date";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(sendWithFailureRecoveryMock).toHaveBeenCalledTimes(1));
    expect(sendWithFailureRecoveryMock.mock.calls[0][2][0].text).toContain("Mention the Thursday date");
  });

  it("closes on an outside click", async () => {
    const root = await mountEditor();
    root.querySelector("[data-revise]").click();
    expect(root.querySelector(".dr-rv-menu")).not.toBeNull();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(root.querySelector(".dr-rv-menu")).toBeNull();
    expect(root.querySelector("[data-revise]").classList.contains("open")).toBe(false);
  });

  it("scopes the prompt to the highlighted span, captured before the click collapses it", async () => {
    const root = await mountEditor();
    const body = root.querySelector(".dr-body");
    const textNode = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "Hey".length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const reviseBtn = root.querySelector("[data-revise]");
    reviseBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    reviseBtn.click();
    root.querySelector('[data-revise-preset="shorter"]').click();

    await vi.waitFor(() => expect(sendWithFailureRecoveryMock).toHaveBeenCalledTimes(1));
    const text = sendWithFailureRecoveryMock.mock.calls[0][2][0].text;
    expect(text).toContain("Only change this part, leave the rest as it is:\n> Hey");
  });
});
