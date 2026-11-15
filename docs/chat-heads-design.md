# Chat heads: replacing the sidemenu chat list

Status: design settled with Joe on 2026-11-15 over three question rounds and two boards, stamped "Good". Nothing is built. Source: the `chat-heads-design` preview pushed by the brainstorm sub (transcript `be391afd-6484-4a9a-8996-16bc82494e66`).

Lines marked **(call)** are Claude's calls that Joe saw on the board and did not overrule. Anything the source did not settle is marked **OPEN**.

## Summary

- The left chat list (`.sessions-sidebar`, 260px) goes. Floating chat heads lock to the top-left corner of the chat view, under the header.
- No titles at rest and no status sections.
- The model battery sits bottom-right of a head, like the Subchats card.
- The project name shows on hover (the hover card).
- A main chat shows the project icon where the character portrait sits. A small (plain) chat shows the character portrait plus a little project icon.
- Freezing becomes invisible: the daemon freezes a done chat after 30 minutes idle and skips waiting chats.
- Hide stays.

## Layout

- Floating chat heads lock to the **top-left corner** of the chat view, under the header. Bottom corners were ruled out: the question card and composer span the full width there.
- A toggle head sits in the corner. Clicking it opens or closes the stack, which runs downward. Past the window height the stack wraps into a second column, so no chat is ever hidden for lack of room. **(call)**
- When the stack is closed, the toggle shows the total red count of cards waiting, plus a red ring when anything needs Joe. Closing the stack never hides a question. **(call)**
- **No status sections at all**: no Main chats, Input needed, Done, In progress, Waiting, Scheduled, Remote, Closing or Hidden headings.
- The stack starts open on launch. The open/closed state is per window and kept in memory, not persisted. **(call)**
- Dragging the stack to any spot on screen comes later. For now it is locked to the corner.

## A head

- **Main chat**: the project face sits where the character portrait goes, with no badge. This is unambiguous because a project has one main chat (commit 4774e7a5). If the project has no icon file of its own, the monogram below is the face.
- **Plain (small) chat**: the HotS character portrait plus a small project badge. The badge moves to the **bottom-left**, because the battery needs the bottom-right corner where the badge sits today (`session-avatar.css:106`).
- **Pinned sub**: an initials face, as in the Subchats card.
- **Draft**: a dashed outline head.
- **Ring**: state, using today's `sidebar-ring`, including the plan arc and the question segments.
- **Bottom-right**: the model battery, from `modelBatteryHtml` with the effort tint (same as the Subchats card).
- **Top-right**: one red count of cards waiting, which for a main chat includes its subs that are asking.
- All other marks move to the hover card: scheduled count, held messages, machine, close-wait, sub count and autopilot. Today a row carries up to 10 marks, which is too many for a 40px circle.
- No title shows at rest.

### Monogram

A project with no icon file of its own gets two letters on a colour derived from its path. This replaces the tech-logo fallback for faces, because same-stack projects collided: two Node projects looked identical. A project's own icon still wins.

## Hover card (long-press on the phone)

- Shows the title, project, state with its time, and model and effort, plus the scheduled, held and sub counts when there are any.
- Right-click on a head opens today's chat menu: Hide, Close, Open in new window, and the rest.

## Order and keyboard

- Order is by age, with the newest chat at the far end. Joe can drag to reorder. **Nothing re-sorts on its own.**
- The manual order is owned by the daemon, like `hidden-chats.json`. That way the phone and every window agree, and the order survives a restart. **(call)**
- Ctrl+1..9 opens heads 1 to 9 in that order.
- Holding Ctrl alone for about 0.4s opens the stack and shows the numbers 1 to 9 on the heads. The delay is there so Ctrl+C and Ctrl+V never flash it. **(call)**
- While holding Ctrl, Up and Down move a highlight through every head and loop around (Up from the top goes to the bottom). Releasing Ctrl opens the highlighted chat, and Esc cancels. **(call)**
- Ctrl+Shift+P (the command palette) still finds chats by title, hidden ones included.

## Phone

- The same heads in the same top-left corner as the desktop.
- Tapping a head opens that chat and closes the stack.
- Long-press shows the hover card. Long-press then move drags to reorder.
- A + head at the end of the stack starts a new chat, on both the desktop and the phone. It replaces the phone's list-page + button. **(call)**
- Ruled out on the phone: a header row, a home grid, a titled list.
- Reason for the shared design: the phone has no hover and shares the code.

## Hide, close, freeze

- **Hide**: right-click a head and pick Hide. The chat leaves the stack and stays alive. An eye-slash head with a count at the end of the stack opens the hidden chats in place of the stack, with a back head to return. Messaging a hidden chat or unhiding it brings it back.
- **Close** is the only way a chat leaves for good, to History. Nothing auto-closes or auto-hides a chat.
- **Freeze becomes invisible**:
  - No menu item and no snowflake.
  - The manual "Freeze chat" item goes, and so does its coupling to Hidden.
  - The sub "Pause" control stays.
  - The rate-limit auto-freeze stays as it is today.

### Auto-freeze

The daemon freezes a done chat after **30 minutes** idle. It does so only when all of these hold:

- the chat is interactive, is not Jarvis, and is not mirrored from a peer;
- it is not busy;
- `awaiting` is none or done (not working, waiting or question). Waiting covers a pending ScheduleWakeup, per the test at `registry_turn.rs:363`, and a self-paced /loop;
- it has no `local_task_running`;
- it has no open question, permission or secret card (`has_open_prompt`);
- it has no live or queued subs;
- `held_count` is 0;
- it is not closing.

Under this rule `frozen_needs_continue` stays false, so waking never spends a "continue" turn.

- The scheduler must wake an auto-frozen chat. Today it refuses a manually frozen one (`schedule_fire.rs` test at line 478).
- **Wake on open**: opening a frozen chat respawns it in the background, so it is ready by the time Joe has typed. Wake on send stays as it is.

## Evidence: what waking costs (2026-11-15)

A controlled A/B was run by an independent subagent: Claude Code 2.1.325, Sonnet, on the subscription. In the table, "live" is one process taking 3 turns, and "wake" is a fresh `claude --resume` process for each turn. Figures are tokens.

| Turn | Live read | Live write | Wake read | Wake write |
|---|---:|---:|---:|---:|
| 1 | 16,552 | 25,225 | 16,548 | 26,777 |
| 2 | 31,499 | 12,296 | 31,495 | 11,883 |
| 3 | 41,792 | 2,054 | 43,340 | 89 |

- Billed-equivalent cost was about 88.1k tokens for live and 87.2k for wake. The difference is under 1%, and wake was the cheaper one. Claude's own earlier run agrees: a wake read the cache at 31,501 against 31,504 for the live turn.
- **After 11 minutes idle** (well past the 5-minute TTL), a wake read 43,407 of 43,497 tokens from the cache. Every cache write was `ephemeral_1h`.
- Docs (code.claude.com prompt-caching): the main conversation on a subscription within plan usage gets a 1h TTL, which drops to 5 minutes on usage credits. A resume "reads from the cache whatever part of its prefix is unchanged and still within the cache lifetime". After an hour idle the cache is cold whether the chat is frozen or not.
- **Wake time**: about 5.5s of startup, which is about 3s more than a live turn.
- A second independent subagent read the app's spawn code. The argv is identical between spawn and respawn apart from `--resume` (`spawn.rs:206-249`, `args.rs:223-272`). The SessionStart hook injects nothing on a plain resume. The risk is drift: `--mcp-config` is rebuilt every spawn, and connectors are probed live, with dead ones dropped. If the tool set changes, the cache busts.
- Freezing also skips Claude Code's idle compaction of chats over 200k tokens (it runs at about 54 minutes idle, and only in a live process). The long-idle fresh start in the follow-ups covers those chats.

## Assumption tests to run before building

1. Through the real app: freeze a chat, wake it, and read the first turn's `usage` to confirm the app's own spawn hits the cache.
2. Confirm the tool list stays pinned when the MCP or connector set drifts between spawn and wake. The docs say tool search pins it.
3. Check whether "allow for this session" grants and CronCreate tasks survive a wake. The docs say CronCreate is restored on resume; the grants are unverified.
4. Check that Ctrl+Up and Ctrl+Down are free in the composer textarea.

## The 10 problems found, and how each was settled

| # | Problem | Settled |
|---|---|---|
| 1 | Project icons are not unique (tech-logo fallback) | Monogram |
| 2 | Battery and project badge both want the bottom-right | Badge moves to the bottom-left |
| 3 | Up to 10 marks for a 40px circle | Keep 4 (ring, battery, red count, badge); the rest go to the hover card |
| 4 | No title means a face is forgotten the next day | Hover shows the title; the palette searches by title |
| 5 | Floating heads cover content | Top-left corner plus the toggle; dragging comes later |
| 6 | Re-sorting moves a head under the cursor | Age order plus manual drag only |
| 7 | Ctrl+1..9 needs a visible order | Hold Ctrl for numbers; Ctrl+arrows loop |
| 8 | Bubbles pile up | Close is the only removal; long-idle fresh start is a follow-up |
| 9 | Phone has no hover and shares the code | Same heads, long-press |
| 10 | Auto-freeze safety | The rule above, plus the evidence |

## Follow-ups (not part of the first build)

- **Long-idle fresh start**, Joe's direction: when a chat idle for over a day wakes, write a short summary, start a fresh session from it, and give that session a tool to read the old messages. This needs its own brainstorm, and the heads ship without it. Details: **OPEN**.
- A draggable stack (drop anywhere on screen).

## Ruled out

- A docked bubble rail and a top strip: Joe chose floating heads.
- Bottom corners: they cover the question card.
- A project-only hover card.
- Sorting by state or recency.
- Auto-folding or auto-hiding idle chats.
- A header row, a home grid or a titled list on the phone.
- Freezing at 1 hour: the tokens are the same, and 30 minutes frees memory sooner.

## OPEN

- The "Keep 4" marks in problem 3: the source names the battery, ring, red count and project badge as what stays on a head; confirm that is the intended four when building.
- Exact head size (the source says "40px circle" only for the mark-count problem) and the stack's column wrap spacing.
- The hover card's wording and layout beyond the fields listed above.
- Long-idle fresh start: everything (own brainstorm).
