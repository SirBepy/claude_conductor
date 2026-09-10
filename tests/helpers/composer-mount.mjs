// Shared mount boilerplate for the composer specs (todo 878): reset the
// transport, dynamic-import Composer, create+append a root div, construct it,
// track it for teardown, and call setSessionId. Each caller still owns its
// own post-mount waiting (e.g. vi.waitFor for a specific invoke call) since
// that differs per file - only the mechanical setup below was duplicated.
// Not a test file itself (no .test. in the name, so Vitest's `tests/**/*.test.mjs`
// include glob skips it) - each caller's own file supplies the jsdom pragma.

import { vi } from "vitest";

let mounted = [];

/** Common window.__TAURI__ mock every composer spec needs: list_slash_commands
 *  and list_project_files stubbed to empty (Composer's constructor fetches
 *  both on mount), with a per-test override hook tried first per call - return
 *  anything but `undefined` from `overrides` to short-circuit the common
 *  stubs. Returns the underlying invoke mock so a caller can assert on it,
 *  mockClear() it, or replace its implementation outright. */
export function tauriMock(overrides) {
  const invoke = vi.fn(async (cmd, ...args) => {
    if (overrides) {
      const r = await overrides(cmd, ...args);
      if (r !== undefined) return r;
    }
    if (cmd === "list_slash_commands") return [];
    if (cmd === "list_project_files") return [];
    return {};
  });
  globalThis.window.__TAURI__ = {
    core: { invoke },
    event: { listen: async () => () => {} },
  };
  return invoke;
}

/** Mount a real Composer against a fresh transport + DOM root, tracked for
 *  destroyMounted(). `opts` merges over the default `{ onSend }`. */
export async function mountComposer(opts = {}, sessionId = "sess-1") {
  const { resetTransportForTests } = await import("../../src/shared/transport.ts");
  resetTransportForTests();
  const { Composer } = await import("../../src/shared/chat/composer.ts");
  const root = document.createElement("div");
  document.body.appendChild(root);
  const composer = new Composer(root, { onSend: vi.fn(async () => {}), ...opts });
  mounted.push(composer);
  composer.setSessionId(sessionId);
  const textarea = root.querySelector(".composer-textarea");
  return { composer, root, textarea };
}

/** Destroy every composer mounted via mountComposer() since the last call and
 *  reset the tracked set. Safe to call mid-test (a simulated-reload test
 *  needs a fresh mounted[] before its second mountComposer() call), not only
 *  from afterEach. */
export function destroyMounted() {
  for (const composer of mounted) composer.destroy();
  mounted = [];
}
