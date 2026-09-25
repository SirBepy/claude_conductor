// Guards the notifier-event three-registration contract (todo 946): a daemon
// notifier event that a frontend listener subscribes to needs both a
// `daemon_link/mod.rs` match arm (desktop) and a `GLOBAL_EVENT_MAP` entry
// (phone), or it silently never fires. Shipped exactly this bug in `a2d6a916`
// (2026-09-23) and a full `cargo test --lib` + full vitest run + `tsc --noEmit`
// were all green with the event completely dead on both transports - none of
// the normal fast checks can see a missing match arm or map entry, which is
// why this one has to exist.
//
// Deliberately NOT a blanket "every listen( site must be in GLOBAL_EVENT_MAP"
// lint - that was proposed and rejected on 2026-09-23 (~10 false positives:
// desktop-only Tauri events like `settings-changed`, `daemon-status-changed`,
// the `tauri://*` ones, and direct window-to-window `app.emit` calls that never
// touch the daemon notifier at all). Both curated lists below carry a reason
// per entry; an unreasoned name never gets a free pass.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_KEBAB_EVENTS } from "../src/shared/global-stream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const daemonDir = path.join(repoRoot, "src-tauri", "src", "daemon");
const daemonLinkPath = path.join(repoRoot, "src-tauri", "src", "daemon_link", "mod.rs");
const srcDir = path.join(repoRoot, "src");

/** Published snake_case daemon-notifier events with no `daemon_link/mod.rs`
 *  match arm, each with the reason it is not a bug. */
const DELIBERATELY_UNHANDLED_SNAKE = {
  permission_request:
    "delivered via the reliable list_pending_prompts poll instead - the " +
    "broadcast can silently drop frames under pipe backpressure (see " +
    "daemon_link/mod.rs's own comment above the token_history_updated arm).",
  question_request:
    "same reason as permission_request: poll-delivered, not broadcast-delivered.",
  usage_snapshot:
    "fanned out over /api/global/stream for a non-Tauri local consumer (a " +
    "future taskbar widget dialing the daemon's own WS directly), never meant " +
    "to reach a Tauri window - see notify_usage_snapshot's doc comment in " +
    "daemon_client/methods/misc.rs.",
};

/** Kebab-case event names a `src/` listener subscribes to that are
 *  intentionally absent from `GLOBAL_EVENT_MAP`, each with the reason. */
const DESKTOP_ONLY_KEBAB = {
  "settings-changed": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "daemon-status-changed": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "news-updated": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "news-notification": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "permission-requested": "Tauri-only ev.listen; delivered to the phone via the prompt poll instead.",
  "question-requested": "Tauri-only ev.listen; delivered to the phone via the prompt poll instead.",
  "prompt-resolved": "Tauri-only ev.listen; delivered to the phone via the prompt poll instead.",
  "slash-commands-changed": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "when-done-state": "Tauri-only ev.listen; phone has no window.__TAURI__.",
  "chats-open-session":
    "direct window-to-window app.emit from ipc/window/chats.rs (Chats secondary " +
    "window IPC) - never goes through the daemon notifier at all.",
  "chats-new-chat":
    "direct window-to-window app.emit from ipc/window/chats.rs - same as chats-open-session.",
};

/** Recursively collects every file under `dir` whose name ends with any of
 *  `exts`, skipping `node_modules`. */
function collectFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Every `state.notifier.publish("<name>"` (or `.notifier` / `.publish(`
 *  chained across lines, which several call sites do) under `src-tauri/src/
 *  daemon/`. `\s` matches newlines, so this covers both the single-line and
 *  chained-multiline call shapes without needing two patterns. */
function collectPublishedSnakeNames() {
  const names = new Map(); // name -> first file it was found in
  const pattern = /notifier\s*\.\s*publish\(\s*"([a-zA-Z0-9_]+)"/g;
  for (const file of collectFiles(daemonDir, [".rs"])) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      if (!names.has(m[1])) names.set(m[1], path.relative(repoRoot, file));
    }
  }
  return names;
}

/** Every top-level `"<name>" => ...` match arm in `handle_daemon_notification`. */
function collectHandledSnakeNames() {
  const text = fs.readFileSync(daemonLinkPath, "utf8");
  const names = new Set();
  const pattern = /^\s*"([a-zA-Z0-9_]+)"\s*=>/gm;
  for (const m of text.matchAll(pattern)) names.add(m[1]);
  return names;
}

/** Every literal (non-template) kebab-case event name passed as the first
 *  argument to a `.listen(` call anywhere under `src/`. A backtick template
 *  (e.g. `` `chat:${sessionId}` ``) never matches the quoted-string pattern,
 *  which is deliberate: those dynamic per-session channels are a documented
 *  separate case in global-stream.ts (`^chat:(.+)$`), not a static event name
 *  this contract governs. */
function collectListenedKebabNames() {
  const names = new Map(); // name -> first file it was found in
  const pattern = /\.listen(?:<[^>]*>)?\(\s*"([a-zA-Z0-9_:-]+)"/g;
  for (const file of collectFiles(srcDir, [".ts"])) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      if (!names.has(m[1])) names.set(m[1], path.relative(repoRoot, file));
    }
  }
  return names;
}

describe("notifier-event registration contract (todo 946)", () => {
  it("every published notifier event is handled in daemon_link/mod.rs or is on the deliberately-unhandled list", () => {
    const published = collectPublishedSnakeNames();
    const handled = collectHandledSnakeNames();

    for (const [name, file] of published) {
      const ok = handled.has(name) || name in DELIBERATELY_UNHANDLED_SNAKE;
      expect(
        ok,
        `"${name}" (published from ${file}) has no daemon_link/mod.rs match arm ` +
          `and is not on DELIBERATELY_UNHANDLED_SNAKE in this test file. Either ` +
          `add the arm or add a reasoned entry to the list.`,
      ).toBe(true);
    }

    // A stale allow-list entry (the publish site it excuses got deleted, or it
    // was actually handled all along) is as misleading as a missing one.
    for (const name of Object.keys(DELIBERATELY_UNHANDLED_SNAKE)) {
      expect(
        published.has(name),
        `DELIBERATELY_UNHANDLED_SNAKE names "${name}", which is no longer ` +
          `published anywhere under src-tauri/src/daemon/ - remove the stale entry.`,
      ).toBe(true);
      expect(
        handled.has(name),
        `DELIBERATELY_UNHANDLED_SNAKE names "${name}", but daemon_link/mod.rs ` +
          `now has a match arm for it - remove the stale entry.`,
      ).toBe(false);
    }
  });

  it("every src/ listener's kebab event is in GLOBAL_EVENT_MAP or is on the desktop-only list", () => {
    const listened = collectListenedKebabNames();

    for (const [name, file] of listened) {
      if (name.startsWith("tauri://")) continue; // raw Tauri window/OS events, never daemon-sourced
      const ok = GLOBAL_KEBAB_EVENTS.has(name) || name in DESKTOP_ONLY_KEBAB;
      expect(
        ok,
        `"${name}" (listened for in ${file}) is not in GLOBAL_EVENT_MAP and is ` +
          `not on DESKTOP_ONLY_KEBAB in this test file. Either add the map entry ` +
          `or add a reasoned entry to the list.`,
      ).toBe(true);
    }

    for (const name of Object.keys(DESKTOP_ONLY_KEBAB)) {
      const stillListenedFor = [...listened.keys()].includes(name);
      expect(
        stillListenedFor,
        `DESKTOP_ONLY_KEBAB names "${name}", which no src/ file listens for ` +
          `anymore - remove the stale entry.`,
      ).toBe(true);
    }
  });
});
