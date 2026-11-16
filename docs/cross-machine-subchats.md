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
| `sub_start {sub_id, retry, target_tip?, bundle?}` | Starts a held visiting sub (the home decided its `after` target is done, or Joe picked Start now). With `target_tip` (and the commits the host lacks) a writing sub's tree is first rebased onto the home's current target tip. |
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
   Built 2026-11-15 in slices 2a-2g. How it ended up, where it differs from the text above:
   - `worktree::prepare_at(cwd, sid, base, target)` starts a tree at a full commit id; `info.target`
     on the host is only the home's branch name. `heal_orphans`, `held::orphaned` and
     `worktree::before_continue` skip a sub whose brief has a `home` (`subchats::is_visiting`);
     `stuck::sweep_dead` already skipped a sub whose parent is not in the registry.
   - Host: `remote/host.rs` (`sub_git_have`, `sub_spawn`), registered by `register_machines`. A
     read-only sub runs in the matched project folder and needs no commits (no base, no bundle);
     a writing sub gets `refs/cc-sub/<id>/target` (bundle imported, or `git_sync::pin_commit` when the
     clone already has the base) and a worktree at it, and is started through the held launch
     (`writers::run_start`). The first message is the home's plus the worktree note. A
     `Starter` seam keeps tests from launching `claude`. `hold: true` registers without starting
     (the start call is step 6). A mirror-row parent label feeds the sub's prompt.
   - Home: `remote/spawn.rs`, reached from `spawn_chat_or_forward` for a mode-on, non-plain,
     non-respawn call with `machine`. `spawn::plan_remote` shares the checks of `plan`; a gate
     and `after` are refused for another machine (`after` is step 6). `machine_cwd` is a
     `SubchatArgs` field. The cap (`cap::reserve`) and the name check count the records.
     The record is written before `sub_spawn`; a definite refusal removes it, an unreachable
     host keeps it with a note, since the host may have started the sub.
   - Daemon start: `remote::sweep_at_start` covers the home's recorded repos and the host's
     visiting subs' repos. Tests: `remote/host_tests.rs`, `remote/loopback_tests.rs` (two daemons
     over `spawn_on`).
3. **Events and the finish on the home.** Outbox (both directions, used here host to home only).
   Host: `on_finished` for a visiting sub skips the local merge and the family steps, keeps the host
   ones (writer slot, ceiling state), and queues `finished` with the record and the facts computed
   on the host; an ended visiting sub queues `ended`. Home: `sub_event` handler with the trust
   check; `finished` stores `<sub>.finish.json` on the home and runs the family steps
   (decisions, the card with the shipped facts, back, wake, `closing::on_sub_settled`,
   `held::on_target_done`); the family lookup lands here. Unreachable watch on the home's tick:
   `unreachable_since`, one wake after 10 minutes, cleared on reconnect. Until step 4 the card says
   the commits wait on the host's branch.
   Built 2026-11-15 in slices 3a-3d. Where it differs from the text above:
   - `PeerError::NotSent` (a connect refused, a tunnel that failed to open, remote access off) is told
     apart from `Unreachable` (the peer may have read the call): `remote/spawn.rs` takes its record
     back on `NotSent` only, so a link that never carried `sub_spawn` leaves no phantom record.
   - `remote/outbox.rs`: the file is `{seqs, entries}`; an event number is `max(last + 1, clock in
     ms)` per sub, so a lost table restarts above anything the home has seen. One delivery pass per
     machine at a time, in order; a reply settles an entry, except a reply that decided nothing (the
     peer's own failure -32603, a build that lacks the method -32601, an unreadable reply), which is
     retried up to 50 times; a link that was down never counts. An entry for a machine that is not paired
     any more waits until the 500-entry cap rotates it out (an unreadable machines file must never
     read as "unpaired"). 500 entries per machine, 512 KiB each.
     `watch::tick` (busy_watchdog) and a connecting peer link (`watch::on_peer_connected`) flush it.
   - `remote/events.rs`: `Event` is `Finished {round, record, facts, model, effort}`, `Ended` or
     `Wake {problem, detail}`. The host queues `Finished` from `subchats::on_finished` on a thread
     (facts come from `card_log::sub_facts`, which skips the local `annotate` for a visiting sub),
     `Ended` from `on_chat_ended`, and `Wake` from `plumbing::report`'s visiting branch, so a launch
     failure of a visiting sub now reaches the home.
   - `remote/home.rs` (`sub_event`, `M`): applied only when `records::accepts(sub, ctx.transport's
     machine)`; a number at or below `RemoteSub.last_seq` and a round at or below
     `RemoteSub.finished_round` do nothing; `events::clean_record`/`clean_facts` cut every field, take the
     ids from the record, drop the reviewer id and the host's `merged`; a `Wake` is taken only for
     `could_not_start` and `could_not_rebuild` and goes through `plumbing::report_here`, whose
     notice is built from ids and fixed words (the detail is only `subchat status` data).
     `subchats/family.rs` is the lookup the all-finished card, the `report_back` wake, the `wait for
     them` close and the plumbing wake use; `RemoteSub` also holds `report_back`.
     The view-only branch of `peer_scope` passes `sub_event` for a recorded sub.
   - `remote/watch.rs`: the 10 minute wake reads `MirrorState::is_online`; the machine label in the
     wake is cut to plain characters like a sub's name.
   - A finish numbered after the end of the same chat (the host builds it on a thread) still counts on
     the home, and the sub stays ended.
   - Not done here: `closing::needs_approval` and `settle_family` still count local rows only
     (step 6), and a visiting sub's stall and death cards stay step 5.
4. **Merge on the home.** `subchats/remote/land.rs`, the remote twin of `worktree::land_with` under
   the same repo lock: target branch check, `sub_update_branch` (conflict goes to
   `merge_followup::on_blocked`, whose "tell the sub" becomes `sub_deliver`), `sub_fetch_branch`,
   import as `refs/heads/sub/<id>` on the home (checking the imported head descends from the base
   the home sent, since `import_bundle` accepts any commit the repo already has), dirty-overlap check, ff-only merge, a second round
   when the target moved. `pending_merges` and `subchat merge` dispatch to it for a remote sub.
   After a merge: delete the home's `sub/<id>` branch and queue `sub_cleanup`. Tests: a host-only
   local commit never rides back, conflict, dirty overlap, target moved.
   Built 2026-11-15 in slice 4a-4b. Where it differs from the text above:
   - `remote/land.rs` (home) and `remote/host_land.rs` (host, `sub_update_branch`, `sub_fetch_branch`,
     `sub_cleanup`, all `M` rows with a rationale, an allowlist entry and a `peer_scope` branch that
     reads the sub's stored `home.machine_id`). The home sends `base..tip` as the bundle (the host has
     `base`: its tree started there), so no extra have-call is needed; a target that moved too far for
     one bundle is refused with a note. The host moves `refs/cc-sub/<id>/target` to the tip and
     rebases the sub's branch onto it (`worktree::update_onto_ref`, the same rebase and conflict
     handling a local sub gets); a branch that is not finished or not the caller's is refused.
   - The imported head must equal what the host named, must descend from the tip that was sent, and
     is imported only into `refs/heads/sub/<id>`, which is deleted whether or not it merged. A
     refusal is `Cause::DirtyOverlap` (kept pending and landed by the tick), `Conflict`,
     `BranchSwitched` or `Other`; `merge_followup::on_blocked_remote` stores it in `pending_merges`
     and wakes the main chat (a conflict is not told to the sub yet: that is `sub_deliver`, step 6).
   - After a merge the home queues `sub_cleanup {sub_id, merged_head}` through the outbox; the host
     removes the tree only when `merged_head` is everything the branch holds, by moving its
     `refs/cc-sub/<id>/target` to that head first so `remove_if_safe`'s checks all still apply
     (`worktree::remove_landed`).
   - `merge_followup::merge_now` and `retry_pending` dispatch to `land` for a recorded remote sub,
     and `home::finished` lands a writing sub before the card, the line back and the wake, so they see
     what landed (`facts.merged` is the home's own answer).
5. **Cards, watchers and secrets on the host.** `cards::raise` accepts a visiting sub's home main
   as the display chat (not in the host's registry). Stall, ceiling, stuck, card_watch and
   queue_watch treat a visiting sub's home as alive and send their wakes as `sub_event wake`; the
   stall card's Open it becomes `open_requested`. Home: the prompt-merge trust check from
   "Identity and trust". Secrets: the home merges a recorded remote sub's secret prompt and
   forwards its answer only when its link to the host is iroh; the host refuses `request_secret`
   for a visiting sub with the "ask Joe to put it on the Mac" note when the home reaches it over
   plain http (the home's check is the real guard).
   Built 2026-11-16 (commit d4bbb0b6 and the wire rows in the step 6 commit). Where it differs from the text above:
   - A daemon card the host raises for a visiting sub (`cards::raise`, reached from `stall`, `ceiling`,
     `stuck`) carries `display_session_id` = the home's main chat, but `session_id` = the sub: the sub's row
     is what waits (`awaiting`) and what a forwarded `respond_question` is routed by (`mirrored_owner`). The
     host sends no push or sound for it; the home's own notifier sees the card through the mirror.
     `subchats::parent_live` is what the host's watchers ask in place of `held::chat_live`: a visiting sub's
     home is taken as alive (the home ends the sub itself when its chat closes).
   - `Event` gained `Notice` (`CardUnanswered {cause, minutes}`, `ContextBand {pct}`) and `OpenRequested`.
     The home words a notice itself from the kind and clamped numbers (`card_watch::notice`,
     `ceiling::context_notice`); an unanswered stall card and a context band no longer enqueue a wake on the
     host. `queue_watch` stays inert for a visiting sub: its hold has no `after` on the host, so there is no
     stall to tell until step 6's `after` lands on the home.
   - `machines::mirrored_prompts` judges a mirrored prompt by who vouched for it
     (`MirrorState::prompts_by_machine`): a `display_session_id` naming a chat of this machine is honoured only
     for a sub the records name as hosted by that peer for that chat, otherwise the card shows on its asker. A
     mirrored `secret-requested` prompt is kept only for such a sub and only while the peer link is encrypted
     (`peer_client::link_is_encrypted`: no direct URL, an iroh id). The desktop's `respond_secret` forwards a
     card it does not hold to the host (`mirrored_secret_owner`), so no app or frontend change was needed; the
     host's handler refuses a paired machine unless the prompt is a sub whose stored home is the caller.
     `respond_secret` is an `M` row now (a phone still has none).
   - The host's `request_secret` refusal reads its own registry entry for the home (a direct URL is plain
     http, an unknown home counts as plain): it can disagree with how the home reaches it, so the home's check
     stays the guard and a sub that asked anyway waits on a card the home never shows.
   - Not mirrored: a peer's row claiming `subchat_of` a chat of ours (the row half of "Identity and trust") is
     still taken as sent; it is step 7's, with the viewer.
6. **Every sub action across machines.** `subchat status` (`sub_status`, or the record and finish
   record when offline), `send` (`sub_deliver`), `drop`, `retry`, `merge`, `after` chains (the hold
   stays on the home; the host row is registered with `hold: true` and started with `sub_start`),
   Start now / Drop from the menu (`start_queued_sub`/`drop_queued_sub` dispatch to the host for a
   remote sub), continue after finishing, closing the main chat (counts, Close them too, Wait for
   them, `settle_family`), `move_family` on a respawn (`sub_reparent`), Move to sidebar
   (`sub_to_sidebar`, then `closing::after_leaving` on the home). `get_sub_brief` and
   `list_session_images` become `PM` with the home check so the Subchats card shows a remote sub's
   brief and images.
   Built in part 2026-11-16 (b5be72c5 and the closing slice). Done: `subchat list`, `status`, `send`, `retry`,
   `drop` and `merge` for a remote sub (`remote/actions.rs` home side, `remote/host_actions.rs` host side:
   `sub_deliver`, `sub_status`, `sub_start`, `sub_end`, `sub_drop`, `sub_to_sidebar`, all `M` rows that act only on
   a sub whose stored home is the caller). Differences from the text above:
   - `drop` is a call, not an outbox entry: the host decides whether the sub ever ran, so its refusal is the
     answer. `sub_end` and `sub_to_sidebar` go through the outbox. `sub_start` is a call.
   - A message is composed on the home (Joe's words, the framed main-chat text, the question job); the host only
     delivers it (`tool::deliver`, the same code a local send runs). A reader cannot be made a writer on the host
     (it has no worktree); an Opus sub cannot write.
   - A finished remote sub that takes a message goes back to `Running` in its record.
   - Closing the main chat counts remote running subs (`needs_approval`, the card names them, "Wait for them" waits
     for them, "Close them too" ends them through the outbox); a main chat that goes away hands a running remote sub
     to its host's sidebar and ends a finished or never-started one (`closing::settle_family`).
   Finished 2026-11-16 (pc-1733, the leftovers):
   - `after` chains (`remote/after.rs`). `spawn::plan_remote` no longer refuses `after`: the hold plan is
     resolved over local rows AND remote records (`held::plan_after_all` falls back to `tool::resolve_remote`;
     `held::after_state` reads a record for a target that has no row, so a local sub can wait for a remote one
     too). The host registers the sub with `sub_spawn hold: true` (its row says "waiting for <names>"), the home
     keeps the wait in the record (`RemoteSub.after`, `after_name`, `cleared`, state `Held`) and runs the same
     evaluation a local wait gets (`held::evaluate_after`, shared with `held::after_all`). `held::sweep` (boot,
     the 60 s tick, every finish) calls `remote::after::sweep`: a clean wait starts the sub with `sub_start`; a
     blocked one raises the same "Queued sub" card (`held::CARD_KIND`, display = the main chat, sub id = the
     remote sub) whose answers start it anyway, drop it, or park it; a refused start is plumbing
     (`CouldNotStart`, parked until `subchat retry`), a host that does not answer is retried by the next pass and
     says nothing (`actions::UNREACHABLE`). A home-side watch (`after::stalled_tick`, from
     `queue_watch::tick`) wakes the main chat once when a sub waited 5 minutes with nothing in its way.
   - The host never starts a waiting sub by itself: `held::waits_on_home` (a visiting sub, no `after` on the
     host, row reason "waiting for ...") is skipped by the boot passes that start every other hold without an
     `after` (`writers::restore_inner`, `worktree::restore`). A target whose landing is running
     (`merge_followup::landing_in_flight`, set by `home::finished` before the Finished record is visible) reads as
     pending, a target ended with its finish numbered after the end counts as finished, and a `sub_start` the host
     already accepted (`ALREADY_STARTED`) counts as done; the pass, the menu and `subchat retry` share one claim per sub.
   - A writing sub that waited is caught up before it starts: `sub_start` carries `target_tip` and the commits
     the host lacks (`land::offer`), and the host rebases the still-empty tree onto it
     (`host_land::update_blocking`), so it builds on what the earlier sub merged. A checkout that is not on the
     target refuses the start with a note.
   - Start now / Drop (`queued::start_now`, `queued::drop_any`, the `drop_queued_sub` IPC) dispatch by id to
     `actions::start` / `actions::drop_never_started` for a sub that has a record and no row. The menu has no row
     for a remote sub until step 7, so nothing in the UI calls them yet.
   - `sub_reparent {sub_id, new_main_id}` (`M`): `closing::move_family` moves the records
     (`actions::reparent_family`) and queues one entry per live sub through the outbox; the host rewrites the
     sub's `subchat_of`, brief parent and `home.main_id` (never the home machine) and refuses a new main chat id
     that names one of its own chats.
   - `get_sub_brief` is a `PM` row: the home asks the host for a remote sub's three brief lines
     (`actions::brief`); a paired machine reads only a sub whose stored home is the caller and every other id
     answers as an unknown one. `list_session_images` stays phone-only: its ids are paths on the host that the
     home's gallery would have to fetch from the host, and a host-minted id must never be read by the home's
     gallery as a path, so a remote sub shows no images until that fetch exists (open question in the todo).
   - A merge conflict is told to the remote sub: the first one in a row is delivered with `sub_deliver`
     (`merge_followup::tell_text_remote` names `refs/cc-sub/<id>/target`, the host's copy of the target tip),
     the record goes back to `Running` at once, and a second conflict, or a host that could not deliver, wakes
     the main chat as before.
   - `merge_followup::retry_pending` lands a remote sub on a detached task with a per-sub in-flight guard, and
     `held::sweep` runs the remote `after` pass on its own task, so a slow host no longer holds the rest of the
     watchdog tick. The finish's landing, the tick's retry and `subchat merge` share that guard (one landing per
     sub), and each drops it before the sweep it starts.
   - Outbox entries for an unpaired machine are still kept until the 500-entry cap rotates them out (decision
     D271); nothing there is a defect while an unreadable machines file can read as empty.
   - Not built: continuing a finished remote sub from the sub list's own composer is step 7's (it needs the row);
     the tool's `send` works.
7. **What Joe sees.** `Instance.subchats_on` (`#[serde(default)]`, stamped from chat-config on
   local rows, `instances_changed` republished on a mode flip, `ipc.generated.ts` regenerated) and
   an `isMainChat(session)` helper replacing bare `isSubchatsOn(id)` in `sidebar-entries.ts`,
   `main-chat.ts`, `project-main-chats.ts`, `asker-face.ts`, the menu ctx; a viewer then lists a
   peer's main chat under Main chats. `peer_link` relays a peer's `subchat_card` frame for a chat
   that peer owns (dedupe by card id, so the two links do not echo). The sub list and Subchats card
   show the machine icon on a remote sub. View specs.
   Built 2026-11-16 (pc-1733). Where it differs from the text above:
   - There is no `Instance.subchats_on`: `Instance` is outside the paths this step was written in, and a viewer
     only needs the set. `machines/main_chats.rs` fetches each peer's `list_subchats_on` when its link connects and
     on every `subchats_on_changed` frame it sends, keeps it in `MirrorState` (`set_main_chats`, `main_chat_ids`:
     only ids that peer both reports and hosts, never a local id) and publishes the local `subchats_on_changed`
     when the shown set moves. `machines::main_chats::mirrored_main_chat_ids` is the merge a client's `list_subchats_on` must
     add. **Parked:** the RPC handler (`methods/registry/listings.rs`) does not call it yet, so a viewer still lists
     a peer's main chat as an ordinary chat; the hook-up is one line there (`ids.extend(machines::main_chats::mirrored_main_chat_ids(&state))`
     plus a test), and the frontend needs nothing, since `isSubchatsOn`/`showsSubs` already read that list.
   - `peer_link` relays a peer's `subchat_card` frame for a chat that peer owns (`relay_subchat_card`: rebuilt from the
     typed `CardEntry`, refused when the card's `parent_id` is not the frame's chat, `replace` kept). The echo dies at
     the peer, whose own link finds the id local.
   - The row half of "Identity and trust": `machines::all_instances` clears a mirrored row's `subchat_of` when it
     names a chat of this machine unless `remote::records` says that peer hosts that sub for that chat
     (`confine_subchat_of`), so a peer can no longer put a row in another chat's dots, count or Subchats card. A
     `subchat_of` naming the peer's own chat (the viewer case) is left alone.
   - A visiting sub's `blocker`, `answer` and `rating` messages (`card_log::on_blocker`/`on_answer`) used to be written
     into a card log on the host. They now go to the home as `Event::Card` (`events::CardEvent`, cut by
     `events::clean_card`: three kinds only, text 4000, six details with plain-slug ids, three visuals of at most
     16 KiB), and `card_log::draw_remote_card_at` draws them under the home's record (name from the record). The
     host spends the brief's pending question once the event is queued. `update_message` of a visiting sub's
     answer is not mirrored (it rewrites a card in the host's log, which does not exist).
   - Joe's answer to a visiting sub's question card is a decision of the home's main chat:
     `decisions::record_remote_card_answer` writes it when the home forwards `respond_question` (`machines/forward.rs`,
     before the mirror drops the card; only a submitted answer, only for a sub the records name for that machine),
     and `card_ctx` writes nothing for a visiting sub on the host. Found by the step 8 live run: the host had written
     the home's decisions log.
   - `CardEntry.machine` (plain-character label, absent for a local sub) names where a sub ran on its finish, blocker
     and answer cards; the finish card keeps it after the machine is gone.
   - Frontend: `SubStatus.machine` (the mirrored row's `MachineRef`) feeds the sub list's `.sub-machine` chip
     (`sub-machine.ts`: the machine's own icon from `machine-icons.ts` and its name), the Subchats card avatar's hover
     card ("Sonnet high, on Mac mini" with a middle dot) and, through `CardEntry.machine`, the finish card's tag note. A sub whose
     machine is offline reads "<label> offline" in place of a guessed state, never when it has finished. Ring colours
     and dots are unchanged: they come from the same `kindOf`. `tests/subchat-machine.test.mjs` and
     `e2e/view-harness/subchat-machine.view.spec.ts` cover it.
   - Not built: `list_session_images` for a remote sub (the host's image ids are paths there; the home's gallery needs a
     forwarded fetch first), and continuing a finished remote sub from its list composer was not re-checked beyond the
     tool's `send`.
8. **Live run and docs.** Two dev daemons (`CC_DAEMON_INSTANCE`, `CC_DATA_DIR`, `CC_REMOTE_PORT`),
   paired by `http://127.0.0.1:<port>`, two clones of a scratch repo sharing a local bare origin:
   a main chat on one spawns a sub on the other, the sub asks a question answered from the home,
   commits, finishes; the finish card, the one line back and the merged commit land on the home.
   Then the host is stopped mid-job and restarted (outbox delivery, unreachable wake). A secret
   request over the http link is refused. Never touches the production daemon on 27183. Update
   `subchats.md`, `multi-machine.md` (the "Subchats on a paired machine" section) and `README.md`.
   Built 2026-11-16: `scripts/cross-machine-verify.mjs --exe <cc-conductor-daemon.exe> [--keep]` (build the daemon and
   `scripts/build-fake-claude.ps1` first; it builds nothing, tears down by PID and plays the sub itself through the hook
   routes, so no model is billed). Two real daemon processes (own data folders, `CC_DAEMON_INSTANCE`, ports), a bare
   origin and two clones, paired by `pair_machine` over `http://127.0.0.1:<port>`. It checks, 18 in all: spawn on the
   host, the host's row stamped as the home's sub, the home's mirrored row carrying the machine, the question card shown
   on the home and its answer settling the host's card and landing in the home's decisions log (and nowhere on the host),
   the answer card and its machine label, the secret request refused over http, then the home stopped while the sub
   commits and finishes: the finish waits in the host's outbox, the home restarts, the event arrives, the finish card
   names the machine and the commit is merged into the home's checkout. It found and this build fixed two bugs: the host
   wrote the home's decisions log, and a visiting sub's answer and blocker cards were written on the host and never
   shown. Needs: a dummy `.credentials.json` per profile (the drift guard), distinct machine labels (both daemons share
   the PC's hostname, and a `machine` equal to this machine's own label spawns locally). Not covered by the run: the
   10 minute unreachable wake (needs the time), a real model, iroh (instances other than the default advertise no
   tunnel, so a secret over iroh stays covered by unit tests only).

## Known limits (by design)

- One hop: a sub is hosted by a machine paired with its home directly.
- A gate sub always runs at home.
- A writing sub on the host needs a folder that can have a worktree.
- The host must share history with the home; a full-history bundle is never sent.
