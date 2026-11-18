# Chat RAM plan

Goal: stop chat processes that are doing nothing, so the `claude.exe` total in Task Manager
drops. Written 2026-11-18 from one measurement session and revised the same day after three
independent reviews. Every figure below was measured that day on Joe's PC (32 GB RAM) unless
marked UNVERIFIED. Paths are relative to the repo root; `daemon/` means `src-tauri/src/daemon/`.

## What was measured

- The daemon runs each chat as its own `claude -p --input-format=stream-json` process.
- 16 chat processes were alive: about 9.4 GB reserved (private bytes), about 3.1 GB in RAM.
- A process reserves 500-760 MB whatever the chat's size. In RAM it holds 250-370 MB while
  working and 110-200 MB after hours idle (Windows trims it).
- Of the 16: 6 working, 4 finished and idle 1-10 h, 3 waiting on a question card (two for
  10 h: a main chat and its sub), Jarvis and one worker idle 20 h, 1 frozen during the
  measurement at 31 min.
- The limit no step here changes: a working chat costs 250-370 MB of RAM. Stopping every
  idle chat frees about 1-1.5 GB of RAM and about 5 GB of reserve.

## What the three checks settled

1. **Spawn flags do not shrink the process.** Five throwaway processes, no message sent,
   measured after 30 s:

   | Flags | Reserved MB | In RAM MB |
   | --- | --- | --- |
   | none | 522 | 232 |
   | `--no-chrome` | 516 | 231 |
   | `--disable-slash-commands` | 527 | 232 |
   | `--strict-mcp-config` | 531 | 225 |
   | all three | 508 | 224 |

   The spread is noise. The fixed cost is the runtime itself, so there is no flag step.

2. **A finished sub has no process.** `commit_finish` sets `subchat_finished` and kills the
   child in the same call (`daemon/subchats/finish.rs:475-485`); a follow-up respawns it
   through `resume::continue_sub`. A finish request that is dropped (background work still
   running, uncommitted edits, a review gap: `finish.rs:427-452`) leaves the sub unfinished
   and alive, on purpose. The subs seen alive were unfinished ones, one of them waiting on a
   question card for 10 h.

3. **A question card does not hold a live call.** The `ask_user_question` tool waits at most
   8 s for a client to confirm the card rendered, never for the answer, and the turn ends
   (`daemon/hooks_server/question.rs:162,181-242`). Every question card is durable
   (`question.rs:133`): kept in `pending-questions.json`, and a child exit does not expire it
   (`daemon/state/prompts.rs:198-207`). The answer arrives as an ordinary user message.
   Permission and secret cards are the opposite: non-durable (`hooks_server/permission.rs:163`,
   `hooks_server/secret.rs:103`), the child blocks on them, and a child exit expires them.
   Those chats must never be stopped while such a card is open.

## Steps

One sub per step, in order. Before a step starts, rebase on master and re-check the two subs
that were working nearby on 2026-11-18: `todos-b12-idle-freeze-heads-order` (branch
`sub/3361ac3b`, had no commits yet) and `todos-b9-sub-wake` (branch `sub/0eae16ce`, editing
`subchats/wake.rs`, `card_watch.rs`, `compaction.rs`, `resume.rs` and
`docs/architecture/subchats.md`). Every step that edits `daemon/subchats/` reads
`docs/architecture/subchats.md` first.

Verify commands for every step: `cargo test --manifest-path src-tauri/Cargo.toml --lib
idle_freeze` (plus the modules the step touches), `pnpm run typecheck`, and the vitest command
in the root `CLAUDE.md`.

### Step 1: release the stale-stamp fix

Nothing to write. Installed v0.2.155 refuses to idle-freeze any chat carrying a
`rate_limited_resets_at` stamp, and nothing clears that stamp; the repo only blocks while the
stamp is in the future (`daemon/subchats/idle_freeze.rs:86`). UNVERIFIED that this is what
kept the 4 finished chats alive (the stamp is in memory only), so step 5 checks.

### Step 2: idle stop after 15 minutes, without losing idle compaction

- `IDLE_FREEZE_AFTER` (`idle_freeze.rs:25`) from 30 to 15 minutes. The module doc (line 3) and
  the log line (line 346) hardcode "30 minutes": derive the text from the constant.
- **Compaction clash.** Idle compaction needs a live child and 30 quiet minutes
  (`IDLE_COMPACT_AFTER`, `daemon/subchats/compaction.rs:81,404,416`), and runs in the same
  sweep just before the freeze (`compaction.rs:579-589`). A 15-minute freeze would kill the
  child first, so a large chat would never be compacted while idle. Rule: the freeze skips a
  chat that idle compaction is still waiting on (past `IDLE_FLOOR_TOKENS`, not yet compacted
  in this quiet stretch); that chat is compacted at 30 minutes and frozen 15 quiet minutes
  after. Add the blocker and a test that a chat past the floor is not frozen at 15 minutes
  and a chat under it is.
- Make the duration overridable for a live run: an env var read once at daemon start
  (`CC_IDLE_FREEZE_SECS`), used by `sweep()` where it passes `IDLE_FREEZE_AFTER` to `due()`
  (`idle_freeze.rs:310`). Step 3c needs it.
- Docs: every "30 minutes" about the freeze in `docs/chat-heads-design.md` (lines 14, 77, 145
  and "Freeze becomes invisible") and `docs/architecture/chat-dashboard.md` (lines 34, 61).
- Why 15 is cheap: `docs/chat-heads-design.md` lines 104-106 measured a wake at about 5.5 s,
  and a wake after 11 idle minutes read 43,407 of 43,497 prompt tokens from cache.

### Step 3: stop a chat that waits on a question card

The largest idle group. Scope: a plain chat (not a sub, not Jarvis) whose only open cards are
durable question cards. Same timer as step 2. Three subs, in this order.

#### 3a: daemon

Freeze rule (`idle_freeze.rs`):

- `blocker()` accepts `awaiting == "question"` only when no card that holds a live call is
  open. `awaiting` is "question" for permission and secret cards too
  (`hooks_server/question.rs:24-40`), so the test is the card's `durable` flag, never the
  awaiting word.
- Do not change `lifecycle::has_open_prompt` (`daemon/lifecycle.rs:55`): the sub nudge and
  four other callers depend on "any card". Add a new helper, `holds_live_call` (true when the
  session has a non-durable open card), and use it for `Facts.open_prompt`. Correct the doc
  comment on `has_open_prompt`, which says the child is parked on the answer.
- `local_task_running`, `live_subs`, `held_count` and the rest keep blocking. A parent with a
  live sub is step 4.
- The freeze leaves the card and `awaiting = "question"` as they are, and `sync_markers` plus
  the boot restore (`sessions/persistence.rs:243-245`) keep working for a frozen chat with a
  card.

Wake path. Today an answer to a chat with no child goes: `send_message` RPC returns NotFound
(`daemon/methods/lifecycle/core.rs:62`), the desktop retries with `start_session`
(`src-tauri/src/ipc/chat/run.rs`), and `spawn_session` refuses a frozen row
(`daemon/lifecycle/spawn.rs:128`, `LifecycleError::Frozen`).

- Fix it in `spawn_session`'s frozen guard: a row that `idle_freeze::is_idle_freeze` is woken
  there (`idle_freeze::wake`, as the respawn helper at `spawn.rs:400` already does) and the
  spawn goes on. A usage-limit or manual freeze still returns `Frozen`.
- Not inside the `send_message` RPC: the desktop window only re-attaches to the new stream on
  the NotFound retry (`run.rs:215-269`, reported by a reviewer, read it before building), so a
  respawn hidden inside `send_message` would show no reply.
- The phone's REST send already wakes through `send_message_with_respawn`
  (`daemon/remote_handlers.rs:279`, `daemon/lifecycle/teardown.rs:256`).

Never lose an answer:

- The card is removed before the text is sent, on two paths: `respond_question`
  (`daemon/methods/permission.rs:249`, called first by
  `src/views/sessions/permission-modal/question-submit.ts:219`, text sent at lines 261-270) and
  `settle_answered_questions` (`core.rs:100`). If the wake or respawn then fails, the card is
  gone and the answer with it. Change: for an idle-frozen chat, wake and respawn first, then
  settle; or restore the card when the send fails. Pick one and cover both paths.
- An answer racing the kill. `freeze()` re-checks before and after
  `kill_and_wait_for_teardown` (`idle_freeze.rs:323-329`), but during the teardown the session
  is still in the map, so `send_message` can write into the dying child and settle the card.
  Change: a per-session "freezing" flag set before the kill and cleared after; `send_message`
  on a flagged session waits for the teardown and then takes the no-child path. Also re-read
  `holds_live_call` after the kill is decided, so a permission card that opens in that window
  is not expired.
- A scheduled message fired into a frozen chat with an open card clears `awaiting`
  (`daemon/schedule_fire.rs:103-107,140`) and leaves a ghost card. Change: leave `awaiting`
  alone while a durable card is open.

Rust tests, in the test module of the file they exercise, each red without the change:

- `blocker`: durable question allowed; question awaiting with a permission card, with a
  secret card, with a running local task: all blocked.
- Freeze of a question-waiting chat keeps the card and `awaiting`.
- `spawn_session` on an idle-frozen row wakes and spawns; on a limit-frozen and on a manually
  frozen row it returns `Frozen`.
- `respond_question` followed by a failed respawn keeps or restores the card.
- A send during the freezing window is delivered after the respawn, not into the dying child.
- A scheduled fire with a durable card open keeps `awaiting`.

#### 3b: front end

- `sessionSegment` returns 6 (Scheduled) for any `auto_frozen` chat before it looks at the
  question state (`src/views/sessions/sessions-helpers.ts:233`), so a frozen chat with a card
  would leave Input Needed on desktop and phone. Skip that line for an idle-frozen chat.
- An idle-frozen chat shows nothing on its head today (`isIdleFrozen` and the ring state in
  `src/views/sessions/chat-heads-model.ts`). One with an open card keeps its question state on
  the head, the sidebar and the dashboard's Waiting card.
- `selectSession` fires `unfreeze_session` without awaiting it
  (`src/views/sessions/active-session.ts:178`), so a fast card submit can race it. With the
  3a guard the submit no longer depends on it; confirm with a spec.
- View specs with an `// asserts: <src path>` header, in
  `e2e/view-harness/chat-heads.view.spec.ts` or a new spec beside it: the head and the sidebar
  segment of an idle-frozen chat with a card, at desktop and phone width. Run
  `pnpm run check:view-spec-coverage`.
- Update the freeze conditions in `docs/architecture/chat-dashboard.md` (line 61, "no open
  card") and "Freeze becomes invisible" in `docs/chat-heads-design.md`.

#### 3c: live run

With a real claude (`scripts/live-verify.ps1`, read `docs/architecture/dev-rigs.md` first) and
`CC_IDLE_FREEZE_SECS` set low: ask a question, wait for the freeze, answer from the card, and
confirm the model continues from the answer and the reply streams into the window. Repeat
answering from the phone page. Check the first turn's `usage` for a cache read.

### Step 4: subs that wait, and parents of subs (decide after step 5)

Not sized. A reader of the subchats code called an unfinished waiting sub "days": it holds the
writer slot, wake and held-message state, and the stall, stuck and nudge paths assume a child.
`todos-b9-sub-wake` is changing sub wake (one main-chat wake per stall episode); build on it,
do not redesign wake. Two cases, to design only if step 5 shows they still matter:

- A sub waiting on a question card.
- A parent blocked from freezing only because it has a live sub. Needs proof that a sub's
  finish wakes a frozen parent.

### Step 5: measure again

After the release with steps 1-3 has run for a day, repeat the measurement: per-process
private bytes and working set, idle minutes from the transcript file's last write, and
`awaiting` / `subchat_of` / `jarvis` / `worker_of` from `interactive-sessions.json`.

Pass: no plain chat that is done, or waiting on a question card, has a process after 20 idle
minutes. Expected survivors, not failures: Jarvis and its workers, subs, a parent with a live
sub, a chat with a held message, a running local task or an open permission or secret card,
and a chat past the compaction floor in its first 45 quiet minutes. Then decide step 4 from
what is left.

## Dropped, with the reason

- Spawn flags: measured, no effect (table above).
- Stopping finished subs: already happens.
- Read-only subs as in-process subagents: loses the sub's own worktree, card, model and
  account; rejected 5 of 5 by the review council.
- Hosting chats in `claude --bg`: the help text shows nothing about a shared process, and it
  would bypass the stream the daemon reads.
- Trimming an idle process's working set, recycling a grown process: Windows already trims
  idle chats, and the growth is mostly reserve, not RAM.
- Idle-stopping Jarvis and its workers: 2 processes, and a missed wake path leaves the router
  silent.
- A cap on live processes: redundant once the timer is 15 minutes.
- A queue for test runs across subs: `vitest.config.mjs` already caps forks at 5 (a run still
  measured 650-950 MB), and a silently queued test reads as a hung sub.

## Not verified by anyone

- Whether in-CLI scheduled tasks, a `/loop`, "allow for this session" grants or a project's
  stdio MCP server state survive a stop and resume. `docs/chat-heads-design.md` line 114 lists
  the same open question for the existing idle freeze.
- Whether the phone is allowed to call `unfreeze_session`.
