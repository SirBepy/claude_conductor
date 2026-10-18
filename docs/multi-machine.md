# Multi-machine chats (PC <-> Mac <-> phone)

Developer reference for the federation feature: what each piece does, how a request travels, what
is proven by tests, and what still needs a real two-machine check. User-facing docs live in
`README.md` ("Multi-machine"); the module map lives in `CLAUDE.md`.

## Goals

1. From the PC, start a chat that runs on the Mac, and the reverse.
2. Each desktop lists the other machine's chats next to its own.
3. The phone lists every chat and shows which machine each one lives on.
4. Any chat on either machine can be opened and driven from any of the three devices: send,
   answer question and permission cards, stop, switch model/effort, auto-accept, attachments.

## Topology

```
phone ──HTTP/WS──> PC daemon ──peer link (HTTP/WS, direct URL or iroh)──> Mac daemon
                     ^                                                       │
                     └──────────────── peer link (reverse) ──────────────────┘
```

- Each machine runs one daemon. Pairing (`pair_machine` on the initiator, `pair_machine_peer` on the
  receiver) registers each side as the other's peer in `<app_data>/machines.json`, and both sides
  start a `peer_link` to the other.
- `peer_link` subscribes to the peer's `/api/global/stream` and copies its local instance rows into
  this daemon's `MirrorState`, stamped with `Instance.machine`. Only one hop: a row that already
  carries a `machine` tag is never re-mirrored.
- The phone talks to exactly one daemon. It sees the other machine's chats through that daemon's
  mirror, and every call it makes about a mirrored chat is forwarded one hop by that daemon.

## How a call about a mirrored chat travels

| Concern | Path |
| --- | --- |
| Per-chat RPC (send, cancel, drafts, model, effort, auto-accept, freeze, history page, attachments, question/permission answers) | `machines/forward.rs::forward_one`, installed on the shared router, so desktop-pipe and phone calls alike are forwarded when `params.session_id` resolves to a mirrored row and the method's `TRANSPORT_TABLE` mask includes `machine` (`PM`/`M`). |
| Live chat events | `machines/relay.rs` opens the peer's `/api/sessions/:id/stream`. Desktop reaches it via `attach_session` (wrapped as `chat_event`), the phone via `stream_ws`'s mirrored fallback. |
| Question and permission cards | Clients poll `list_pending_prompts`. For a mirrored chat the owning peer's prompts are cached in `MirrorState` by `peer_link` and merged into the local answer; answers carry `session_id` so `forward_one` routes them back to the owner. |
| New chat on the other machine | `start_session` with `machine_id`: `lifecycle/core.rs::forward_start_session` relays it, and records the new id's owner so the follow-up `attach_session`/`send_message` route before the next mirror frame arrives. |
| Phone send | `POST /api/sessions/:id/send` (its own REST route, not `/api/rpc`) forwards to the owner when the id is mirrored. |
| Machine indicator | Per-machine icon after the row's project name (`machine-icons.ts`: OS logo, or a stable pool icon when another machine holds that logo). Desktop marks mirrored rows only; the phone marks every row once a peer is paired. No text label. The new-chat machine chips show the same icon before the label. |

## Gap audit (2026-10-08) and resolution

The 2026-09-05 build (todos 677/678) shipped the mirror, relay, forwarder, picker and MCP tools,
proven only by in-process loopback tests. A gap audit on 2026-10-08 found these end-to-end breaks:

| # | Gap | Fix |
| --- | --- | --- |
| G1 | Desktop machine picker was a no-op: the Tauri `start_session` command and `PersistentClient::start_session` dropped `machine_id`, so every chat spawned locally. | Thread `machine_id` through both. |
| G2 | A chat started on a peer failed its first `attach_session`/`send_message`: the local mirror only learns the new id on the peer's next `instances_changed` frame. | `MirrorState` pending-owner entry recorded by `forward_start_session`. |
| G3 | Phone send into a mirrored chat returned 404: the REST send route never consulted the mirror. | Forward from `remote_handlers::send_message`. |
| G4 | Question/permission cards of a mirrored chat never reached any client (`list_pending_prompts` is local-only, `peer_link` drops prompt frames), and answers keyed on `request_id` were never forwarded. | Mirrored prompt cache + merged `list_pending_prompts`; clients pass `session_id` with every answer. |
| G5 | Model, effort, auto-accept, freeze, skip marks, question-rendered ack, attachments were `P`-only, refused for mirrored chats. | Remask to `PM`. |
| G6 | Desktop history for a mirrored chat read the local JSONL (absent), and the live stream only attached after a local send. | Route history through the daemon RPC and attach on open for mirrored rows. |
| G7 | The receiving side of a pairing registered the peer but never started its link until a restart. | `pair_machine_peer` calls `MachineHub::sync_links`. |
| G8 | Phone had no machine picker (`list_machines`/`list_machine_projects` not phone-reachable, picker gated on desktop). | Add both to the table as `P`, lift the gate. |
| G9 | Phone could not tell which machine a chat lives on (tooltip only). | Phone rows carry every machine's icon, own daemon included (the text label it first got was replaced 2026-10-18). |
| G10 | Code mode, commits popover and open-in-editor silently ran against this machine's disk for a mirrored chat. | Hidden for mirrored chats; remote git browsing is a backlog todo. |

## G10 follow-up (2026-10-13, todo 1129): Code mode now proxies its reads

G10's original fix hid Code mode, the commits popover, and the git/branch chips for a mirrored
chat rather than proxy them. Todo 1129 proxies the READ half instead:

- **Proxied (read-only):** `get_git_info`, `get_git_dirty`, `get_commit_sync`, `get_commit_history`,
  `get_recent_branches`, `get_range_files`, `get_file_diff`, `get_file_at_rev`, `list_branch_files`,
  `list_project_files` all take an optional `session_id` now. When the Tauri-facing command
  (`ipc::git`/`ipc::git_diff`/`ipc::git_branch_preview`/`ipc::files`) sees the session is mirrored
  (`ipc::mirror::mirrored_client`, the same `AppState.cached_instances` check `ipc::chat::history`
  uses), it calls the matching `daemon_client::methods::git` wrapper instead of running `git`
  locally; the daemon's shared forwarder (`machines/forward.rs`) relays the call one hop since each
  method is now masked `PM` in `remote_transport_table.rs`. The owning peer's own handler
  (`daemon/methods/pr_review.rs::resolve_cwd`, shared by `statusbar.rs`/`worktrees.rs`/`files.rs`)
  resolves the real cwd from ITS OWN session registry whenever `session_id` is present, ignoring
  whatever `cwd` the forwarding call sent - the owning daemon is the only party trusted to say where
  its own session lives on disk. Each Tauri command's original local-disk logic was renamed
  `..._local` (`pub(crate)`) and reused verbatim by both the no-session-id local path and the
  daemon's own RPC handler (which never recurses into mirror routing - a forwarded call always lands
  on code that reads local disk).
- **Frontend:** Code mode's `entry.ts` no longer refuses to open for a mirrored chat; every read in
  `code-mode/data.ts`, `git-fold.ts`, `branch-switcher.ts`, `session-statusbar.ts`, and
  `commits-popover.ts` threads the chat's `sessionId` alongside `cwd`. The `</>` header button
  (`session-header.ts`) is no longer hidden either - `setMirrored()` was removed.
- **Still hidden/disabled (writes, no forwarding story):** `open_in_editor`/`open_in_explorer`
  (`chat-menu-items.ts`'s VS Code/Terminal/File Explorer items - these launch THIS machine's own
  apps, meaningless for a peer's disk) and, inside Code mode, `push_commits`/`pull_commits`/
  `checkout_branch` (the commits fold's Push/Pull buttons and the branch switcher's checkout action -
  `explorer-html.ts`'s `ExplorerModel.mirrored` / `BranchSwitcherOpts.mirrored` disable them with a
  "Chat is on another machine" tooltip; `git-fold.ts::runGit` and `branch-switcher.ts::checkout` also
  refuse server-side as a backstop). `resolve_commit_refs` (hex-commit-link resolution in chat text)
  stays phone-only (`P`), not yet remasked - a smaller, lower-traffic affordance left for a future
  pass.

## Trust boundary (2026-10-18 security audit, todos 1217 and 1184)

- **Local always wins.** A peer sees this daemon's real session ids over `/api/global/stream` and
  could report one back as its own. `machines::mirrored_owner` checks the local registry (and live
  session map) before `MirrorState::owner_of`, and every routing site goes through it: the RPC
  forwarder, the REST send route, the stream relay, `attach_session` and `post_message`.
  `peer_link` also drops such rows and prompts on arrival, and `all_instances`/`mirrored_prompts`
  filter them on read.
- **Per-peer drive switch.** `MachinesFile::view_only_peers` lists peers whose "Can drive chats"
  switch is off (default on; unpair clears it; flipped only over the desktop pipe via
  `set_machine_can_drive`). `machines::peer_scope::check` runs in `remote_handlers::rpc_dispatch`
  and the REST send route for every `Transport::PeerMachine` call: read methods (`SEE_ONLY`) and
  chat-starting ones (`STARTS_A_CHAT`) pass, anything else needs a target chat whose
  `ChatConfig::started_by_machine` is that peer. Prompt answers are judged by the prompt's own
  session, not a caller-supplied `session_id`. `rpc_dispatch` stamps `started_by_machine` on every
  chat a peer starts, and trims a view-only peer's `list_pending_prompts` to its own chats.

## Tests

- In-process two-daemon loopback (`remote_server::spawn_on`): `machines/peer_link.rs`,
  `machines/forward.rs`, `methods/lifecycle/attach.rs`, `methods/machines.rs`,
  `methods/lifecycle/core.rs`, `methods/channel.rs`. The 2026-10-08 additions:
  `machines/forward.rs` (`prompt_pending_on_b_reaches_as_mirror_via_a_real_peer_link`,
  `respond_question_dispatched_on_a_resolves_bs_real_waiter`,
  `set_session_model_forwards_to_the_mirrored_sessions_owner`,
  `peer_machine_caller_over_real_http_sees_local_prompts_only`), `remote_handlers.rs`
  (`send_message_forwards_to_the_mirrored_sessions_owner`,
  `send_message_never_reforwards_a_peers_own_request`), the pending-owner assertion in
  `start_session_with_a_different_machine_id_forwards_and_strips_it`, and
  `remote_pairing.rs::machine_pair_starts_the_links_hub_entry_for_the_new_peer`.
- View harness: `sidebar-machine-mark.view.spec.ts` (desktop icon, phone icons on every row,
  no-wrap at 390px) and `project-picker-phone-machine-chips.view.spec.ts` (phone machine chips). The phone
  specs mount through `mountViewPhone` in `e2e/view-harness/harness.ts`, which routes `/api/rpc`
  so `isRemote()` is true.
- Real hardware: todo 913's checklist (PC + Mac + phone), not runnable from one box.
- Todo 1129's two-daemon loopback additions in `machines/forward.rs`:
  `mirrored_git_dirty_reaches_bs_own_registry_cwd_not_the_forwarded_one` and
  `mirrored_git_info_reaches_bs_own_registry_cwd` spawn B's REAL `register_statusbar` handler
  (not a stub) against a real temp git repo, and forward a `get_git_dirty`/`get_git_info` call from
  A with a deliberately bogus `cwd` - proving both the `PM` remask and B's own `resolve_cwd`
  ignoring the forwarded `cwd` in favor of its own registry. Unit coverage for the other eight
  remasked methods lives alongside each handler (`daemon/methods/statusbar.rs`,
  `daemon/methods/worktrees.rs`, `daemon/methods/pr_review.rs`, `daemon/methods/files.rs`) plus
  `resolve_cwd`'s own tests in `pr_review.rs`.

## Local rehearsal on one box

`CC_DATA_DIR=<dir> CC_DAEMON_INSTANCE=<label> CC_REMOTE_PORT=<port>` starts a second daemon with its
own data dir and remote port. Pair it by its direct `http://127.0.0.1:<port>` URL (only the default
instance advertises iroh).

## Mirrored external (terminal) session live stream (2026-10-13)

A `claude` session started in a terminal (`kind: External`) has no daemon child/pump on its own
machine, so it was never reachable through `/api/sessions/:id/stream`: that handler
(`remote_handlers::stream_ws`) only checked `ctx.state.sessions` (daemon-hosted chats) and then
`ctx.state.mirror.owner_of` (a row mirrored IN from some OTHER peer) - a row the daemon registered
about its OWN external session matched neither, so the handshake 404'd. A desktop/phone viewing
that session from a peer got history (the forwarded `load_history_page` still worked) but no live
updates until reopened - the gap this section used to name.

Fix: `stream_ws` now also checks the local registry for a `kind == External` row before falling
through to the mirror lookup, and resolves it to `pump_external_session_events`
(`daemon/remote_ws_pump.rs`), which tails the session's own `transcript_path` from its current EOF
and emits the same raw `ChatEvent` frames `pump_events` sends for a daemon-hosted chat - so neither
consumer (`attach_session`'s relay wrap for desktop, or the phone's verbatim forward) needed to
change. The read-seek-partial-line-safe tail loop itself was extracted out of the desktop's
`ipc::chat::watcher::watch_session_transcript` into `chat::history::tail_new_events`, shared by
both pollers instead of duplicated.

Test: `methods/lifecycle/attach.rs::attach_session_relays_an_external_sessions_new_transcript_lines`
- a real two-daemon loopback where B registers an External `Instance` backed by a temp JSONL file,
  A attaches through the normal `attach_session` RPC + relay path, and a line appended to B's file
  after attach arrives on A as a `chat_event` frame. Unit tests for `tail_new_events` itself live
  in `chat/history.rs`.

## Known limits

- One hop only: a phone paired to the PC reaches Mac chats through the PC, never a third machine.
- Code mode / git views for a mirrored chat now proxy their READS only (todo 1129, see the G10
  follow-up above) - `push_commits`/`pull_commits`/`checkout_branch` and open-in-editor/explorer
  stay hidden/disabled, and `resolve_commit_refs` stays phone-only.
- `session_live_cwd` (the "follow the AI into a worktree" git-cwd refinement) still only reads a
  LOCAL transcript file - for a mirrored chat it silently falls back to the spawn cwd (no error,
  just no worktree-following), which is what `resolveGitCwd` already sends to the now-proxied
  `get_git_info`/`get_git_dirty` calls.
