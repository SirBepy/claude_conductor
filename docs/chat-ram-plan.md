# Chat RAM plan

Goal: stop chat processes that are doing nothing, so the `claude.exe` total in Task Manager
drops. Written 2026-11-18 from one measurement session; every figure below was measured that
day on Joe's PC (32 GB RAM) unless marked UNVERIFIED.

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

2. **A finished sub is already stopped.** `commit_finish` sets `subchat_finished` and kills
   the child in the same call (`src-tauri/src/daemon/subchats/finish.rs:475-485`); a follow-up
   respawns it through `resume::continue_sub`. The subs seen alive were unfinished ones, one
   of them waiting on a question card for 10 h.

3. **A question card does not hold a live call.** The `ask_user_question` tool returns at
   once and the turn ends (`src-tauri/src/daemon/hooks_server/question.rs:181-242`). The card
   is durable: kept in `pending-questions.json`, and a child exit does not expire it
   (`src-tauri/src/daemon/state/prompts.rs:198-207`). The answer arrives as an ordinary user
   message. Permission and secret cards are different: the child blocks on them
   (`hooks_server/permission.rs`, `hooks_server/secret.rs`), so those chats must never be
   stopped while the card is open.

## Steps

One sub per step, in order. Steps 1 and 2 can ship in one release.

### Step 1: release the stale-stamp fix

Nothing to write. Installed v0.2.155 refuses to idle-freeze any chat carrying a
`rate_limited_resets_at` stamp, and nothing clears that stamp; the repo only blocks while the
stamp is in the future (`src-tauri/src/daemon/subchats/idle_freeze.rs:86`). UNVERIFIED that
this is what kept the 4 finished chats alive (the stamp is in memory only), so step 5 checks.

### Step 2: idle stop after 15 minutes

- `IDLE_FREEZE_AFTER` in `idle_freeze.rs` from 30 to 15 minutes. The log line and the module
  doc say "30 minutes": derive the text from the constant.
- Update "Freeze becomes invisible" in `docs/chat-heads-design.md`.
- Why 15 is cheap: that doc measured a wake at about 5.5 s, and a wake after 11 idle minutes
  read 43,407 of 43,497 prompt tokens from cache (lines 104-106).

### Step 3: stop a chat that waits on a question card

The largest idle group. Scope: a plain chat (not a sub, not Jarvis) whose only open cards are
durable question cards. Same 15-minute timer.

Daemon:

- `blocker()` accepts `awaiting == "question"`. Every other awaiting value still blocks.
- `Facts.open_prompt` becomes "a card that holds a live call is open": true for permission and
  secret cards, false for durable question cards. Add the check next to
  `lifecycle::has_open_prompt` and correct that function's doc comment, which says the child is
  parked on the answer.
- The freeze must leave the card and `awaiting = "question"` as they are.
- `live_subs` keeps blocking: a parent with a live sub is step 4.

Answer path (read first, then fix what does not wake):

- The desktop sends the answer through the `send_message` RPC, which returns NotFound when
  there is no child (`daemon/methods/lifecycle/core.rs:62`), then retries with `start_session`,
  which refuses a frozen row (`lifecycle/spawn.rs:128`). So an answer to a frozen chat only
  works if something clears the freeze first. Preferred fix, one place for every surface: in
  `send_message`, a row that `idle_freeze::is_idle_freeze` goes through
  `send_message_with_respawn`, which already wakes (`spawn.rs:400`).
- Check each surface that can answer a card: the chat's own card, the dashboard Answers card,
  the phone (its REST route already uses `send_message_with_respawn`), a paired machine.
- `settle_answered_questions` runs before the respawn (`core.rs:98`). If the respawn fails the
  card is gone and the answer with it: settle only after the send succeeds, or restore the
  card on failure.

Front end:

- An idle-frozen chat shows nothing on its chat head today. One with an open card must keep
  its question state (ring, head, sidebar, dashboard), on desktop and phone.

Tests, each red without the change:

- `blocker`: question allowed; permission, secret, waiting and working still block.
- Freeze of a question-waiting chat keeps the card and `awaiting`.
- An answer sent to that frozen chat respawns it and delivers the text; a failed respawn
  keeps the card.
- View spec: frozen chat with a card still shows the question state.
- One live run with a real claude (`scripts/live-verify.ps1`): ask, wait out a shortened
  timer, answer, confirm the model continues from the answer.

### Step 4: subs that wait, and parents of subs (decide after step 5)

Not sized. A reader of the subchats code called an unfinished waiting sub "days": it holds the
writer slot, wake and held-message state, and the stall, stuck and nudge paths assume a child.
Two cases, to design only if step 5 shows they still matter:

- A sub waiting on a question card.
- A parent blocked from freezing only because it has a live sub. Needs proof that a sub's
  finish wakes a frozen parent.

### Step 5: measure again

After the release with steps 1-3 has run for a day, repeat the measurement (per-process
private bytes, working set, idle minutes from the transcript's last write, `awaiting` from
`interactive-sessions.json`).

Pass: no plain chat that is done, or waiting on a question card, has a process after 20 idle
minutes. Then decide step 4 from what is left.

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
