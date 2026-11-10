# Chat as a dashboard: design rules

Design in progress, not built. A Conductor chat stops being a scrolling transcript and becomes a
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
- **Read only by an explicit check-off ("Got it").** Reason: Claude cannot know he read it
  (2026-11-08). This is a read mark, not a dismissal: read answers stay reachable. (On 2026-11-04 he
  rejected dismissing answers; the check-off replaced automatic shrinking only for the read state.)
- **Got it walks back:** it shows the next newest unread answer, then the next, until none are
  unread (2026-11-09).
- **All read:** once nothing is unread, show that, keep the latest answer visible, and let him pick
  any earlier question from a list (2026-11-09).
- **"N earlier, K unread"** says how many other answers exist, louder while any are unread
  ("especially other answers that havent been read yet", 2026-11-09).
- **Threads on demand:** the thread button on an answer turns it into a mini chat like the Ask
  panel. A settled thread updates that answer and any decision lands in Decided. Reason: gives
  follow-ups a home without a transcript; the flow-back stops a thread's decision being invisible to
  the main chat (rated 8/10 lifts, 2026-11-08).
- **New question:** Joe can start a brand-new question thread at any time; its answer lands in
  Answers (2026-11-09).
- **Quick side questions** can also go to the existing Ask panel (the /btw alternative); that
  rework is for later (2026-11-06).

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
  over the question inside the thread. A + question keeps a thread first, and its reply lands as an
  unread answer. A reply after leaving a thread makes the answer unread again.
- **The main chat never answers a question itself:** it rewrites it and hands it to a sub, keeping
  the original (2026-11-10, its own main-chat job, not built).
- **Question card icon:** `ph-chat-circle` with `ph-question-mark` stacked inside it; the dotted
  chat bubble moves to Answers (2026-11-10, its own job, not built).
- Ruled out: an earlier-questions list inside the card, a deck of unread, threads under the answer
  or in a drawer, thread summaries, the question shown at rest or in a tooltip, a More button, fixed
  heights of 240/280/320 or growing with content, the slide/crossfade/blur/scale Got it presets.

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
- Open: a card showing this chat's active subs (working or asking, finished ones maybe for an hour
  or two), and a way to see the images a sub produced. Joe raised both 2026-11-10; being designed by
  sub "subchats-card".
- Missing data today: no Links store, no chat-to-plan-doc link, no Memory viewer, no decisions log
  for plain (non-subchat) chats.
- Ruled out: a standing comparison card (folds into the Preview window), separate Gates or
  Todo-progress cards (inside Plan), keeping the Decided card or a "new decisions only" card.

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
  Ask panel classes) bundled with the /mockup skill's `bundle-board.mjs` and checked with
  `verify-board.cjs` on the panel route.
