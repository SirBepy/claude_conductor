// @vitest-environment jsdom

// Red->green regression: a draft sent from the phone must stop showing up as
// a leftover draft on the desktop. The daemon answers a cleared composer with
// an empty-text tombstone, which has to land on both the textarea and the
// localStorage copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let invokeMock;
let mounted = [];
let remoteDrafts;

beforeEach(() => {
  remoteDrafts = { composer: null, auq: null, held: [], held_updated_at: null };
  invokeMock = vi.fn(async (cmd) => {
    if (cmd === "list_slash_commands") return [];
    if (cmd === "list_project_files") return [];
    if (cmd === "get_session_drafts") return remoteDrafts;
    return {};
  });
  globalThis.window.__TAURI__ = {
    core: { invoke: invokeMock },
    event: { listen: async () => () => {} },
  };
  localStorage.clear();
});

afterEach(() => {
  for (const composer of mounted) composer.destroy();
  mounted = [];
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mountComposer(sessionId) {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { Composer } = await import("../src/shared/chat/composer.ts");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const composer = new Composer(root, { onSend: vi.fn(async () => {}) });
  mounted.push(composer);
  composer.setSessionId(sessionId);
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_drafts", expect.anything()));
  return { composer, textarea: root.querySelector(".composer-textarea") };
}

const draftKey = (id) => `chat-draft:v1:${id}`;

describe("cross-device composer clear", () => {
  it("wipes the local draft when the daemon reports a newer clear tombstone", async () => {
    const sid = "sess-phone-sent";
    localStorage.setItem(draftKey(sid), "typed on the phone, already sent");
    remoteDrafts = {
      composer: { text: "", updated_at: "2099-01-01T00:00:00Z" },
      auq: null, held: [], held_updated_at: null,
    };

    const { textarea } = await mountComposer(sid);

    await vi.waitFor(() => expect(textarea.value).toBe(""));
    expect(localStorage.getItem(draftKey(sid))).toBeNull();
  });

  it("keeps a local draft the daemon never knew about (no entry, no tombstone)", async () => {
    const sid = "sess-local-only";
    localStorage.setItem(draftKey(sid), "still being written");

    const { textarea } = await mountComposer(sid);

    await new Promise((r) => setTimeout(r, 20));
    expect(textarea.value).toBe("still being written");
    expect(localStorage.getItem(draftKey(sid))).toBe("still being written");
  });

  it("reconciles on window focus, so an already-open chat drops the sent draft", async () => {
    const sid = "sess-refocus";
    const { textarea } = await mountComposer(sid);
    textarea.value = "mirrored from the phone";
    remoteDrafts = {
      composer: { text: "", updated_at: "2099-01-01T00:00:00Z" },
      auq: null, held: [], held_updated_at: null,
    };

    window.dispatchEvent(new window.Event("focus"));

    await vi.waitFor(() => expect(textarea.value).toBe(""));
  });

  // todo 823: a typed draft that never finished pushing must survive a reload,
  // even when the daemon still holds an older tombstone from before the edit.
  it("keeps a local draft that never synced across a simulated reload, even against an older tombstone", async () => {
    const sid = "sess-reload-baseline";
    const olderTombstone = { text: "", updated_at: "2026-08-13T00:00:01Z" };
    remoteDrafts = { composer: olderTombstone, auq: null, held: [], held_updated_at: null };

    // First mount: an empty textarea reconciles against the tombstone (nothing
    // to lose) and learns + persists the baseline timestamp.
    const first = await mountComposer(sid);
    await vi.waitFor(() => expect(localStorage.getItem(`chat-draft-sync:v1:${sid}`)).toBe(olderTombstone.updated_at));

    // The user types new text; the push to the daemon fails outright, so the
    // baseline never advances past the tombstone's own timestamp.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "set_composer_draft") throw new Error("network down");
      if (cmd === "get_session_drafts") return remoteDrafts;
      return {};
    });
    first.textarea.value = "typed here, never pushed";
    first.textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    first.composer.draftSync.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(localStorage.getItem(draftKey(sid))).toBe("typed here, never pushed");

    // Simulate a reload: fresh module graph, so composer-draft-sync's
    // in-memory baseline Map is gone and must reseed from localStorage.
    for (const composer of mounted) composer.destroy();
    mounted = [];
    vi.resetModules();
    invokeMock = vi.fn(async (cmd) => {
      if (cmd === "list_slash_commands") return [];
      if (cmd === "list_project_files") return [];
      if (cmd === "get_session_drafts") return remoteDrafts; // unchanged: the push never landed
      return {};
    });
    globalThis.window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => {} },
    };

    const second = await mountComposer(sid);
    await new Promise((r) => setTimeout(r, 20));
    expect(second.textarea.value).toBe("typed here, never pushed");
    expect(localStorage.getItem(draftKey(sid))).toBe("typed here, never pushed");
  });
});
