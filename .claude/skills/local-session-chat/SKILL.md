---
name: local-session-chat
description: Use when invoked via /local-session-chat. Loads full context for the claude_usage_in_taskbar Sessions screen so Joe can describe what needs fixing without repeating architecture.
---

# local-session-chat

## What to do on invoke

1. Read these files (in order, skim for current state):
   - `src/views/sessions/sessions.ts` - full view orchestration, state machine, sidebar render, pending-session flow
   - `src/views/sessions/sessions-helpers.ts` - sort, unread, statusPriority, stateTooltip, statusDotClass
   - `src/views/sessions/sessions.css` - all layout/styling for the sidebar + rows
   - `src/shared/chat/chat-renderer.ts` - virtualized chat DOM, markdown + shiki pass
   - `src/shared/chat/composer.ts` - textarea, image paste, mountId race guard
   - `src-tauri/src/daemon/lifecycle.rs` - spawn_session, send_message, cancel_turn, end_session, stdout reader
   - `src-tauri/src/chat/parser.rs` - stream-json -> ChatEvent, CRLF handling
   - `src-tauri/src/sessions/registry.rs` - Instance registry, busy flag, upsert helpers
   - `src-tauri/src/ipc/chat.rs` - IPC surface: start_session / send_message / cancel_turn / paste_image / takeover_manual / load_history / detach_window

2. Then say: **"Sessions context loaded. What needs fixing?"**

## Key architecture facts

**Per-turn model.** Each user message = one short-lived `claude -p --resume <id> --output-format=stream-json --verbose --include-partial-messages` process spawned by `daemon/lifecycle.rs`. Claude exits when the turn ends. Cancel = `kill_tree(pid)`.

**Subscription-only.** `check_metered_billing` in `chat/billing.rs` refuses to spawn if any API key env var is set. No metered path.

**State machine (frontend).** Module-level `state: SessionsState` singleton. `mountId` guards every async callback against stale-mount writes. `pendingNewSession` tracks an optimistically-rendered row while `start_session` is in flight; once the real `session_id` arrives from the first `SessionStarted` event, `pending.realId` is set so `renderSidebar` can suppress the duplicate registry entry.

**Unread tracking.** `prevBusyMap` diff on every `instances-changed` event: `busy true→false` while not selected = mark unread. GC'd when session ends.

**Sidebar sort options.** `status` (Working > Done-unread > YourTurn > External), `recent`, `name`. Persisted in localStorage key `cc_session_sort`. Row style (`classic` vs `portrait`, default portrait) in `cc_chat_row_style`.

**Context-menu.** Per-row 3-dot menu: "New agent here", "Run /close" (interactive non-busy only), "Open in VS Code".

**IPC types.** `Instance`, `ChatEvent`, `ContentBlock`, `ProjectGroup`, `GitInfo` — all from `src/types/ipc.generated.ts`.

## Common fix areas

| Area                         | Files                                                |
| ---------------------------- | ---------------------------------------------------- |
| Sidebar layout / row styling | `sessions.css`                                       |
| Sort / filter / unread logic | `sessions-helpers.ts`, `sessions.ts:refreshSessions` |
| Pending-row / optimistic UI  | `sessions.ts:launchNewSession`, `renderSidebar`      |
| Chat rendering bugs          | `chat-renderer.ts`                                   |
| Composer (text input, paste) | `composer.ts`                                        |
| Turn spawn / cancel / errors | `daemon/lifecycle.rs`, `chat/parser.rs`               |
| Registry / busy state        | `registry.rs`                                        |
| IPC surface changes          | `ipc/chat.rs` + `capabilities/default.json`          |
