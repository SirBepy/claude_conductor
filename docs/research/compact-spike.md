# Spike S1: does `/compact` over stream-json work in the daemon?

Date: 2026-11-12. Plan reference: `docs/forever-chat-plan.md` section 1.1, phase S1 and "Review changes".
No app code was changed. Everything below was measured on a real chat, except the items marked
"read from code".

**Verdict: yes, it works.** Sending `/compact <focus>` as a stream-json user message through the
daemon's ordinary send path compacts the session in place (same session id, same child process,
no respawn). The pieces that do not work yet are all on our side: the sentinel path breaks the
command, the history parser and classifier render the continuation summary as a message from Joe,
`context_status` is stale until the next assistant line, and a one-shot schedule wake that lands
mid-compaction is lost.

## 0. Setup

- Binary: `cc-conductor-daemon` debug build of this branch (`cargo build --bin cc-conductor-daemon`,
  private `CARGO_TARGET_DIR` under the scratch folder).
- Isolation: `CC_DATA_DIR=<scratch>\data`, `CC_DAEMON_INSTANCE=compactspike`,
  `CC_REMOTE_PORT=33290`, `CC_DAEMON_NO_AUTOSTART=1`, `RUST_LOG=...,claude_conductor_lib::daemon::pump=trace`
  (the pump's trace line is the raw stdout of the child, cut at 2000 chars). Hook server port was
  the instance's ephemeral one (`hooks_port-compactspike.txt`), never 27182/27183.
- Driven over the daemon's remote server: `POST /api/rpc` (`start_session`, `set_subchats_on`,
  `schedule_create`, `schedule_fire_now`, `add_held_message`, `context_status`),
  `POST /api/sessions/:id/send`, `GET /api/sessions`, and the per-session and global stream
  WebSockets for the parsed `ChatEvent`s.
- Chat: sonnet, effort low, account `personal` (real login, Joe approved it on the question card),
  cwd = a scratch git repo with four 450-line filler files. Subchats mode was switched on for a
  pre-minted session id BEFORE `start_session(new_session_id=...)`, so `SUBCHATS_MAIN_PROMPT` is in
  the child's argv from the start.
- Growth: one turn that read `alpha.js` and `beta.js`, then two distinctive Joe messages, then two
  recall probes. Occupancy before the compaction: **85,832** (`context_status`), CLI `pre_tokens`
  85,837. The baseline (system prompt, tools, CLAUDE.md, skills) is about 35K to 40K of that (42K on the first
  request, 35K by subtraction after the compaction, see section 4), so the
  chat was somewhat above the 60K target; the first turn alone was 83K because of the two Reads.
- Joe's two distinctive messages (typed through the send path):
  1. `Actually hold the thought: when we revisit this, call the checkout flag 'zebra-lantern-92' and do NOT rename it, even if it looks ugly.`
  2. `Also an open job for you to remember: ping me about the 'quokka-migration' before touching delta.js again, no exceptions, and keep the word 'plinth' out of every commit message.`
- Compaction command sent: `/compact keep the open jobs, decisions and Joe's last two messages word for word`.

**Deviation to know about (Joe approved it):** the `personal` account's `settings.json` carries the
global `SessionStart`/`SessionEnd`/`Stop` hooks with the LIVE hook port 27182 baked in, so the
scratch chat also POSTed those hooks to the live daemon (the Stop hook ran each turn, 141 ms, so the
live daemon answered). Expected residue in the LIVE app: a project `compact-spike` pointing at
`C:\Users\tecno\cargo-scratch\compact-spike\repo` (folder now deleted) and possibly a ghost External
row for session `d743b5e4-e212-4515-b90c-90ebfa74a2be` until its dead sweep (the child was killed, so
no `SessionEnd` was sent). Nothing else touched the live daemon or `%APPDATA%\claude-conductor`.

## 1. Answers, yes/no

| Q | Question | Answer |
|---|---|---|
| a1 | Does the pump receive a `compact_boundary` system event with `pre_tokens`? | **Yes** (also `post_tokens`, `duration_ms`, `trigger`) |
| a2 | Does a `result` line arrive? | **Yes**, `subtype:"success"`, `num_turns:0`, `result:""`, `usage` all zeros |
| a3 | Does `busy` clear? | **Yes**, at the result line (`turn end ... action=TurnEnded`), on a freshly started child. UNVERIFIED for a `--resume` child (section 2) |
| a4 | Does `awaiting` become `done`? | **No**, it stays null (no Stop hook, no `report_turn_status` runs) |
| b1 | Does the app's history parser drop the boundary and swallow the summary? | Boundary: **dropped** (no `ChatEvent`). Summary: **no, it is a `user_message`** |
| b2 | Does the continuation summary look like a message from Joe? | **Yes** on the history path (a 6,487 char Joe bubble, `is_meta:false`; classifier run on the real line, no window rendered); the live window drops it (section 3) |
| b3 | Does the `/compact` command line render? | **Yes**, as a Joe bubble `/compact keep the open ...` |
| c1 | Context smaller afterwards? | **Yes**: 85,837 to 9,860 (conversation only); next real request 45,093; next turn 51,356 |
| c2 | Does `context_status` follow at once? | **No**, it still said 85,832 until the next assistant line |
| d1 | `TURN_STATUS_PROMPT` still in effect? | **Yes** |
| d2 | `SUBCHATS_MAIN_PROMPT` still in effect? | **Yes** |
| e1 | Both of Joe's distinctive messages word for word in the summary? | **Yes** (twice each) |
| e2 | Did "Joe's last two messages" mean what Joe means? | **No**, the `/compact` command counted as the last message |
| f1 | Does a `SessionStart` hook fire on the compaction? | **Yes**, hook name `SessionStart:compact`, two hooks ran |
| f2 | Does the daemon's handler keep the row Interactive, name, subchats state? | **Kind and subchats state: yes** (`register()` returns early, `subchats_on` kept). Name and pid enrichment: **UNVERIFIED** (synthetic payload, section 8) |
| f3 | Can a `SessionStart` hook's `additionalContext` reach the chat after a compaction? | **Yes** (measured with the user's own hook; the daemon's endpoint returns 204 today) |
| g1 | Normal message typed mid-compaction: queued by the daemon? | **No**, refused: HTTP 409 `SESSION_BUSY`, nothing written |
| g2 | Held message (draft store) mid-compaction: lost or doubled? | **No**, delivered once, in the next turn |
| g3 | Scheduled one-shot wake mid-compaction: delivered? | **No, lost**: the fire failed `still mid-turn` and is not retried |
| g4 | Repo-channel wake mid-compaction: queued and delivered once? | **Yes** |
| h1 | Does a daemon-sent `/compact` through the normal path count as Joe's typing in `note_sent`? | **Yes** (read from code) |
| h2 | Does the `is_meta` path run `/compact`? | **No**, the sentinel in front stops the CLI treating it as a command |

## 2. (a) What the pump receives

Raw stdout of the child between the send and the end, in order (pump trace lines; `session_id` and
other tails cut; times are UTC, send at 12:40:14.27):

```
12:40:14  {"type":"system","subtype":"status","status":"compacting","session_id":"d743b5e4-...","uuid":"dbefd74a-..."}
12:40:35  {"type":"system","subtype":"hook_started","hook_id":"741fd322-...","hook_name":"SessionStart:compact","hook_event":"SessionStart",...}
12:40:35  {"type":"system","subtype":"hook_started","hook_id":"6a4b0a91-...","hook_name":"SessionStart:compact","hook_event":"SessionStart",...}
12:40:35  {"type":"system","subtype":"hook_response","hook_id":"741fd322-...","hook_name":"SessionStart:compact","output":"","stdout":"","exit_code":0,"outcome":"success",...}
12:40:35  {"type":"system","subtype":"hook_response","hook_id":"6a4b0a91-...","hook_name":"SessionStart:compact","output":"{\"hookSpecificOutput\": {\"hookEventName\": \"SessionStart\", \"additionalContext\": \"# Global lessons ...",...}
12:40:36  {"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"d743b5e4-...","uuid":"ed2615a7-..."}
12:40:36  {"type":"system","subtype":"init","cwd":"...","session_id":"d743b5e4-...","tools":[...],...}
12:40:36  {"type":"system","subtype":"compact_boundary","session_id":"d743b5e4-...","uuid":"055937c9-...",
           "compact_metadata":{"trigger":"manual","pre_tokens":85837,"post_tokens":9860,"cumulative_dropped_tokens":75977,
           "duration_ms":21335,"pre_compact_discovered_tools":["mcp__cc_conductor__report_turn_status","mcp__cc_conductor__send_message"],
           "preserved_segment":{"head_uuid":"92073392-...","anchor_uuid":"57a07e61-...","tail_uuid":"d9bd896a-..."},
           "preserved_messages":{"anchor_uuid":"57a07e61-...","uuids":[3 ids],"all_uuids":[8 ids]}},
           "logical_parent_uuid":"d9bd896a-..."}
12:40:36  {"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. ..."},...}
12:40:36  {"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted PreCompact [python \"...precompact-backup.py\"] completed successfully</local-command-stdout>"},"session_id":"d743b5e4-...","parent_tool_use_id":null,"uuid":"e81a352c-...","timestamp":"2026-11-12T12:40:36.101Z","isReplay":true}
12:40:36  {"is_error":false,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"total_cost_usd":0.4240242,
           "usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"iterations":[],...},
           "modelUsage":{...cumulative...},"model_usage_since_last_result":{...this compaction...},
           "subtype":"success","result":"","type":"result","duration_ms":21742,...}
```

- **No `stream_event` line at all.** The pump never marks the turn live; `busy` comes from the
  send path's `set_busy` ("pump_turn_gen captured = 6" on the first line) and is
  cleared by the result line: `turn end: pump_turn_gen=6 registry_turn_gen=6 action=TurnEnded`. All
  eleven lines were logged at info as "idle stdout" (that is the existing line for a line on an idle
  child), not as turn lines. (Every stdout line of the compaction took that path, 11 lines.)
- UNVERIFIED, read from code, resumed child: this chat was started with `start_session(new_session_id)`,
  not resumed. `TurnBoundary::new(resumed)` starts with `replaying: resumed`
  (`daemon/pump/turn_boundary.rs:33-35`), and a `result` with no preceding `stream_event` while
  `replaying` is true returns `ReplayedResult` (`:49-56`), which does not end the turn. A compaction
  emits no `stream_event`, so a `/compact` sent as the FIRST thing to a `--resume` child (after a
  daemon restart or a respawn) would probably leave `busy` latched until the busy watchdog. Test it
  before B1 relies on compacting right after a resume (a normal turn first would end the replay
  window).
- Registry over time (polled every 400 ms): `busy=true awaiting=` at 0.4 s, `busy=false awaiting=`
  at 21.8 s. A normal turn ends with `awaiting=done` (the Stop hook plus `report_turn_status`); a
  compaction ends with `awaiting` null. Anything that waits for `awaiting=done` to decide "the chat
  is finished" must treat a compaction end as idle.
- The compaction's own cost is NOT in `usage` (zeros). It is in `model_usage_since_last_result` and
  in the jump of `total_cost_usd`: see section 5.
- A second `/compact keep the decisions` on the already compacted chat behaved the same
  (`pre_tokens` 52,677, `post_tokens` 10,064, 19,563 ms).
- `ChatEvent`s on the per-session stream WebSocket (what the daemon publishes; the webview does NOT
  render all of them live, see section 3): `user_message`
  (`/compact ...` echo, `remote_echo:true`, `is_meta:false`), then at the end `user_message` (the
  summary, `is_meta:false`), `user_message` (the `<local-command-stdout>` line, `is_meta:false`),
  `turn_usage` (zero tokens, `total_cost_usd` 0.4240242, `duration_ms` 21742). The `compact_boundary`,
  `status`, `hook_*` and `init` lines produce no event (`chat/parser/mod.rs:287` keeps only `init`,
  and the second `init` after a compaction did not reach the stream as a `session_started`).

## 3. (b) The transcript

Lines appended to `<account>/projects/<cwd>/<session>.jsonl` by the compaction (line numbers are
from this run; the file is append-only, so all earlier history stays above them):

| # | `type` / `subtype` | Flags | Content |
|---|---|---|---|
| 142 | `system` / `compact_boundary` | `parentUuid:null`, `logicalParentUuid`, `isMeta:false`, `level:"info"` | `content:"Conversation compacted"`, `compactMetadata:{trigger:"manual", preTokens:85837, postTokens:9860, durationMs:21335, cumulativeDroppedTokens:75977, preCompactDiscoveredTools, preservedSegment{headUuid,anchorUuid,tailUuid}, preservedMessages{anchorUuid,uuids,allUuids}}` |
| 143 | `user` | `isCompactSummary:true`, `isVisibleInTranscriptOnly:true`, `turnPosition` | `message.content` is ONE STRING of 6,487 chars starting `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.` followed by `<system-reminder><tools-used-before-summary>...`, then `Summary:` with nine numbered sections, then the path of the full transcript, then `Continue the conversation from where it left off without asking the user any further questions. Resume directly ...` |
| 144 | `user` | `isMeta:true` | `<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>` |
| 145 | `user` | none | `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep the open jobs, decisions and Joe's last two messages word for word</command-args>` |
| 146 | `user` | none | `<local-command-stdout>Compacted PreCompact [python "...precompact-backup.py"] completed successfully</local-command-stdout>` |
| 147-157 | `attachment` | | `compact_file_reference` (one per file read before, here `beta.js`, `alpha.js`), `deferred_tools_delta`, `agent_listing_delta`, `skill_listing`, `environment`, `model`, `output_style_instructions`, `hook_success` (`SessionStart:compact`), `hook_additional_context` (`SessionStart`), and a further `attachment` |

Notes on the shape:

- File order is not timestamp order: lines 144-146 carry the SEND time (12:40:14.277, the first two)
  and the end time (146), while 142-143 carry 12:40:35.6. A reader that sorts by `timestamp` puts
  the `/compact` command above the boundary.
- The tail of the pre-compaction conversation is kept verbatim by uuid (`preservedSegment`, three
  messages here), so the CLI sends: summary, then those messages, then the new turn. The summary text
  ends with "The messages after this summary are the most recent messages from before compaction,
  kept verbatim."
- The new `Done.` rows and tool rows of the first turn after the compaction continue the same file.
- Message from the summary of this run, section 6, to show how Joe's wording is kept:
  `2. "Actually hold the thought: when we revisit this, call the checkout flag 'zebra-lantern-92' and do NOT rename it, even if it looks ugly."`

### How the app renders it today

The parser and classifier were run on the real lines (`chat-classifiers.ts` bundled with esbuild and
fed lines 143-146):

| Line | Backend parser (`chat/parser/mod.rs`) | `chat-classifiers.ts` | Result in the window |
|---|---|---|---|
| 142 boundary | `system` other than `init`: dropped | none | nothing, no marker |
| 143 summary | `user`, `is_meta` from `isMeta` (absent: false), `isCompactSummary` and `isVisibleInTranscriptOnly` are read nowhere | `isCompactUserMessage` is false (see below), `cleanUserBlocks` keeps all 6,487 chars | **a Joe bubble** |
| 144 caveat | `user`, `isMeta:true` | `classifyMetaTurn` | a "Scheduled wake" meta chip whose detail is the caveat text (wrong label) |
| 145 command | `user` | `normalizeUserMessageText` rebuilds `/compact keep the open jobs ...` | a Joe bubble `/compact keep ...` |
| 146 stdout | `user` | `COMMAND_BLOCK_RE` strips the whole block | dropped, nothing |

- Live versus history: the "Joe bubble" result above comes from the transcript/history path (the
  parser applied to the file, plus the JS classifier, which was run on lines 143-146). It was
  inferred, not observed in a rendered window. On the LIVE path `event-store.ts:339` drops every
  `user_message` with `remote_echo` false ("claude -p --resume replays history incl. past user
  messages"), and the parser sets `remote_echo:false` for the summary and the stdout line
  (`chat/parser/mod.rs:317`), so a live window shows only the `/compact` echo (`remote_echo:true`)
  and the summary appears when the history is next loaded (reopen, page, reload). Both paths need
  the fix.
- Why the compaction row never appears: `COMPACT_COMMAND_RE` in `chat-classifiers.ts:323` is
  `<command-name>compact</command-name>`, but the CLI writes `<command-name>/compact</command-name>`
  (leading slash), so `isCompactUserMessage` is false for the real line and the "Conversation
  compacted" row is never produced. The code that handles `isCompaction` was written for another shape.
- Dashboard: `isJoeMessage` (`dashboard-model.ts:88`) is true for rows 143 and 145 (`kind:"user"`, no
  author, non-empty text), so a compaction injects two fake Joe messages that become `lastJoe`, a
  `joeAt` for job titles and lead lookup (`dashboard-model.ts:119,324-361,561`).
- `context_status.rs:372` `is_compaction_line` matches both markers (the `compact_boundary` system
  line and the `isCompactSummary` user line), so by that code the epoch goes up by TWO per
  compaction (read from code; the epoch itself was not observed). The code
  comment calls itself "UNVERIFIED against a real compacted transcript": both markers are real and
  both fire, as the comment allows.

## 4. (c) Context before and after

| Point | Number | Source |
|---|---|---|
| Before | 85,832 occupancy; `pre_tokens` 85,837 | `context_status`; `compact_boundary` |
| After, conversation only | `post_tokens` 9,860 (summary plus the 3 preserved messages) | `compact_boundary` |
| First request after | 22,391 cache-creation + 22,702 cache-read = 45,093 | transcript `usage` of the first assistant line |
| `context_status` straight after the compaction | **85,832 (stale)** | RPC, before any assistant line |
| `context_status` after the next turn | 51,356 | RPC |
| Second compaction | 52,677 to `post_tokens` 10,064; next turn 47,042 | |

The base (system prompt, tool list, CLAUDE.md and the other attachments, re-sent after a
compaction as lines 147-157) is about 35K tokens (45,093 minus 9,860; the first request of the
chat measured 42K with only one short message), so a compaction can shrink a chat to about 35K
plus about 10K, not to 10K. `context_status` reads the last assistant line's usage, so for a
compaction the "Compacted 312K to 41K" row should use the boundary's `pre_tokens` and `post_tokens`
(plus the base), not `context_status`, and `context_cap`-style checks that run right after a
compaction will see the old number until the next assistant line.

## 5. (c) Time and cost of the compaction

| | First compaction | Second compaction |
|---|---|---|
| Wall time | 21.7 s busy (`duration_ms` 21,335 compact, 21,742 result) | 20.3 s busy (`duration_ms` 19,563) |
| Tokens (`model_usage_since_last_result`) | input 2,155, output 3,012, cache read 85,293, cache creation 412 | not captured separately |
| Cost | $0.0440 (`total_cost_usd` 0.3800 to 0.4240) | $0.0382 (0.6027 to 0.6409) |
| Next turn's cache cost | 22,391 cache-creation tokens, $0.1357 (0.4240 to 0.5597; that turn also took the held message, 5 model calls) | |

So the model reads the whole context once more (cached) and writes about 3K tokens of summary.
The costs above are the CLI's own `costUSD` figures (`model_usage_since_last_result`,
`total_cost_usd`), not recomputed from list prices. The first turn after a compaction paid a cache
rewrite: 22,391 cache-creation tokens in this run (the rest of its 45,093-token prefix was a cache
read). The $0.1357 is that whole five-call turn, not a pure rewrite cost. UNVERIFIED: how this scales
to a compaction at 250K with the subscription's 1-hour cache; only 52K and 86K contexts were
measured.

Whole spike: 11 chat turns plus 2 compactions, fresh input 4,253, output 9,949, cache creation
124,125, cache read 1,544,478, $0.758 (under the 150K non-cache-read budget: 138K).

## 6. (d) Are the prompts still in effect after the compaction?

- `SUBCHATS_MAIN_PROMPT` and `TURN_STATUS_PROMPT` are in argv (`--append-system-prompt`) of the same
  child process, which a compaction does not restart, so they cannot be lost; the model's behaviour
  confirms it. This holds for a prompt delivered in argv. A chat whose subchats toggle was flipped
  ON while the child was alive gets `SUBCHATS_MAIN_PROMPT` as a note appended to its next user
  message instead (`teardown.rs:131-135`, `lifecycle/spawn.rs:222-224`), and that note lives in the
  conversation history, which a summary can drop or paraphrase. Not measured: B1 should either
  re-send the note after a compaction for such a chat or restart the child with the prompt in argv.
- Probe asked BEFORE the compaction and again AFTER (cc-progress marker, sub tiers, which tool to call
  first on close): the same correct answers, but the summary also contained those answers (section 2
  of the summary lists them), so that probe proves nothing for "after".
- Probe asked only AFTER, with facts that appear in neither the earlier turns nor the summary:
  1. wrapper for a visual mockup: answered `<cc-preview:SLUG></cc-preview>` (TURN_STATUS_PROMPT);
  2. parameter that runs jobs in order and what never to schedule into the chat: answered `after`, and
     "never schedule prompts into this chat to check on subs" (SUBCHATS_MAIN_PROMPT rules 8 and 13);
  3. what to do before editing a file another session may touch: answered `list_peers`, then
     `post_message` (TURN_STATUS_PROMPT).
  All three correct. **Yes**, both prompts survive.
- NOT measured: whether a compaction re-snapshots the system prompt (the plan's claim that a prompt
  change reaches an old chat at its next compaction). Argv is fixed at spawn and the child lives
  across the compaction, so this would need a prompt change between the spawn and the compaction.

## 7. (e) Did Joe's words survive?

- Both distinctive messages (`zebra-lantern-92`, `quokka-migration`, `plinth`) are in the summary
  verbatim in section 6 ("All user messages") and again in section 7 ("Pending Tasks", labelled
  "word for word"). **Yes.** In this short chat the summary listed every user message; for a long chat
  the CLI may drop older ones, so this proves the focus text works, not that it scales.
- The literal "Joe's last two messages" was misread: the summariser counted the `/compact` command
  itself as Joe's last message and gave it as a paraphrase, not word for word ("The task asks for a
  text-only response ..."). Message 5 (the probe before it) was quoted exactly. Consequence for B1:
  never say "last two messages" in the focus text. Put the text to keep INSIDE the focus argument
  (the command args are part of what the summariser sees), or say "the two messages before this
  command".

## 8. (f) The SessionStart hook

- Fires on the compaction: **yes**. The stream shows `hook_started`/`hook_response` with
  `hook_name:"SessionStart:compact"`, `hook_event:"SessionStart"`, twice (ids `741fd322` empty output
  exit 0, which fits a hook that prints nothing, and `6a4b0a91` which printed JSON). The command line
  is not part of the event. At startup the same chat showed `hook_success SessionStart:startup`
  (transcript line 3). The global hook has no matcher, so it fires for startup, resume, clear and
  compact; the payload's `source` tells them apart.
- Does it clobber the registry row (kind, name, `subchat_of`/subchats state): **no clobber of the
  kind or the subchats state; the pid and name enrichment was NOT exercised** (see the restatement at
  the end of this bullet). After a compaction no `session-start` reached the
  isolated daemon (the global hook goes to port 27182), so the same call was made by hand: `POST
  /hooks/session-start` on the isolated hook server with `{session_id, cwd, transcript_path,
  hook_event_name:"SessionStart", source:"compact", pid:4242}` returned 204 and logged
  `hook /hooks/session-start: session=... pid=Some(4242) source=Some("compact")`. The instance row
  before and after was identical field for field: `kind:"interactive"`, `pid:0`, `name:null`,
  `account_id`, `started_at`, `is_remote`; `list_subchats_on` still held the id. Reason: `register`
  returns early for a known id (`sessions/registry_lifecycle.rs:24-26`), and the handler's
  `InstanceKind::External` is only used for a new id.
  Caveat: this is a synthetic payload, the real hook's stdin was not captured. And the row was
  compared immediately after the POST. The handler also does work this check did not cover
  (`hooks_server/lifecycle.rs`): `upsert_project_for_cwd` (:131), `publish_instances_changed` (:182),
  and a spawned background task that, only when the payload has no pid or pid 0 (:164-168), resolves
  a pid from the session files and calls `set_pid` (the synthetic payload carried pid 4242, so that
  branch was skipped), and `set_name` from the transcript's first user prompt unless the row is a sub
  (:169-175; the name stayed null in the immediate diff, a later change was not looked for). So the
  accurate statement is: `register()` returning early for a known id is confirmed (kind
  stays Interactive, subchats state untouched); whether a REAL compact-source hook changes the row's
  `pid` or `name` through the enrichment task is UNVERIFIED and should get a test in B1.
- A hook's `additionalContext` reaching the chat after a compaction: **yes**. The user's own
  `SessionStart` Python hook printed `{"hookSpecificOutput": {"hookEventName": "SessionStart",
  "additionalContext": "# Global lessons ..."}}`; the transcript got an `attachment` of type
  `hook_additional_context` (hookName `SessionStart`) at line 156 right after the compaction, and
  again after the second compaction. The daemon's own `on_session_start` answers 204 with no body, so
  to inject the family state the handler must return that JSON when `payload.source == "compact"`;
  that is a code change and was not tried against the daemon's endpoint.
- Side effect to remember: the compaction also re-sends CLAUDE.md, skill listing, the deferred tool
  list and the output style as attachments (lines 147-157), so a rule change in CLAUDE.md does reach
  the chat at a compaction.

## 9. (g) Messages and wakes during a compaction

All sent while `busy=true` from the compaction:

| What | Result |
|---|---|
| Normal REST send at +4 s (`POST /api/sessions/:id/send`) | HTTP 409 `SESSION_BUSY: session ... is mid-turn - hold this message until the turn ends`; daemon log `refuse_if_busy refused a mid-turn send`. Not written to the child, not queued by the daemon. The phone transport re-stages a 409 into the held queue; the desktop `send_message` RPC has the same `refuse_if_busy` (`methods/lifecycle/core.rs`), not run in this spike |
| Held message (`add_held_message`, draft store) at +8 s | accepted, `held_count` 1, still held when the compaction ended, then delivered ONCE inside the next turn as a `<user-message-mid-turn>` `hook_additional_context` attachment (`PostToolBatch`); the model answered `HELD-OK` once; `held_count` back to 0. Not lost, not doubled |
| Scheduled wake (`schedule_create` message item, `schedule_fire_now`) at +6 s | `schedule_fire_now` returned ok, but `fire_message` refused: item status `failed`, reason `target session is still mid-turn; the daemon has no turn queue ...`. **Lost.** Firing the same item again after idle delivered nothing; a new item fired at idle delivered once as `[daemon-meta][schedule] wake-sim-2 ...` |
| Repo-channel wake (`/channel/post-message` from a peer, the path `report_back` rides) during the SECOND compaction | `delivered:true` at +4 s, queued; the compaction ended at +20.3 s; the wake was written 2.8 s later (the 3 s `IDLE_COALESCE_WINDOW`) as one user line `[daemon-meta][daemon-author:5eed...]1 new peer message from session 5eed.... Call read_messages to view.` Exactly one such line in the transcript. **Queued and delivered once** |

So: the busy flag covers the compaction, REST/RPC sends are refused with a retryable error, held
messages and the repo-channel wake queue survive and arrive once, but a schedule fire (and anything
else that calls `fire_message` or `send_message` directly) is refused and, for a one-shot item,
dropped. B1 either sends `/compact` only when no schedule is due or needs the schedule path to retry
a `still mid-turn` failure.

## 10. (h) How the daemon marks what it sends

Read from `daemon/lifecycle/teardown.rs` `send_message_inner(session, text, is_meta, author)`:

1. `joe_message::note_sent(session_id, text, is_meta, author)` runs first. Joe's typing is recorded
   when `!is_meta && author.is_none() && !is_card_reply(text) && !text.trim().is_empty() &&
   tracked(session)`; anything else clears the slot. So a `/compact ...` sent through the ordinary
   path (`is_meta=false`) **is recorded as Joe's message** and would be copied to a sub by `subchat
   send`. (The plan also says it could consume `back.rs`'s line. `note_sent` only feeds the
   `joe_message` slot; `back.rs` is served by the `UserPromptSubmit` hook (`subchats/back.rs:3`), a
   path this send does not touch directly. Whether the CLI fires that hook for a slash command was
   not measured, so treat the `back.rs` part as UNVERIFIED.)
2. `is_meta=true` prepends the zero-width sentinel `\u200b[daemon-meta]\u200b` to the text written
   to the CLI (`DAEMON_META_SENTINEL`); an author adds `[daemon-author:<id>]`. The CLI persists them
   in the transcript (seen: `"\u200b[daemon-meta]\u200b[schedule] wake-sim-2 ..."`) and the parser
   strips them back into `is_meta` / `author_session_id`.
3. `last_prompt` is set to the text (a rate-limit replay would re-send `/compact`), and
   `broadcast::publish(UserMessage{ content: text, remote_echo:true, is_meta })` echoes it to the window
   (so a `/compact` echo shows as a Joe bubble when `is_meta=false`).
4. `told_note_for_message` already skips the subchats note for text that starts with `/`.
5. The non-meta path also runs `slash::mentions::augment(text, cwd)` (`teardown.rs:127`), which can
   append a `<conductor-slash-context>` block after the text. Whether a leading `/compact` token
   triggers it is UNVERIFIED (the measured `/compact` still worked, so it did not break the command in
   this run); the bare sender must skip it anyway.

**Measured: the meta path cannot carry `/compact`.** Sending
`\u200b[daemon-meta]\u200b/compact sentinel-test: keep everything` (what `is_meta=true` would write)
produced NO `compact_boundary`; the model took it as an ordinary prompt and answered a normal turn
(transcript line 245 `"\u200b[daemon-meta]\u200b/compact sentinel-test: keep everything"`, then an
ordinary two-call turn that cost $0.0133). The CLI only expands a command when the text starts with `/`.

So B1 needs a send variant that writes the bare `/compact <focus>` (no sentinel) AND does not touch
`joe_message` (so Joe's real last message stays the slot), does not overwrite `last_prompt` with the
command, and does not echo it as a Joe bubble. That is a new function next to `send_message_inner`,
with a test that `note_sent` is not called and the slot is unchanged.

## 11. What B1 must handle (summary of the findings, no code was written)

1. Parser: read `isCompactSummary`/`isVisibleInTranscriptOnly` on the summary line and the
   `compact_boundary` system line (raise a `ChatEvent` with `pre_tokens`, `post_tokens`,
   `duration_ms`, `trigger`) so the window shows one quiet row and the summary is not a bubble.
2. Classifier: fix `COMPACT_COMMAND_RE` to the slash form, drop the caveat line (`isMeta` +
   `<local-command-caveat>`) instead of labelling it "Scheduled wake", and make `isJoeMessage` false
   for compaction rows.
3. `context_status` and any post-compaction check: stale until the next assistant line; use the
   boundary's `post_tokens` (plus about 35K base) or wait for the first assistant line.
4. Treat a compaction end (`awaiting` null, not `done`) as idle in every "turn ended" consumer.
5. A bare-command send path (section 10).
6. Make the schedule fire retry a `mid-turn` refusal, or never compact while a one-shot is due.
7. `on_session_start` returning `additionalContext` for `source == "compact"` is the injection point.
   `register()` does not clobber an existing row (section 8); the pid and name enrichment task for a
   real hook payload is UNVERIFIED and needs a test.
8. Focus text: no relative phrases ("last two messages"); carry the verbatim text inside it.
9. Hook ordering: the compaction ran `PreCompact` (the user's `precompact-backup.py`) then the
   two `SessionStart:compact` hooks, all inside the 21 s.
10. UNVERIFIED, resumed child: `/compact` as the first message to a `--resume` child may leave `busy`
    latched (section 2). Test before compacting right after a daemon restart or respawn.
11. A chat whose subchats prompt arrived as a note (toggle flipped mid-chat) needs the note re-sent
    after a compaction (section 6).
12. Live window versus history: the fix for the summary bubble has to cover both the live path
    (`event-store.ts:339` drops `remote_echo:false` user messages) and the history load (section 3).

## 12. Cleanup (command output)

```
daemon pid 34200 (parent 41872), children: conhost 12596, claude.exe 31500 (+ its children 11924, 22180, 12684)
taskkill /F /T /PID 34200
SUCCESS: The process with PID 34200 (child process of PID 41872) has been terminated.   (plus the five children)
daemon alive: False
port 33290 listeners: 0
processes mentioning compact-spike: 0
C:\Users\tecno\cargo-scratch\compact-spike exists: False   (private cargo target, data dir, scratch repo, driver scripts)
C:\Users\tecno\.claude-personal\projects\C--Users-tecno-cargo-scratch-compact-spike-repo exists: False   (this chat's transcript)
C:\Users\tecno\.claude-personal\session-env\d743b5e4-e212-4515-b90c-90ebfa74a2be exists: False
```

Left behind on purpose: whatever the live daemon recorded from the global hooks (section 0), and the
user's own `precompact-backup.py` backup of the transcript, if that hook writes one.
