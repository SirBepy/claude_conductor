# Chat as a dashboard: design rules

Built and released in v0.2.148 (2026-11-10); later changes refine it. A Conductor chat stops being a scrolling transcript and becomes a
dashboard Claude keeps current. This file is the source of truth for every rule Joe has settled,
each with the reason he gave or the evidence behind it. Sub briefs point here instead of carrying
the rules themselves, because a sub sees nothing but its brief (`src-tauri/src/daemon/subchats/brief.rs`).

**Process rule:** a rule is appended here the moment Joe settles it, not at the next handoff. The
main chat that runs this design only spawns subs, answers their cards and owns this file; design
and mockup work happens inside subs.

Started 2026-11-06 in chat "Dashboard instead of chat" (session 763c45be).

## Why

- Joe reads question cards and the final "done" verdict, never progress updates (memory
  `project_jarvis_end_vision_one_chat_router`, `feedback_message_hierarchy_taste`).
- A transcript gives every message equal weight; in his screenshot two "on_track" cards and the
  tool-count chips took as much space as the answer he wanted.
- Research (2026-11-06, digest `.for_bepy/research/chat-as-dashboard-2026-11-06.md`): no shipped
  agent product fully drops the thread; the open space is "state on top, log underneath".

## Layout

- **Left = what Joe must look at:** Answers, then Waiting on you, blockers and warnings.
  **Right = what stays put:** Plan (Result takes its spot when the job ends). Reason: Joe wants the
  important things on one side and the rest on the other (2026-11-09).
- **Answers and Plan always sit on top;** cards that come and go sit below them. Reason: those two
  are always visible, the rest appear and disappear (2026-11-10).
- **Longer-lived cards sit higher**, so less moves around when something new appears (2026-11-09).
- **Empty zones do not draw.** A quick one-question chat collapses to one answer card plus Joe's
  message.
- **Joe's own messages** sit in a strip under the chat title: the latest as a clamped reminder
  (click to expand), "N earlier" beside it to open the rest. Reason: "we know what we wrote, we
  mostly need a reminder" (2026-11-07).
- **Desktop first.** Phone is not designed yet.

## Answers

- **Only replies to Joe's questions.** A request ("we should support trello") gets no answer card;
  Plan and the Result carry it. Reason: "Answer to you should only answer to answers" (2026-11-09).
- **One spot, latest first.** The newest answer always shows. Reason: "i always wanna see the last
  answer" (2026-11-09).
- **Read by Got it, or by the chat judging his next message** (replaces "read only by an explicit
  check-off", 2026-11-10, see "Read state" below). This is a read mark, not a dismissal: read answers
  stay reachable. (On 2026-11-04 he rejected dismissing answers; the check-off replaced automatic
  shrinking only for the read state.)
- **Got it walks back:** it shows the next newest unread answer, then the next, until none are
  unread (2026-11-09).
- **All read:** once nothing is unread, show that, keep the latest answer visible, and let him pick
  any earlier question from a list (2026-11-09).
- **"N earlier, K unread"** says how many other answers exist, louder while any are unread
  ("especially other answers that havent been read yet", 2026-11-09).
- **Threads on demand:** the thread button on an answer turns it into a mini chat. A settled thread updates that answer and any decision lands in Decided. Reason: gives
  follow-ups a home without a transcript; the flow-back stops a thread's decision being invisible to
  the main chat (rated 8/10 lifts, 2026-11-08).
- **New question:** Joe can start a brand-new question thread at any time; its answer lands in
  Answers (2026-11-09).
- **No separate Ask panel** (replaces "quick side questions can also go to the existing Ask
  panel", 2026-11-06). Joe, 2026-11-10: "we dont need the 'Ask' section anymore if we have this".
  Side questions are a + question or a thread; the Ask panel, its strip and dial entries, its
  `ask_send`/`ask_delete_thread` calls and the sidecar's "hand off to the chat" line are gone. The
  read-only Ask sidecar stays as the engine behind every thread.

### Answers card (approved 2026-11-10, sub "answers-design", 17 board rounds)

Board: preview slug `mockup-answers`; full spec: preview slug `answers-spec`.

- **One card holds everything.** Header: Answers icon plus the word "Answers" (every other card
  has icon and text), then on the right History (clock icon, badge counts the OTHER unread answers)
  and + (new question). Icon buttons only, each names itself on hover.
- **Rests at 210px, text centred.** Check and thread buttons sit bottom left, Read more bottom
  right; all three stay on the bottom edge whatever the text does. Reason: a fixed resting height
  stops the card resizing on every answer; 210 picked on a slider after trying 140-300. A verdict
  caps at 2 lines at rest.
- **Read more is always there.** It, or a click anywhere off the buttons, opens the card: Joe's
  question (rewritten, time first) above, full text below, animated by height plus fade. An open
  card stays open across Got it. The Read more text glows a little while the card is hovered.
- **Got it** is a quiet green check that turns grey once read; the same icon in the same place,
  never a Close button. Reason: a Close button made him forget what it does, and a green fill
  competed with the green verdict. "Rise" animates only the text; header and buttons never move.
  The last Got it fades to **All caught up**: centred, bigger, no last question, the answer card's
  border plus Plan's background, with History and New question.
- **History** is one command-palette list: Mark all N as read, then Unread / Read with a thread /
  Read, newest first; a heading shows only when there are two groups or more. Rows show the
  rewritten question only, and the search covers threads too. Reason: question plus verdict per row
  was "too much text"; a separate unread button was merged into it.
- **Threads open in place,** sliding in from the right, with no scrollbar flash (the card clips while
  it moves). A thread starts with Joe's question and the answer (not counted as a back-and-forth),
  then compact bubbles. No thread summary: the thread button carries the count, plus a blinking dot
  while Claude replies. Hovering the thread header never hides the answer.
- **Questions always show rewritten** as clear questions; Joe's original wording shows only on hover
  over the question inside the thread. An answer whose `send_message` had no `question`
  and whose message is longer than a one-line preview (90 chars) shows a clipped preview first, never
  the whole message; the card then asks the daemon (`answers_rewrite_question`) for one short question
  from a one-shot sonnet call (`ask::sidecar::run_readonly`, subscription only, no Haiku: see the
  quick-reply-chips decision) given his message and the answer. The result is stored once per answer
  in `AnswerState.rewrites` (2026-11-10), only the newest 5 answers are asked for, one at a time, and a
  failed call keeps the preview until a reload. No earlier decision for an AI call existed; this one
  follows from "questions always show rewritten". A + question keeps a thread first, and its reply lands as an
  unread answer. A reply after leaving a thread makes the answer unread again.
- **The main chat never answers a question itself:** it rewrites it and hands it to a sub, keeping
  the original (2026-11-10). Built in lane 5 as rules (1) and (11) of `SUBCHATS_MAIN_PROMPT`
  (`daemon/claude_config/args.rs`). A sub's own `send_message` answer never reaches the main chat's
  window (only a blocker does, `hooks_server/messages/mod.rs`), and the Answers card reads only the
  main chat's own `answer` rows, so the main chat sends the one `answer` itself after the sub
  finishes (its rewritten question in `question`, the sub's verdict and text), and sends an `ack`
  (not shown) in the hand-off turn.
- **Question card icon:** `ph-chat-circle` with `ph-question-mark` stacked inside it; the dotted
  chat bubble moves to Answers (2026-11-10). Built in lane 5: `shared/question-icon.ts` draws it for
  the live card, the read-only card and the transcript card's summary; the Answers header already
  used the dotted bubble.
- **Read state (rethought 2026-11-10, sub "answers-read", board region `answers` of shared
  mockup `dashboard-rework-nov10`).** Problem: Joe read answers but did not click Got it, so they
  stayed unread and he reread them later; and a newer answer did not take the card while he sat on an
  older unread one ("i got a newer answer, but i was still stuck on seeing the old answer").
  - **The newest answer always takes the card**, even over an older unread one, which waits behind
    History's badge. Only an open thread holds it back (Back then shows it). A thread reply that
    lands after he left the thread takes the card the same way.
  - **The chat judges from his next message.** `send_message` takes `read_answers` on any kind: on
    its first message after Joe's, the chat lists the verdicts of earlier `answer`/`rating` messages
    his message reacts to (replies to, acts on, builds on), copied exactly; an answer his message
    ignores stays unread. His idea ("detect if a message has been read based on my message"). It
    rides the turn the chat runs anyway: a few output tokens, no extra model call. Rule text: the
    READ ANSWERS paragraph of `send_message_description` (`mcp/tool_schemas_coordination.rs`);
    validated in `hooks_server/messages/validate.rs` (8 items of 40 chars at most); read by
    `answers-model.ts` (`AnswerItem.seenAt`), which only matches answers sent before his latest
    message (newest first per verdict, case and spacing ignored). Derived from the transcript, so
    nothing new is stored: `isUnread` takes the later of Got it and the judgement, and a thread reply
    after either makes the answer unread again.
  - **The card never moves under him.** A judged-read answer on the card stays; with other answers
    unread its check becomes **Next** (arrow plus "N more"), which shows the newest unread; with
    none unread it is the grey check. Got it stays as the manual shortcut, Mark all read in History.
  - **Card stays full size** when read (fold to the verdict line was shown and turned down).
  - Ruled out: read after a few seconds on screen (dwell) and read on open: "just cuz its been
    opened doesnt mean i read it"; any message he sends marks everything read (skipped answers would
    go read too); no read state at all.
- Ruled out: an earlier-questions list inside the card, a deck of unread, threads under the answer
  or in a drawer, thread summaries, the question shown at rest or in a tooltip, a More button, fixed
  heights of 240/280/320 or growing with content, the slide/crossfade/blur/scale Got it presets.

### Asking about a question card (approved 2026-11-10, sub "question-card-ask")

Board: preview slug `ask-ux-options` (real app shots of the three options).

- **Ask on a question card minimizes the card and opens a thread in Answers.** Joe's idea, option A
  of three. The thread is titled with the question's final ask line, labelled "About a question",
  and opens on the question and its options as the first bubble; the box is focused. Joe's first
  message is his question; the sidecar is told which card it is about (`card_question_context` in
  `daemon/methods/answers.rs`), and the reply lands in Answers like a + question, rewritten question
  and verdict included. The zone draws for the thread even in a chat with no answers yet.
- **Back reopens the card** with any half-typed answer intact; Back from any other thread does not.
  Asking about the same card again returns to its thread. The card's bar stays at the bottom the
  whole time, so it can be answered without leaving the thread.
- **No Ask where there is no Answers card.** Messages view and the phone (which always draws
  Messages) show no Ask button on the card. Joe: "dont worry about phone so much rn, for now just
  fully remove it... later the phone will have the dashboard too".
- Code: `src/views/sessions/question-ask.ts` (the cancelable `cc-question-ask` event; the card
  minimizes only when a dashboard took it), `ChatDashboard.onQuestionAsk` (the dashboard whose pane
  holds the card takes it), `AnswersCard.askAbout`.
- Ruled out: the card staying open beside the thread (two tall cards fight for height and overlap
  on a laptop screen); a small thread inside the question card itself (a second kind of thread that
  Answers and History never see).

## Status, Plan, Result

- **No running Status zone.** Progress lives in Plan and a small status footer at the bottom of the
  Plan card; the status line above the message box goes. Reason: "anything for status should be in
  the plan" (2026-11-09); as progress, Status only repeated Plan's active step.
- **Result appears only when the job ends:** verdict, your move, figures (tables/charts). Reason: it
  is the one card Joe does read (2026-11-09).
- **Result takes the Plan card's spot;** the finished plan steps back behind a "Plan 6/6" button.
  Reason: nothing on the left moves, and it was fully in view at every chat height measured; at the
  bottom of the left column 187px of 300 was cut off in a 640px chat with a waiting question, and
  above Answers pushed Answers ~310px down. Cost: Result sits in the narrower right column (Joe's
  pick, 2026-11-10, sub "result-placement").
- **Subchecks of a batch job** (release gates, todo progress) live inside Plan, not in their own
  card. Reason: "surely we should just show that in the plan section" (2026-11-10). Open: a second
  Plan column for subchecks vs a view that hides the rest of the plan.
- **Clicking a plan step shows what it does,** from write_plan's existing per-step `detail` line
  (2026-11-09).
- **Plans are not answers.** A `plan` message belongs in the Plan zone, never in Answers. The real
  app's "Plan for you" label in the same amber as "Your turn" reads like a to-do for Joe
  (`src/shared/chat/chat-message-card.ts`, `chat-message-cards.css`); Joe's call (2026-11-09): "do
  we even need this? we have the plan on the right".

## Waiting on you and Decided

- **Blockers sit in Waiting on you, tinted red,** above any question (2026-11-09).
- **Questions Claude asks** still use the real question card; Waiting on you lists them.
- **Decided** is this chat's list of settled choices (by Joe or Claude), so neither side reopens
  them. Not long-term memory: anything true beyond the chat goes to Auto Memory. Thread outcomes land
  here (2026-11-09).
- **No always-on Decided card;** Decided is a quick-view button. Reason: Joe expects it to fill
  fast, and this design's log held 67 decisions in 4 days (2026-11-10).
- Open: a Questions section (every question asked, which also catches a card that failed to pop)
  instead of Waiting on you. Joe: "if its a question for me, maybe rather just ask it as a
  question?" (2026-11-10).

## Extra content and quick views (2026-11-10, sub "dashboard-content")

- **New cards, each drawn only when the chat has that content:** a Preview window (it also hosts
  comparison tables: "still part of that previews window"), Links (ticket, PR, CI, sources), and
  figures attached to the approval question.
- **Quick-view buttons: Bigger plan, Decided, Project memory,** in the Links and files section.
  Reason: Joe moved them there "for the time being" (2026-11-10), replacing the spot above the input
  field. No buttons for views the sidebar already has (Todos, Previews, Drafts). v1 only opens the
  existing data; Joe will make them richer later. Project memory = facts for every chat, Decided =
  this chat's choices.
- **Dashboard sections are user-choosable.** A Changes card exists but is off for Joe ("i know i
  wont be caring about them").
- **Live test progress is wanted:** tests report to the app as they run. Joe called it "very
  valuable". Not designed: it needs a test-to-app reporting channel.
- Missing data today: no Links store, no chat-to-plan-doc link, no Memory viewer, no decisions log
  for plain (non-subchat) chats.
- Ruled out: a standing comparison card (folds into the Preview window), separate Gates or
  Todo-progress cards (inside Plan), keeping the Decided card or a "new decisions only" card.

## Subchats card (2026-11-10, sub "subchats-card", 3 rounds)

Board: preview slug `subs-card`; rules sheet: `subs-card-rules`.

- **Avatars only, right column under Plan.** Each avatar carries the state ring (red asks, yellow
  works, green done). It lists working, queued and asking subs; an asking sub's question also stays
  in Waiting on you. Reason: a strip under the title sat above Answers and Plan and broke "those two
  always sit on top"; text rows were more than Joe wanted.
- **Finished subs stay 1 hour, then fold under "+N earlier".** A display rule only: a sub is never
  closed by it (pc-1664). The card does not draw when it has nothing to show.
- **Model battery on each avatar:** fill = model, colour = effort. low `#ece6cf` (off white), medium
  `#b3a67c` (grey with a yellow hint), high grey (the default, 99% of use), xhigh `#f2994a`, max
  `#eb5757`. **Every battery in the app** takes this palette. Reason: compacts the information; the
  colour sits on the battery, not near the ring, so a max-effort working sub never reads as asking.
- **Click an avatar: details open below** with name, run time, the status bar's own context chip,
  state or verdict, brief, one image with "+N" (opens all its images), the latest preview tile
  (`ph-monitor-play`, the app's mockup icon) and a message box. No corner buttons. Joe on the message
  box: "a input field would be super helpful here".
- **A sub's images = every image in its transcript,** shown live while it works, only in the expanded
  details. Needs a daemon scan of the sub's transcript (reuse history_scan).
- **Right-click menu:** Open (full window), Open in new window, Latest preview, Pause, Pin/Unpin
  sidemenu, Stop this turn, Change model or effort, Close (runs /close).
- **Pin to sidemenu replaces Move to sidebar:** it only adds a sidebar shortcut, and the sub stays a
  sub of its main chat. Reason: "if it was spawned as a subchat, its forever a subchat".
- Ruled out: text rows, the card on the left or inside Plan or as a strip under the title, images per
  row or a family-wide Images button, keeping finished subs 2 hours or the newest 3, effort colour on
  a dot or the initials, high as orange, an Open-on-the-right chat panel, Message / Images / Rename /
  Copy brief in the menu, Move to sidebar turning a sub into an ordinary chat, model/effort words and
  message/turn counts in the details.

## Build (started 2026-11-10, overnight, unattended)

Joe's calls on 2026-11-10, before he went to sleep:

- **Ship behind a Settings switch: chat view Dashboard / Messages.** "it could be handy if we could
  toggle it on/off in settings, but if thats too difficult, i am fine with us replacing transcript
  everywhere". Default is Dashboard, so it's what he sees when he wakes up. Once it's approved and
  stable, the old flow is removed, or kept in a form that doesn't weigh the app down, as a view the
  user can swap to.
- **Scope: everything in this file,** including the question rewrite rule and the new question-card
  icon. "All of it".
- **One writer at a time, no worktrees.** "I'm fine with us going slower and, that way, maybe using
  fewer tokens or whatever, and maybe even being more careful." It needs to be usable by 13:00 on
  2026-11-11.
- **Deferred to Joe (2026-11-11), not in this build:** a Questions section (he leans toward no;
  maybe an answered-questions count per sub in the Subchats card) and how Plan shows a batch job's
  subchecks. Until then, Waiting on you stays as designed, and subchecks are ordinary Plan steps.
- **No question cards overnight.** Every build sub decides for itself and writes each judgement call
  in its final result, so Joe can fix it in the morning. "dont bother asking me anything else, just
  keep doing it all to the best of your ability and then tmorrow ill fix anything thats not good".
- **Release when every check is green,** with no stop to show him first: unit tests, typecheck, the
  view harness, code-check, the full wdio sweep, then /release.

Lanes, run in this order, each a sub of the "Chat as dashboard" main chat:

1. `dash-shell`: the Settings switch, the dashboard container and two-column layout, Joe's message
   strip, Plan (with Result taking its spot and the Plan N/N flip-back), Waiting on you, empty zones
   not drawn, and the data model the cards read from the chat's events.
2. `dash-answers`: the Answers card in full (History, threads, + question, Got it, animations), with
   read state stored per the persistence rule.
3. `dash-subchats`: the Subchats card, the daemon sub-image scan, Pin to sidemenu, and effort
   battery colours app-wide.
4. `dash-extras`: Links and files with the three quick-view buttons, and the Preview window card.
5. `dash-behaviour`: the main chat rewrites Joe's questions and hands them to a sub, and the
   question-card icon.
5b. `main-retro`: todo pc-1677. A main chat writes a retro file when it closes, stamped by the
   daemon with the version, so a later Conductor session can review how main chats felt. Joe asked
   for it 2026-11-10 and wants it in before the release.
6. `dash-tests`: audits view, vitest and wdio specs that the dashboard makes stale, rewrites or adds
   them, and runs the whole floor.
7. A gate sub runs code-check, the wdio sweep and /release.

**2026-11-10 change:** lane 2 finished at 06:38 and lane 3 never started. The cause (chat
"Queued subs never start", 3c72edf2, read from the daemon logs): a lane's `cargo test` boots a test
daemon on the shared data dir, and its startup sweep deleted the held queue (`held.json`). The 5
queued rows left behind are dead and still fill the sub cap. Joe's call: lanes 3 to 6 run now, one at
a time, as plain visible chats named "dash lane N: ...", each started by the main chat when the
previous one posts its result to it. /release waits until the fix chat posts "fix committed".

**Lane 6 (tests), 2026-11-10.** The view harness pins Messages, so the existing view specs and the
vitest files keep driving the transcript on purpose; the dashboard has its own specs
(`chat-dashboard*.view.spec.ts`, `tests/chat-dashboard-*.test.mjs`) and one free wdio flow,
`e2e/specs/chat-dashboard.e2e.js` (the fake claude answers a message containing `DASH_ANSWER` with an
`answer` card: strip, Answers card, Got it, History). Left open, each needs a call from Joe:

- **+ question in a chat with no answer yet.** The Answers zone is not drawn when empty, so + is
  unreachable until the first answer lands. Option: a header-only Answers card (title, History, +)
  once Joe has written anything.
- **Zones read only the loaded history page.** An old plan or blocker past the first page is missing
  from the dashboard, because the hidden transcript only loads older pages on scroll. Option: have
  the dashboard ask the paginator for older pages until it finds a plan, or keep a daemon-side
  snapshot.
- **A sub whose hold is gone.** The sub list now has a Queued group, but a never-started sub that
  lost its hold after a restart reads as "working" (the `waiting_for` mark is in memory only,
  `held.rs`). Showing it as lost needs a daemon field on `Instance`.

When this was written the app ran at most 5 subs at once and a queued sub counted (since 2026-11-10 the cap is 10 started subs and a queued or never-started sub holds no slot). So lanes 5b, 6 and 7 are spawned by
the main chat as slots free up, each `after` the one before it. Once the release is out, the main
chat writes its own retro by hand in pc-1677's format to
`%APPDATA%\claude-conductor\main-chat-retros\`, then closes (Joe: "I'd like you to even close when
you're done").

## Gone

- **Tool-count chips** (Read x4, Grep x8): unnecessary; the bottom activity bar is enough for now
  (2026-11-07).
- **Progress messages** in the log ("on_track: running tests"): Joe never reads them.

## Taste

- Tinted cards, small uppercase kind label, medium verdict, little at rest, more one click away.
- No loud badges or pills. A choice is a dropdown, a yes/no a switch, never chip rows.
- Motion slow and readable (Joe judges at 0.5x or slower).

## Artifacts

- Research digest: `.for_bepy/research/chat-as-dashboard-2026-11-06.md`
- Simulation board (autoplays a scripted Trello chat, Play/Pause, speed): `.for_bepy/mockups/mockup-chat-sim.ts`,
  preview slug `mockup-chat-sim`. Earlier rounds: `mockup-chat-dashboard.ts`, `mockup-chat-zones.ts`.
- Answers card board and spec: preview slugs `mockup-answers` and `answers-spec`. Extra content
  board: `dashboard-extra-content`. Full card-by-card record of every pick: the main chat's
  subchats decisions log (D48-D110).
- Mockups use the app's real components (renderMessage cards, renderQuestionUI, composerFieldHtml,
  the Answers card's thread classes) bundled with the /mockup skill's `bundle-board.mjs` and checked with
  `verify-board.cjs` on the panel route.
