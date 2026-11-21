# Phone dashboard: decided design (2026-11-21)

Joe picked this over three rounds of mockups in the chat "Mobile view improvements". The board
source lives here so a later chat can re-open it instead of redrawing. Todos: pc-1816 to pc-1821
(build, in order), pc-1822 (desktop mini chat, later), pc-1823 (phone chat prefetch, separate).

## What the phone gets

The phone draws the main-chat dashboard (today `dashboardEnabled()` in
`src/views/sessions/chat-dashboard/chat-view-pref.ts` returns false when `isRemote()`), laid out
as **three swipe columns, `scroll-snap-type: x mandatory`**, each a full-width page:

1. **Chat** (left): the real Messages view with the composer.
2. **Needs you** (middle, the page the chat opens on): Answers, Result, Waiting, Subchats.
3. **Progress** (right): Plan, Done, Attachments.

A tab strip (44px tall tabs, an underline following the scroll) names all three. Joe on the
Chat column: "we would rarely ever even use the chat view".

Rejected by Joe: one scrolling column (overwhelming), collapsible stack (B was better).

## Header: variant H3 (ring and tab counts)

One 57px row, 44px targets. Name plus the top-right menu only. No Messages/Dashboard switch,
and no account, usage or model chip in the header. The status ring sits on the chat head
(real ring markup), and the counts sit on the Needs you and Progress tabs. The menu holds model
and effort, account and usage, pin and history, and the rare actions.

Joe rejected: the switch ("a little bit busy"), any account/usage chip. Still open in his words:
"2 waiting, 1 working" as a text line under the name was liked but H3 won. Variants H1 (text
line) and H2 (dot chips) are in the board source if he wants them back.

## Latest-message card (the strip right under the header)

Redone because Joe objected to: a "from you" label, the time, and a "previous messages" button
with a count. New rules: no sender label, no time at rest, tap the text to expand to the time and
the full message (animated height), history is an icon only with no count, and the card fits on
one or two lines.

- **V4 (default, my pick):** two-line clamp, 74px, history icon (30px) in the top-right corner.
- **V1:** one line, 52px, history icon (34px) trailing.
- Joe could not choose between V1 and V4, so both ship and a Settings switch flips them.
- V2 (two-line clamp with trailing icon) and V3 (pill) were shown and not picked.

## Head stack: treatment B

The chat head stack collapses to the active head only. Tapping the head fans the other heads
over the page with a staggered fade; cards keep full width (348px of 390 in the board). The
header's name starts at 68px, right of the head's gutter. Treatment A (stack open, page padded
60px) was rejected.

## Files in this folder

- `mockup-phone-dashboard.ts` / `.src.html` / `-shim.ts`: the round 2 board. It imports the real
  `deriveDashboard`, zone renderers, AnswersCard, SubsCard, Done card, SessionHeader and the real
  CSS, over a fixture `ChatRenderer` transcript. Read it for the real class names, the three-page
  scroll-snap markup, the tab indicator, the header, the card variants and the head stack.
- `mockup-phone-dashboard-bundle.mjs`: wraps the mockup skill's `bundle-board.mjs`, stubbing
  shiki, CodeMirror/lezer and the changelog PNGs (without it the bundle is 13.5MB against the
  preview panel's 2MB cap; the pushed board was 1,944,212 bytes).
- `mockup-phone-dashboard-trim.mjs` and the `-phosphor*` files: the trimmed Phosphor font.
- `shots/`: round 2 screenshots (`r2-*`) and the round 1 load shot.

These were authored in a scratch `.for_bepy/mockups/` folder and copied here; they are design
reference, not shipped code. Do not import them from `src/`.

## Constraints the board surfaced

- The zone CSS uses width media queries (the dashboard grid at 720px, the header at 768px). On
  the phone those rules already apply; the board forced them on for a 390px stage inside a wide
  panel.
- The real chat head stack (`.chat-heads`, 44px heads at left 8px) overlays the left 52px of the
  content, and only the header, status bar and project header are padded 68px. Treatment B is
  how the page coexists with it.
- Answers, quick views and sub peeks call daemon RPCs that are desktop-pipe only today (absent
  from `TRANSPORT_TABLE` in `daemon/remote_transport_table.rs`). Phone columns need rows there
  (pc-1816).
- `docs/architecture/chat-dashboard.md` says the phone always draws Messages and
  `DESKTOP_ONLY_KEBAB` in `tests/notifier-event-registration-contract.test.mjs` says the phone
  ignores `test_progress`. Both change when this ships (pc-1821).
- Touch swipe was driven only through the tab clicks and scroll events in the board; a real
  finger swipe still needs a device check.
