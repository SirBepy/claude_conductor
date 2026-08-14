// @vitest-environment jsdom
//
// AUQ draft persistence (Joe's request, 2026-07-16): typing a partial answer
// into the floating AskUserQuestion card and then restarting the whole app
// used to lose it - the draft only ever lived in the renderer's JS heap.
// Mirrors shared/chat/composer-persistence.ts's proven shape: a versioned
// localStorage key, this time per prompt id instead of session id.

import { describe, it, expect, beforeEach } from "vitest";
import { loadQuestionDraftMeta, saveQuestionDraft, clearQuestionDraft } from "../src/views/sessions/permission-modal/draft-persistence.ts";

const PROMPT = "prompt-1";

beforeEach(() => {
  localStorage.clear();
});

describe("AUQ draft persistence", () => {
  it("round-trips free text, single-select, and multiSelect (Set) selections", () => {
    const draft = {
      freeText: new Map([[0, "typed answer"], [2, "another note"]]),
      selections: new Map([
        [1, "Option A"],
        [3, new Set(["X", "Y"])],
      ]),
      activeTab: 2,
    };
    saveQuestionDraft(PROMPT, draft);
    const loaded = loadQuestionDraftMeta(PROMPT)?.draft;

    expect(loaded.activeTab).toBe(2);
    expect(loaded.freeText.get(0)).toBe("typed answer");
    expect(loaded.freeText.get(2)).toBe("another note");
    expect(loaded.selections.get(1)).toBe("Option A");
    expect(loaded.selections.get(3)).toBeInstanceOf(Set);
    expect([...loaded.selections.get(3)]).toEqual(["X", "Y"]);
  });

  it("survives a full reload - the point of the feature (plain restart-equivalent: a fresh load call)", () => {
    saveQuestionDraft(PROMPT, {
      freeText: new Map([[0, "in progress"]]),
      selections: new Map(),
      activeTab: 0,
    });
    // Nothing in-memory carries over between these two calls except localStorage.
    const reloaded = loadQuestionDraftMeta(PROMPT)?.draft;
    expect(reloaded.freeText.get(0)).toBe("in progress");
  });

  it("returns null when nothing was ever saved for this prompt id", () => {
    expect(loadQuestionDraftMeta("never-saved")).toBeNull();
  });

  it("round-trips the review-step additional message and attachment metadata (path/mime/filename/size, no base64)", () => {
    saveQuestionDraft(PROMPT, {
      freeText: new Map(),
      selections: new Map(),
      activeTab: 0,
      additionalMessage: "also check the staging env",
      attachments: [{ mime: "image/png", data: "abc123", path: "/tmp/x.png", filename: "x.png", size: 3 }],
    });
    const loaded = loadQuestionDraftMeta(PROMPT)?.draft;
    expect(loaded.additionalMessage).toBe("also check the staging env");
    // Base64 bytes never hit localStorage (5MB/origin quota) - only enough
    // metadata to re-fetch via read_attachment (attachments.ts's hydrate).
    expect(loaded.attachments).toEqual([{ mime: "image/png", data: "", path: "/tmp/x.png", filename: "x.png", size: 3 }]);
  });

  it("drops an attachment with no daemon-backed path (can't survive a reload)", () => {
    saveQuestionDraft(PROMPT, {
      freeText: new Map(),
      selections: new Map(),
      activeTab: 0,
      additionalMessage: "",
      attachments: [{ mime: "image/png", data: "abc123", path: null, filename: "x.png", size: 3 }],
    });
    expect(loadQuestionDraftMeta(PROMPT)?.draft.attachments).toEqual([]);
  });

  it("clearQuestionDraft removes it, and is a no-op for an unknown id", () => {
    saveQuestionDraft(PROMPT, { freeText: new Map(), selections: new Map(), activeTab: 0 });
    clearQuestionDraft(PROMPT);
    expect(loadQuestionDraftMeta(PROMPT)).toBeNull();
    expect(() => clearQuestionDraft("unknown-id")).not.toThrow();
  });

  it("drafts for different prompt ids don't collide", () => {
    saveQuestionDraft("a", { freeText: new Map([[0, "draft A"]]), selections: new Map(), activeTab: 0 });
    saveQuestionDraft("b", { freeText: new Map([[0, "draft B"]]), selections: new Map(), activeTab: 0 });
    expect(loadQuestionDraftMeta("a")?.draft.freeText.get(0)).toBe("draft A");
    expect(loadQuestionDraftMeta("b")?.draft.freeText.get(0)).toBe("draft B");
  });

  it("gracefully returns null on corrupt JSON instead of throwing", () => {
    localStorage.setItem("auq-draft:v1:" + PROMPT, "{not valid json");
    expect(loadQuestionDraftMeta(PROMPT)).toBeNull();
  });
});
