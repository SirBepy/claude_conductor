// @vitest-environment jsdom

// Red->green regression: a draft sent from the phone must stop showing up as
// a leftover draft on the desktop. The daemon answers a cleared composer with
// an empty-text tombstone, which has to land on both the textarea and the
// localStorage copy.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mountComposer as mountComposerBase, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

// todo 955: mountComposerBase's dynamic import() of composer.ts (and its
// whole dependency graph) is a real esbuild/Vite transform, not application
// logic - measured 4.3-4.5s the first time any test in this file imports it
// under normal contention, under 1ms every time after, and over 10s when the
// machine is genuinely CPU-starved (reproduced here against real concurrent
// load, not synthetic). That one-time cost was silently eating almost all of
// the first test's 5000ms budget, so any CPU hog beside the suite (a cargo
// build, another agent's vitest run) tips it into a timeout that reads like a
// reconcile-logic regression but isn't one. Paying the transform here, in a
// hook that carries no assertion of its own, removes the wall-clock race from
// every `it()` below instead of widening any of them - the explicit timeout
// only bounds an unconditional module load, not application logic under test.
beforeAll(async () => {
  await import("../src/shared/transport.ts");
  await import("../src/shared/chat/composer.ts");
}, 30000);

let invokeMock;
let remoteDrafts;

beforeEach(() => {
  remoteDrafts = { composer: null, auq: null, held: [], held_updated_at: null };
  invokeMock = tauriMock((cmd) => (cmd === "get_session_drafts" ? remoteDrafts : undefined));
  localStorage.clear();
});

afterEach(() => {
  destroyMounted();
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mountComposer(sessionId) {
  const { composer, textarea } = await mountComposerBase({}, sessionId);
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_drafts", expect.anything()));
  return { composer, textarea };
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
    destroyMounted();
    vi.resetModules();
    invokeMock = tauriMock((cmd) => (cmd === "get_session_drafts" ? remoteDrafts : undefined)); // unchanged: the push never landed

    const second = await mountComposer(sid);
    await new Promise((r) => setTimeout(r, 20));
    expect(second.textarea.value).toBe("typed here, never pushed");
    expect(localStorage.getItem(draftKey(sid))).toBe("typed here, never pushed");
  });
});
