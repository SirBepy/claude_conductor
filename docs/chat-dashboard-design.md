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

- **Left = what Joe must look at:** Waiting on you, blockers and warnings, Answers, Result.
  **Right = what stays put:** Plan, Decided. Reason: Joe wants the important things on one side
  and the rest on the other (2026-11-09).
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
- **Threads on demand:** Reply on an answer turns it into a mini chat like the Ask panel. A settled
  thread updates that answer ("updated in thread") and any decision lands in Decided. Reason: gives
  follow-ups a home without a transcript; the flow-back stops a thread's decision being invisible to
  the main chat (rated 8/10 lifts, 2026-11-08).
- **New question:** Joe can start a brand-new question thread at any time; its answer lands in
  Answers (2026-11-09).
- **Quick side questions** can also go to the existing Ask panel (the /btw alternative); that
  rework is for later (2026-11-06).
- Open: where threads open (in place vs side drawer), what a card shows at rest vs on click,
  10+ answers. Being designed by sub "answers-design".

## Status, Plan, Result

- **No running Status zone.** Progress lives in Plan and a small status footer at the bottom of the
  Plan card; the status line above the message box goes. Reason: "anything for status should be in
  the plan" (2026-11-09); as progress, Status only repeated Plan's active step.
- **Result appears only when the job ends:** verdict, your move, figures (tables/charts). Reason: it
  is the one card Joe does read (2026-11-09).
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
- Mockups use the app's real components (renderMessage cards, renderQuestionUI, composerFieldHtml,
  Ask panel classes) bundled with the /mockup skill's `bundle-board.mjs` and checked with
  `verify-board.cjs` on the panel route.
