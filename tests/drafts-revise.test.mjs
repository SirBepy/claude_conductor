// @vitest-environment jsdom
//
// The draft editor's Revise menu sends a one-click instruction to the chat
// that wrote the draft. The prompt must carry the full current text (the
// per-turn injection only has an excerpt) and, when text was highlighted,
// confine the change to that span.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, sendMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), sendMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { buildRevisionPrompt, presetAsk, REVISE_PRESETS } = await import("../src/views/sessions/drafts-revise.ts");

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
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset().mockResolvedValue(undefined);
    sendMock.mockReset().mockResolvedValue(true);
    document.body.innerHTML = "";
  });

  async function mountEditor() {
    vi.doMock("../src/views/sessions/drafts-revise.ts", async (orig) => ({
      ...(await orig()),
      sendRevision: (...a) => sendMock(...a),
    }));
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
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [origin, fallback, text] = sendMock.mock.calls[0];
    expect(origin).toBe("origin");
    expect(fallback).toBe("here");
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
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toContain("Mention the Thursday date");
  });
});
