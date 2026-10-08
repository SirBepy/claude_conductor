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
| Machine indicator | Sidebar row glyph (desktop: tooltip; phone: visible label). The new-chat picker lists machines by label on both desktop and phone. |

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
| G9 | Phone could not tell which machine a chat lives on (tooltip only). | Phone rows show the machine label as text. |
| G10 | Code mode, commits popover and open-in-editor silently ran against this machine's disk for a mirrored chat. | Hidden for mirrored chats; remote git browsing is a backlog todo. |

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
- View harness: `sidebar-machine-mark.view.spec.ts` (desktop glyph, phone label, long label at
  390px) and `project-picker-phone-machine-chips.view.spec.ts` (phone machine chips). The phone
  specs mount through `mountViewPhone` in `e2e/view-harness/harness.ts`, which routes `/api/rpc`
  so `isRemote()` is true.
- Real hardware: todo 913's checklist (PC + Mac + phone), not runnable from one box.

## Local rehearsal on one box

`CC_DATA_DIR=<dir> CC_DAEMON_INSTANCE=<label> CC_REMOTE_PORT=<port>` starts a second daemon with its
own data dir and remote port. Pair it by its direct `http://127.0.0.1:<port>` URL (only the default
instance advertises iroh).

## Known limits

- One hop only: a phone paired to the PC reaches Mac chats through the PC, never a third machine.
- A mirrored external (terminal) session has no live stream: `watch_session_transcript` tails a
  local JSONL file and the peer's session stream only serves daemon-hosted chats.
- Code mode / git views for a mirrored chat are hidden rather than proxied.
