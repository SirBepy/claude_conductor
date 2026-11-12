// asserts: src-tauri/src/ipc/sub_view.rs, src-tauri/src/lib.rs, src/views/sessions/chat-menu-items.ts

// A queued sub's menu (Start now, Drop) calls `invoke("start_queued_sub" | "drop_queued_sub")`.
// On the desktop that goes straight to Tauri, so each name needs a `#[tauri::command]` wrapper
// forwarding to the daemon method of the same name, and a `generate_handler!` entry. The
// daemon methods alone are not reachable from the webview: without the wrappers both menu
// items fail with "Command not found". The unit tests mock `invoke` and the Rust tests call the
// daemon router directly, so only this file notices a missing wrapper.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// CRLF checkouts: normalise before matching.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const wrappers = read("src-tauri/src/ipc/sub_view.rs");
const lib = read("src-tauri/src/lib.rs");
const menu = read("src/views/sessions/chat-menu-items.ts");
const table = read("src-tauri/src/daemon/remote_transport_table.rs");

describe.each(["start_queued_sub", "drop_queued_sub"])("%s", (name) => {
  it("is invoked by the queued sub's menu", () => {
    expect(menu).toContain(`invoke<void>("${name}", { sessionId: id })`);
  });

  it("has a tauri command wrapper that forwards to the daemon method of the same name", () => {
    const fn = new RegExp(`#\\[tauri::command\\]\\npub async fn ${name}\\(session_id: String, state: State<'_, AppState>\\)[^{]*\\{\\n([\\s\\S]*?)\\n\\}`).exec(wrappers);
    expect(fn, "wrapper missing or its signature changed").not.toBeNull();
    expect(fn[1]).toContain(`client.call("${name}", json!({"session_id": session_id}))`);
  });

  it("is registered in generate_handler!", () => {
    expect(lib).toMatch(new RegExp(`^\\s+ipc::${name},$`, "m"));
  });

  it("stays desktop-only: absent from the remote transport table", () => {
    expect(table).not.toMatch(new RegExp(`\\("${name}",`));
  });
});

// The chat menu's "Compact now" reaches the daemon through the same kind of wrapper.
describe("compact_now", () => {
  it("is invoked by the chat menu", () => {
    expect(menu).toContain('"compact_now", { sessionId }');
  });

  it("has a tauri command wrapper that forwards to the daemon method of the same name", () => {
    const fn = /#\[tauri::command\]
pub async fn compact_now\(session_id: String, state: State<'_, AppState>\)[^{]*\{
([\s\S]*?)
\}/.exec(wrappers);
    expect(fn, "wrapper missing or its signature changed").not.toBeNull();
    expect(fn[1]).toContain('client.call("compact_now", json!({"session_id": session_id}))');
  });

  it("is registered in generate_handler!", () => {
    expect(lib).toMatch(/^\s+ipc::compact_now,$/m);
  });

  it("stays desktop-only: absent from the remote transport table", () => {
    expect(table).not.toMatch(/\("compact_now",/);
  });
});
