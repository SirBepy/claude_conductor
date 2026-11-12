# Forever chat plan: one main chat per project that never has to close

Written 2026-11-12 from two research passes (14 read-only agents) over the code, `daemon.log`,
the subchats data folder, 18 main-chat transcripts, 157 sub transcripts, the four main-chat retros
and the CLI's own docs. Todo `pc-1682` holds the first gap list (2026-11-11); this file is the plan
built on it. Sub briefs point here instead of carrying the reasoning.

Joe's goal, 2026-11-11: "the main thing i wanna work on is the forever chat... for now... the thing
that we are aiming for is that theres only ever one chat for one project... and he spawns subchats".
Later: one chat for all projects.

Joe's settled rules still hold unless a section below says it proposes changing one, and those
proposals go to Joe on a card before anything is built: `docs/chat-dashboard-design.md` (dashboard
rules), the hard constraints in `pc-1597` (he never has to leave the main chat to reply, no
over-spawning, finished means idle and hidden, a sub is always a sub).

## 1. What the research found

### 1.1 The CLI can keep one chat alive in place

Read from the CLI docs (`code.claude.com/docs/en/model-config.md`, `agent-sdk/slash-commands.md`,
`hooks.md`, `prompt-caching.md`) and `claude --help` on 2.1.322:

- Sending `/compact [focus text]` as an ordinary stream-json user message compacts the session in
  place: same session id, a `compact_boundary` system event with `pre_tokens`. Not tried in this
  daemon yet (spike S1).
- Auto-compaction runs at about 967K on the 1M models the daemon uses (`opus`, `sonnet`, `fable`
  aliases). Nothing in the daemon sets any compaction control (grep of `src-tauri/src/daemon`), and
  none of the 673 transcripts in this project ever compacted.
- After a compaction the CLI reloads CLAUDE.md, Auto Memory and skill descriptions from disk, and a
  `SessionStart` hook with matcher `compact` can add context.
- The system prompt (`--append-system-prompt`, which carries `SUBCHATS_MAIN_PROMPT`) is
  snapshotted on the first request and reused on every resume until the conversation compacts. So
  today a prompt-rule change never reaches an old chat; a compaction is also how it would.
- No headless "resume at an earlier message" exists (only interactive `/rewind`). Prompt cache TTL
  is 1 hour on the subscription. `cleanupPeriodDays` is already 36500 in both account settings, so
  old transcripts are not swept.

Consequence: the earlier idea of an invisible swap to a fresh chat (moving about 20 stores keyed by
session id) is not needed. A main chat keeps its id forever and is compacted on purpose.

### 1.2 What fills a main chat

Four largest main chats (463K to 583K), measured from usage, categories estimated at chars/4:

- About 30% is the main chat's own output (thinking 6-8%).
- Work it did itself: 87007063 made 106 Bash, 22 Edit and 11 Agent calls; tool results from Bash
  and Read alone were about 13%.
- 169 of 244 turns in 87007063 were opened by daemon wakes, card answers and queued subagent
  messages, not by Joe (4 typed messages).
- CLAUDE.md re-sent whenever it changes on disk: up to 48.7K chars per re-send, 31.6K tokens in one
  chat. This repo's CLAUDE.md is 42K chars and changes several times a day.
- Per-turn riders: `[your-todos]` reached 35.6K tokens (7.7%) in 22ff80ce because the whole list is
  re-sent every turn.
- Skill bodies (`/commit` alone 59K chars) read into the main chat.
- Joe's own typing: under 1%.

### 1.3 Cost and waiting

Weighted with API-price ratios (input 1.0, cache write 1.25, cache read 0.1, output 5.0), 18 mains
and 157 subs:

- Subs are 87% of spend. Opus subs are 35 of 146 job subs and 43% of job-sub spend.
- A sub starts at about 56K tokens, the same as a fresh chat.
- Question subs (rule 11 of `SUBCHATS_MAIN_PROMPT`): median wait from Joe's message to the answer
  6 minutes (p90 67 minutes); only 3 of 13 under 3 minutes. Median cost 334K weighted against about
  15K for one inline turn: about 22 times.
- 37 subs ended a turn without finishing and needed the Stop-hook nudge. 58 subs show at least one
  waste signal (re-reading files, the nudge, a writer with no commit) and account for 53% of sub
  spend.
- One account reached 100% of its weekly limit on 2026-11-07.

### 1.4 Why the app restarts and why stall cards follow

All 21 daemon starts (2026-11-06 to 11-11) were external kills; the daemon never logged its own
shutdown.

- 10 were `scripts/wdio-sweep.ps1` killing Joe's live daemon on 2026-11-07. `e2e/wdio.conf.js:240`
  runs the driver-version preflight before `:246` sets `CC_DAEMON_INSTANCE` and `:248` snapshots the
  pre-existing daemon pids; the preflight threw, `onComplete` (`:300-312`) then killed every daemon
  not in the empty snapshot. Latent since 1512deea (2026-09-25).
- 7 were PC boots (Joe shuts the PC down nightly), 4 were app updates.
- Stall cards after a start: `subchats/stuck.rs` `sweep_dead` cards any childless unfinished sub
  after a 45s grace, with no check that its last turn had ended. An idle sub is carded 2 minutes
  after every boot. A sub killed by an OS shutdown is worse: `pump/exit.rs:36-41` clears busy, so
  `resume_interrupted` skips it, and it is carded twice (at the death and again after boot). Subs
  whose conversation file is missing (`No conversation found`) are carded after every start.

### 1.5 State and durability

About 24 on-disk stores and 20 in-memory maps hold main-chat and sub state. Losses on a daemon kill,
worst first: `report_back` wake notices (memory only, so the main chat is never told), the window
between writing `<sub>.finish.json` and the registry snapshot that records `subchat_finished`, the
writer-slot holder, the watchdog clocks. Answers store, previews and pinned state are not moved on
respawn; the Ask stores are deleted on close (`ask/store.rs:72-76`). Keeping one main chat id
forever makes the respawn gaps irrelevant.

### 1.6 Briefs and finishes

16 subs audited against Joe's words and git: 0 briefs lost anything material (the main chat quotes
Joe word for word), 3 finishes overstated (a "good" verdict on work with an honest "not checked on a
device" row), 0 wrong. Defects Joe hit afterwards were found by use, not by the sub's tests. Finish
records keep pre-rebase commit SHAs for worktree subs.

### 1.7 What the screen shows

Rendered with the app's own components (16 subs, `.for_bepy/screenshots/46644-134389221111967542/`):

- The main chat reads "Idle since 02:55" while four subs work.
- Working, queued, paused and rate-limited subs all draw the same yellow ring; avatars are two
  initials; the hover is a native `title` tooltip.
- A finished job's result (commits, tests, merged, pushed, not done) is not on the dashboard; only
  a sub finish that answers a question reaches the Answers card.
- The sidebar hover is the only place that says why a queued sub waits.

### 1.8 Safety and load

- "Only a gate sub may push" is a prompt rule only; no daemon check refuses `git push` from a sub.
  Subs inherit auto-accept (`session_registration.rs:84-86`, default on), including subs started in
  another project.
- `subchat log` returns the decisions log, which holds sub-written rows, with no "this is data"
  framing (`subchats/tool.rs:277-289`).
- `hooks_server/stop.rs:226-233` parses the whole transcript into a `Vec<Value>` on every Stop, and
  `context_cap.rs` streams the whole transcript on every turn for every chat. Fine at 35MB (about
  50ms), linear in a chat's age.
- RAM: about 330MB per chat including its MCP child; a main chat with 10 subs is about 4GB of
  31.7GB.

## 2. Decisions

| Decision | Call | Why |
|---|---|---|
| Keep a chat alive by swapping it for a fresh one, or by compacting it in place | Compact in place | The CLI does it natively; the id never changes, so nothing has to move |
| One writer per project by default | Already changed by Joe, 2026-11-12: every writing sub gets a worktree | In the working tree now (peer chat "always-worktrees") |
| Main chat on Opus high | Keep | Mains are 13% of spend; the cost is in subs |
| Never close finished subs | Keep, fix the symptoms | Name collisions and list order are bugs, not a reason to close |
| Rule 11: the main chat never answers a question itself | Ask Joe (proposal in 4.1) | 22 times the cost and a 6-minute median wait; Joe's own rule |
| Move the module maps out of CLAUDE.md | Ask Joe (proposal in 4.2) | Every chat and every sub pays for 42K chars, and re-pays on every edit |
| No Status zone, avatars-only Subchats card | Keep the rules, show more on demand and in the ring | 19 status questions in a week; design goes through a board |

## 3. Build plan

Each chunk is one sub unless noted. Writing subs get a worktree (default now). Rust chunks run at
most three at a time, because each worktree builds its own cargo target. Every chunk ships a test
that fails without it.

### Phase A: trust (bugs with evidence, no design needed)

- **A1. wdio sweep never kills the live daemon.** In `e2e/wdio.conf.js`, set `CC_DAEMON_INSTANCE`
  and take the pid snapshot before the preflight; `onComplete` kills nothing when the snapshot env
  is unset. Extract the pid filter into a pure function with a unit test (unset env returns none).
- **A2. A restart draws no stall card.** `stuck.rs` `sweep_dead` skips a childless sub whose last
  turn ended (persisted chat state not busy) and any sub queued in `resume_interrupted`'s list.
  `pump/exit.rs`: an exit with 0xC000013A (console closed by OS shutdown) or during daemon shutdown
  keeps busy so the next boot resumes it, and raises no death card. A sub with no conversation file
  is carded once and then marked dead (check `announced.rs` from 20fbde93 first). Tests next to
  `a_sub_with_no_process_that_never_finished_gets_a_card_after_the_grace`.
- **A3. Nothing the main chat must hear is lost on a kill.** Persist `report_back` wake notices
  (`repo_channel_wake.rs`, `subchats/wake.rs`) and drain them at boot; save the registry snapshot
  inside `commit_finish` right after `<sub>.finish.json` is written; persist the writer-slot holder
  or rebuild it from live children at boot.
- **A4. Names and lists stay right as subs pile up.** `subchats/tool.rs` `resolve` prefers live
  subs over ended ones, then the newest; `list` returns working, asking and queued subs first, then
  the newest finished, instead of the newest 20 by start time. `subchat send` with `text` sends only
  that text (rule 4 already says a forwarded message names only the target).
- **A5. Subs cannot push.** A daemon-side permission rule refuses `git push` (and `gh pr merge`)
  from any sub that is not a gate, auto-accept or not. Frame `subchat log` output as data, as
  `back.rs` does.
- **A6. Per-turn costs that grow with age or repeat for nothing.** The `[your-todos]` and
  `[scheduled]` riders are sent only when their content changed since this chat last got them.
  `context_cap.rs` and `stop.rs`'s skill-usage parse read only the bytes appended since the last
  turn (cache the offset per session).

### Phase B: the forever chat core

- **S1. Spike (read the results before B1).** In an isolated daemon (`CC_DATA_DIR` and
  `CC_DAEMON_INSTANCE`, never the live data folder), drive one real chat to about 60K tokens, send
  `/compact keep the subs and decisions` over stdin, and record: the events the pump sees, the
  transcript lines written, context before and after, whether `SUBCHATS_MAIN_PROMPT` survives,
  whether a `SessionStart` `compact` hook from the daemon's settings fires and what it can inject,
  and the time and tokens the compaction costs. Billed, small.
- **B1. Compaction manager.** The daemon watches each main chat's context from usage events. Past a
  threshold (start at 250K, a setting), at the end of a turn while the cache is warm and no card is
  waiting, it sends `/compact` with focus text it builds itself (open jobs, running subs, open
  questions, recent decisions). After the `compact_boundary` it injects the family state through the
  `SessionStart` `compact` hook. The chat window shows one quiet row ("Compacted 312K to 41K"), and
  the chat menu gets "Compact now" (rare action, so menu, never a button).
- **B2. History that keeps growing.** Confirm the window pages old history instead of bulk-loading
  every event (bulk-load cost follows event count: 712 events about 1.2s), and that the dashboard's
  durable cards (Answers, Subchats, Plan) do not depend on the loaded page
  (`docs/chat-dashboard-design.md:433` lists this as open).
- **B3. The decisions log stays small forever.** `pc-1663`'s two scopes: Joe's card answers stay
  chat-wide, a sub's own decided and ruled-out rows stay with that sub unless it marks one as a
  project rule; the daemon folds old entries out of the injected view; the checkup stops reporting
  bloat.

### Phase C: see what the subs are doing (needs Joe's taste)

One design sub (Opus high) builds ONE interactive board with the app's real classes, covering all of
C1 to C5, and ends on a final-stamp card for Joe. Builders start only after his pick.

- **C1. Honest states.** The ring or avatar tells working, queued, paused, rate limited and idle
  (turn ended, not finished) apart; a real hover card replaces the native `title`; the main chat's
  own status line counts its working subs instead of "Idle since".
- **C2. A job's result on the dashboard.** Where a finished job's verdict, commits, tests, merged and
  pushed state and not-done rows show without switching to Messages view.
- **C3. "Where we are" on demand.** A quick-view button beside Bigger plan / Decided / Project
  memory: one line per sub (state, step text, time running, last activity) and the family's
  uncommitted, unmerged and unpushed counts, built by code with no model call.
- **C4. Queued subs.** Place in line, the reason, and Start now / Drop in the sub's menu.
- **C5. The sub's name on every card it draws,** also when it is the only asker.

### Phase D: one main chat per project

- **D1. A project knows its main chat.** A pointer in the project's config; starting a chat in a
  project that has a live main chat opens that chat, with a plain-chat option kept in the new-chat
  flow. The sidebar's Main chats group shows one row per project. Closing the main chat clears the
  pointer. A board first (taste), then the build.

### Phase E: later

Topics inside one main chat (grouping subs by the job they belong to), the router question in
`pc-1682`, and one chat for all projects (`pc-1682` section D). Not planned in detail until A to D
have run for a while.

### Review changes (2026-11-12)

A hostile read-only review of this plan found these, and the plan changes accordingly:

- **Compaction must not corrupt the window or the dashboard.** No code handles `compact_boundary`,
  `isCompactSummary` or `pre_tokens` (grep of `src-tauri/src`), so the CLI's continuation summary
  could render as a giant message from Joe and skew `dashboard-model.ts` (job leads and `joeAt`
  read Joe's messages). B1 includes parser and dashboard handling for the summary and the `/compact`
  lines.
- **The daemon's `/compact` is not Joe's message.** `subchats/joe_message.rs` `note_sent` would
  treat it as typed text and it could consume `back.rs`'s line-back queue. B1 sends it on a path
  that consumes nothing, with a test.
- **Verbatim words survive.** Briefs stay faithful because the main chat quotes Joe word for word
  (1.6); a summary loses that. The focus text keeps Joe's recent messages verbatim, and S1 checks it.
- **The existing SessionStart hook.** `hooks/installer.rs` already installs a matcher-less
  SessionStart hook; `hooks_server/lifecycle.rs` registers its session as External. A compaction
  firing it must not clobber the Interactive row (kind, name, `subchat_of`). S1 checks it.
- **Messages and wakes during a compaction** (Joe typing, a sub finishing) must be queued, never
  lost or doubled, and the busy flag must clear. S1 and B1 test it.
- **Default threshold is Joe's call.** `hooks_server/context_cap.rs:1-6` records his 2026-10-14
  rule that a context cap is opt-in. B1 ships with compaction off by default (CLI default about
  967K stays) and a per-chat or per-project threshold; turning it on by default goes to Joe with S1's
  numbers.
- **B2 is a build, not a check,** and runs before C2 and D1: the dashboard reads only the loaded
  history page (`docs/chat-dashboard-design.md`, open item), so after a compaction older cards drop
  out.
- **A mis-click close is costly in a forever chat:** `closing.rs` deletes the Ask stores
  (`src-tauri/src/ask/store.rs:72-77`) and ends finished subs. D adds a confirm on closing a
  project's main chat.
- **The prompt snapshot** means a rule change reaches an old main chat only at its next compaction;
  "Compact now" doubles as the way to roll a rule out.
- **A6's offset cache** also persists the maximum occupancy seen, since `context_status.rs` infers
  the 1M window from it.
- **A4 drops the `subchat send` text-only change:** `tool.rs` copies Joe's message on purpose so the
  main chat can never paraphrase him. The misrouted message is a main-chat prompt problem; left open.
- **A2:** all 21 restarts were external kills, so `pump/exit.rs` does not run for most; the real fix
  is `sweep_dead` plus the boot-time resume. The exit-code branch is optional.
- **Corrections:** an inline answer costs about a twentieth of a question sub, not a fifth; the
  auto-accept file is `daemon/session_registration.rs`, and the setting
  `spawned_chats_inherit_auto_accept` already offers an off switch.

## 4. Proposals for Joe

### 4.1 Rule 11, answering questions

Today every question becomes a sub. Proposal: the main chat answers inline when the answer comes
from what it already has (sub status, git state, the decisions log, the plan) or from at most three
small reads, and still hands off anything needing an investigation, a build or a test run. An
inline answer is a `send_message` of kind `answer`, so it still lands in the Answers card. Expected:
"where are we" answered in seconds, at about a twentieth of the cost per question. Strongest
argument against: inline reads put tool output into the main chat, which is what fills it (1.2), so
the cap on reads matters.

### 4.2 CLAUDE.md size

The project CLAUDE.md is 42K chars, loaded by every chat and every sub (about 10K tokens each) and
re-sent to every live chat on every edit. Proposal: keep rules and commands in CLAUDE.md, move the
module maps (subchats, multi-machine, browser, dashboard) to `docs/architecture/*.md` with a
one-line pointer each. Strongest argument against: the maps stop subs re-reading files to find their
way (re-reading is one of the waste signals in 1.3), so a sub working in that area must still read
its map; split by who needs it rather than dropping the maps.
