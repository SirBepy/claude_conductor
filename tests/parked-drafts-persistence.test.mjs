// @vitest-environment jsdom
// Todo 989: parked new-chat drafts (state.parkedDrafts) lived in memory only.
// A reload lost the sidebar row while the typed text sat orphaned forever
// under composer-persistence's chat-draft:v1:<placeholderId> key, since
// nothing on reload knew that placeholder id existed. These tests cover the
// new persistence: round-trip of the parked-draft list, and dropping an
// entry whose composer text is gone.
import { describe, it, expect, beforeEach } from "vitest";

const { saveParkedDrafts, loadParkedDrafts, PARKED_DRAFTS_KEY } = await import(
  "../src/views/sessions/pending-draft-storage.ts"
);
const { saveDraft, clearDraft } = await import("../src/shared/chat/composer-persistence.ts");
const { loadAndRestoreParkedDrafts } = await import("../src/views/sessions/pending-flow.ts");
const { state } = await import("../src/views/sessions/state.ts");

function draft(placeholderId, overrides = {}) {
  return {
    placeholderId,
    projectPath: "/repo",
    projectName: "repo",
    config: { model: "opus", effort: "high" },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  state.parkedDrafts = [];
});

describe("parked-drafts-persistence: save/load round trip", () => {
  it("persists placeholderId, projectPath, projectName and config", () => {
    const d1 = draft("pending-1");
    const d2 = draft("pending-2", { projectPath: "/other", projectName: "other" });
    saveParkedDrafts([d1, d2]);

    const loaded = loadParkedDrafts();
    expect(loaded).toEqual([d1, d2]);
  });

  it("removes the storage key entirely once the list empties", () => {
    saveParkedDrafts([draft("pending-1")]);
    expect(localStorage.getItem(PARKED_DRAFTS_KEY)).not.toBeNull();

    saveParkedDrafts([]);
    expect(localStorage.getItem(PARKED_DRAFTS_KEY)).toBeNull();
  });

  it("caps the persisted list so an endless pile of abandoned drafts can't grow storage forever", () => {
    const many = Array.from({ length: 25 }, (_, i) => draft(`pending-${i}`));
    saveParkedDrafts(many);

    const loaded = loadParkedDrafts();
    expect(loaded.length).toBe(20);
    // Keeps the most recently parked ones, not the oldest.
    expect(loaded[loaded.length - 1].placeholderId).toBe("pending-24");
  });
});

describe("parked-drafts-persistence: loadAndRestoreParkedDrafts hydration", () => {
  it("rebuilds state.parkedDrafts from disk on mount", () => {
    const d1 = draft("pending-1");
    saveParkedDrafts([d1]);
    saveDraft("pending-1", "half-typed reply");

    loadAndRestoreParkedDrafts();

    expect(state.parkedDrafts).toEqual([d1]);
  });

  it("drops a parked entry whose composer draft text no longer exists", () => {
    const withText = draft("pending-has-text");
    const orphan = draft("pending-orphan");
    saveParkedDrafts([withText, orphan]);
    saveDraft("pending-has-text", "still here");
    clearDraft("pending-orphan"); // simulates quota eviction / manual LS clear

    loadAndRestoreParkedDrafts();

    expect(state.parkedDrafts).toEqual([withText]);
    // The orphan is also pruned from disk, not just from the in-memory list.
    expect(loadParkedDrafts()).toEqual([withText]);
  });
});
