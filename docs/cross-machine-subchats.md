# Cross-machine subs (a main chat on this PC, its sub on the Mac)

Design approved by Joe on question cards, 2026-11-13. Read with `docs/architecture/subchats.md` and
`docs/architecture/multi-machine.md`; every hard rule in both still applies. Built in eight steps,
one sub per step (Joe: "do it all for one version ... write a big plan ... then implement it, sub
chat by subchat"). Each step lands with its own Rust tests; step 8 is the two-instance live run.

## Terms

- **Home**: the daemon hosting the main chat (the PC in Joe's case).
- **Host**: the daemon running the sub's `claude` process (the Mac).
- **Remote sub**: a sub seen from its home. **Visiting sub**: the same sub seen from its host.

## Decisions (Joe, 2026-11-13)

| Fork | Decision |
| --- | --- |
| Who owns what | The host runs the sub: its process, its worktree, `finish_subchat`, the Stop hook, its stall/stuck/ceiling watchers and the daemon cards they raise. The home owns the family: cards log, decisions log, the one line back, wakes, the cap of 10, `after` chains, the merge. The host sends the home small structured events; the home writes every `is_meta` notice text itself, so no host-written text becomes an app-written message. |
| Commits | Git bundles over the paired link. At spawn the home sends the host the commits it lacks and the sub's worktree starts from the home's target tip. At finish the home fetches the sub's branch as a bundle and merges it with today's rule (rebase onto the target, `merge --ff-only --no-overwrite-ignore`). No GitHub, no push, no remote needed. |
| Host offline | The sub keeps running on the host. Events wait in an on-disk outbox and are delivered when the link is back. The home's `subchat status` shows "Mac unreachable since 14:02"; the main chat is woken once after 10 minutes unreachable. No card for Joe. |
| Writer slot, gate | Per machine. A writing sub on the host must get a worktree there (refused otherwise), so it never takes the host's slot. Gate subs are never sent to another machine. The cap of 10 counts the main chat's subs on every machine. |
| Host folder | Matched by git origin URL among the host's registered projects. No match, or two: the spawn is refused with the host's project list and the main chat asks Joe on a card which folder it is (or to set the project up on the host first), then passes `machine_cwd`. |
| Scope | Everything in one version: also `after` chains, continuing a finished sub, typing to a sub, nudge, drop, retry, merge, close, Move to sidebar. |
| Secrets | A visiting sub's `request_secret` card shows in the home's window only when the home reaches the host over iroh (encrypted). Over a plain `http://` direct URL the request is refused with a note telling the sub to ask Joe to put the secret on the host by hand. |
| Viewer | Joe, same day: on the Mac he cannot tell which Windows chats are main chats. A paired viewer shows a peer's main chat as a main chat, with its subs and live cards (step 7). |

## Identity and trust

- On the host, a visiting sub's row has `subchat_of = <home main id>` (so `subchats::is_sub` and
  every sub rule on the host keep working) and its brief carries `home: HomeRef { machine_id,
  main_id }`. `home.machine_id` is taken from `ctx.transport` (`Transport::PeerMachine(id)`) of the
  `sub_spawn` call, never from the payload. `started_by_machine` is stamped as for any chat a peer
  starts, so `peer_scope` lets the home drive it.
- On the home, `<data_dir>/subchats/remote-subs[suffix].json` (per daemon instance, like
  `held[suffix].json`) records each remote sub: `sub_id`, `machine_id`, `main_id`, `name`,
  `state` (held, running, finished, ended), `spawned_at`, `unreachable_since`, `woke_unreachable`,
  `target`, `base`. Every field except `sub_id` has `#[serde(default)]`; an unreadable file or entry
  is kept as `.bad` (`jsonfile.rs`).
- The home accepts a mirrored row, prompt or event as its sub's only when the record names that
  sub id AND the caller (or the mirror owner, through `machines::mirrored_owner`) is the record's
  machine. A peer that claims a sub it does not host is ignored. This also hardens today's prompt
  merge: a mirrored prompt whose `display_session_id` names a local chat but whose asker is not a
  recorded remote sub of that chat is displayed on its own asker.
- A family lookup, `subchats::family::subs_of(state, main)`, returns local sub rows plus recorded
  remote subs (with the mirror row when the host is online). Every parent-side reader that today
  scans `state.registry` for `subchat_of == main` moves to it: the `subchat` tool, the cap
  (`spawn/cap.rs::started_subs`), `closing.rs` (`running_subs`, `needs_approval`, `settle_family`),
  `card_log.rs::all_finished_entry`, `worktree::unmerged_subs`.
- Nothing is ever forwarded more than one hop: a call that arrives from a `PeerMachine` is about
  the receiver's own sessions, as today.

## Wire

All new RPCs are `M` (paired machine only) rows in `TRANSPORT_TABLE`, each with a rationale
comment and an allowlist test entry. `peer_scope.rs`: home-to-host commands pass when the target
sub's `home.machine_id` is the caller; `sub_spawn` joins `STARTS_A_CHAT`; host-to-home events pass
when the remote-subs record says the caller hosts that sub. A bundle rides as base64 in the JSON
body, capped at `MAX_BUNDLE_BYTES` (20 MiB raw, so its base64 fits the 30 MiB `/api/rpc` body limit in `remote_server.rs`); bundle calls use `PeerClient::call_with_timeout`
(120 s) instead of the 10 s default. This repo's pack is about 2.8 GB, so a full-history bundle is
never sent: the host must already share history with the home (same origin) within the newest
4096 first-parent commits of the home's tip, and a spawn whose host shares no commit there is
refused with "fetch the project on the Mac first". A bundle is imported only into `refs/cc-sub/...`
or `refs/heads/sub/...`, its pack indexed with `git index-pack --strict` (fsck on every object;
`git fetch <bundle>` ignored `transfer.fsckObjects` on git 2.44), its head checked to be a
commit before the ref is set, and never into a branch a worktree has checked out (the host imports the
home's tip into `refs/cc-sub/<id>/target` and moves the sub's branch itself with a rebase). One
bundle carries at most 5000 commits, checked before it is written. A daemon start runs
`git_sync::sweep_leftovers` on each repo it hosts or homes a remote sub in, for the scratch refs
and files a crash can leave.

Home to host:

| Method | Does |
| --- | --- |
| `sub_git_have {repo, candidates}` | The newest candidate commit the host's clone already has, or null. `repo` is `{origin}` (always the normalised form from `project_match::origin_of`, never the raw URL, which can carry a token) or `{machine_cwd}`. |
| `sub_spawn {...}` | Resolves the host folder, imports the base bundle, makes the worktree at the base commit, stores the brief with `home`, registers the row (`subchat_of`, `started_by_machine`), and either starts the sub with the sub role (`spawn_session_as`) and the home-composed first message, or with `hold: true` only registers it waiting (an `after` chain). The sub id is minted by the home. |
| `sub_start {sub_id}` | Starts a held visiting sub (the home decided its `after` target is done, or Joe picked Start now). |
| `sub_update_branch {sub_id, target_tip, bundle}` | Imports the home's target tip and runs today's `update_branch` in the sub's tree against it: done, conflict (files), or failed. |
| `sub_fetch_branch {sub_id, exclude}` | The sub's branch as a bundle, excluding the home's target tip. |
| `sub_deliver {sub_id, text, writes, question}` | The `subchat send` delivery on the host: continue it, hold it until idle, or queue it behind a never-started sub. Returns passed, held or not started. |
| `sub_status {sub_id}` | Live facts (git, transcript), plumbing state and the finish record, for `subchat status` on a running sub. |
| `sub_end`, `sub_drop`, `sub_to_sidebar`, `sub_reparent {new_main_id}`, `sub_cleanup {merged_head}` | End it, drop a never-started one, release it to the host's sidebar, move it to a respawned main chat, remove its tree once the home merged `merged_head`. Sent through the outbox. |

Host to home:

| Method | Does |
| --- | --- |
| `sub_event {sub_id, seq, event}` | `finished {round, record, facts}`, `ended {reason}`, `wake {reason}` (stalled, card unanswered, plumbing problem), `open_requested`. Deduped on `(sub_id, seq)`. The home builds the notice text. |

Typing to a sub, cancel, model and effort already forward (`send_message` and friends are `PM`,
`machines/forward.rs`), and the host's `route_send` applies the sub rules because the host's row is
a sub. Question and permission answers already forward by `session_id`.

## Outbox

`subchats/remote/outbox.rs`, `<data_dir>/subchats/outbox[suffix].json`: ordered entries per
machine `{id, machine_id, method, params, created_at, attempts}`, written before the first send
attempt, delivered in order, retried on the busy_watchdog tick and when a `peer_link` connects,
removed on a reply (an error reply is logged and dropped, never retried forever). Only what must
survive a gap goes through it: `sub_event` (host to home) and `sub_end`, `sub_drop`,
`sub_to_sidebar`, `sub_reparent`, `sub_cleanup` (home to host). Interactive calls (`sub_spawn`,
`sub_status`, `sub_deliver`, the git calls) are direct and fail at once with "the Mac is
unreachable".

## Build steps

Each step is one sub. Steps run in order; a step names what it depends on.

1. **Git sync and project match** (built 2026-11-13 with this doc). `subchats/remote/git_sync.rs`:
   candidate list, `first_have`, `make_bundle` (temporary ref, size cap), `import_bundle` (verify, one
   head, `index-pack --strict`, head is a commit, compare-and-swap `update-ref`); `subchats/remote/project_match.rs`: origin URL normalisation and the match
   over a project list; `PeerClient::call_with_timeout`. Tests on temp repos. No wiring yet.
2. **Spawn on the host.** Home: a mode-on `spawn_chat` with `machine` (not `plain`, not a respawn)
   goes to `subchats::remote::spawn` instead of the plain-chat forward: the brief, name, model tier
   and cap checks of `spawn::plan` (the cap counting the family), gate refused, base and target
   from the home's checkout, have-negotiation, bundle, `sub_spawn`, then the remote-subs record.
   Host: the `sub_spawn` handler, project match with the refusal text for the main chat,
   `HomeRef`, worktree at the base commit (a new `worktree::prepare_at`), sub role launch, the
   parent label from the mirror row. Host guards: `heal_orphans` and `stuck::sweep_dead` never
   settle a visiting sub for a parent missing from the host's registry. The main chat's prompt and
   the `spawn_chat` schema learn `machine` and `machine_cwd` for subs. The spawn path gets a seam so
   loopback tests never launch `claude`. Tests: two in-process daemons (`remote_server::spawn_on`)
   over real temp clones sharing an origin.
3. **Events and the finish on the home.** Outbox (both directions, used here host to home only).
   Host: `on_finished` for a visiting sub skips the local merge and the family steps, keeps the host
   ones (writer slot, ceiling state), and queues `finished` with the record and the facts computed
   on the host; an ended visiting sub queues `ended`. Home: `sub_event` handler with the trust
   check; `finished` stores `<sub>.finish.json` on the home and runs the family steps
   (decisions, the card with the shipped facts, back, wake, `closing::on_sub_settled`,
   `held::on_target_done`); the family lookup lands here. Unreachable watch on the home's tick:
   `unreachable_since`, one wake after 10 minutes, cleared on reconnect. Until step 4 the card says
   the commits wait on the host's branch.
4. **Merge on the home.** `subchats/remote/land.rs`, the remote twin of `worktree::land_with` under
   the same repo lock: target branch check, `sub_update_branch` (conflict goes to
   `merge_followup::on_blocked`, whose "tell the sub" becomes `sub_deliver`), `sub_fetch_branch`,
   import as `refs/heads/sub/<id>` on the home (checking the imported head descends from the base
   the home sent, since `import_bundle` accepts any commit the repo already has), dirty-overlap check, ff-only merge, a second round
   when the target moved. `pending_merges` and `subchat merge` dispatch to it for a remote sub.
   After a merge: delete the home's `sub/<id>` branch and queue `sub_cleanup`. Tests: a host-only
   local commit never rides back, conflict, dirty overlap, target moved.
5. **Cards, watchers and secrets on the host.** `cards::raise` accepts a visiting sub's home main
   as the display chat (not in the host's registry). Stall, ceiling, stuck, card_watch and
   queue_watch treat a visiting sub's home as alive and send their wakes as `sub_event wake`; the
   stall card's Open it becomes `open_requested`. Home: the prompt-merge trust check from
   "Identity and trust". Secrets: the home merges a recorded remote sub's secret prompt and
   forwards its answer only when its link to the host is iroh; the host refuses `request_secret`
   for a visiting sub with the "ask Joe to put it on the Mac" note when the home reaches it over
   plain http (the home's check is the real guard).
6. **Every sub action across machines.** `subchat status` (`sub_status`, or the record and finish
   record when offline), `send` (`sub_deliver`), `drop`, `retry`, `merge`, `after` chains (the hold
   stays on the home; the host row is registered with `hold: true` and started with `sub_start`),
   Start now / Drop from the menu (`start_queued_sub`/`drop_queued_sub` dispatch to the host for a
   remote sub), continue after finishing, closing the main chat (counts, Close them too, Wait for
   them, `settle_family`), `move_family` on a respawn (`sub_reparent`), Move to sidebar
   (`sub_to_sidebar`, then `closing::after_leaving` on the home). `get_sub_brief` and
   `list_session_images` become `PM` with the home check so the Subchats card shows a remote sub's
   brief and images.
7. **What Joe sees.** `Instance.subchats_on` (`#[serde(default)]`, stamped from chat-config on
   local rows, `instances_changed` republished on a mode flip, `ipc.generated.ts` regenerated) and
   an `isMainChat(session)` helper replacing bare `isSubchatsOn(id)` in `sidebar-entries.ts`,
   `main-chat.ts`, `project-main-chats.ts`, `asker-face.ts`, the menu ctx; a viewer then lists a
   peer's main chat under Main chats. `peer_link` relays a peer's `subchat_card` frame for a chat
   that peer owns (dedupe by card id, so the two links do not echo). The sub list and Subchats card
   show the machine icon on a remote sub. View specs.
8. **Live run and docs.** Two dev daemons (`CC_DAEMON_INSTANCE`, `CC_DATA_DIR`, `CC_REMOTE_PORT`),
   paired by `http://127.0.0.1:<port>`, two clones of a scratch repo sharing a local bare origin:
   a main chat on one spawns a sub on the other, the sub asks a question answered from the home,
   commits, finishes; the finish card, the one line back and the merged commit land on the home.
   Then the host is stopped mid-job and restarted (outbox delivery, unreachable wake). A secret
   request over the http link is refused. Never touches the production daemon on 27183. Update
   `subchats.md`, `multi-machine.md` (the "Subchats on a paired machine" section) and `README.md`.

## Known limits (by design)

- One hop: a sub is hosted by a machine paired with its home directly.
- A gate sub always runs at home.
- A writing sub on the host needs a folder that can have a worktree.
- The host must share history with the home; a full-history bundle is never sent.
