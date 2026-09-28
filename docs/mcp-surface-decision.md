# Decision: Conductor's MCP surface (todo 512, 2026-08-08)

## Question

Should Conductor expose its own MCP server as the primary AI-facing surface, replace remaining
text-marker signalling with it, or leave things as they are? Raised by Joe on 2026-08-06 asking
whether MCP would mean "fewer trips" for the AI; the framing turned out to be inverted (see
todo 512's own notes) - MCP costs more per turn (schema rides every turn) and less on first
contact with an unfamiliar command; a CLI is the reverse. The real argument for MCP is error
feedback, not round-trip count.

## Measurement (the thing this todo required before deciding)

Todo 426 asked for a real number instead of an estimate. The only concrete measurement on record
is from todo 435 / memory `project_mcp_tool_def_per_turn_cost` (2026-08-06): replacing the
`cc-status`/`cc-title` text markers in `TURN_STATUS_PROMPT` with the `report_turn_status` MCP tool
came out to roughly a **wash** - old marker prose was ~995 chars (~250 tok), the new prompt
sentence + tool schema together are ~1100 chars (~275 tok). Both forms are static-per-session, so
there is no caching asymmetry either way. This is a static char-count estimate, not measured
against real API usage/caching, but it is the best evidence available and it kills the
cost-reduction argument for either direction: **MCP is not measurably cheaper or more expensive
than the marker prose it replaces.**

Since 435 was written, the tool set has grown further: `send_message` is now enforced at every
turn end so quiet-mode chats aren't silent (commit `55e8e8ea`, 2026-08-08). The base MCP surface a
non-Jarvis session carries every turn is now 8 tools: `approval_prompt`, `ask_user_question`,
`close_session`, `list_peers`, `post_message`, `read_messages`, `report_turn_status`,
`send_message` (`src-tauri/src/mcp/server.rs`, `tools_list_returns_seven_base_tools` - name is
stale, asserts 8). A singleton Jarvis session adds 4 more fleet tools on top.

## Decision: MCP for correctness-critical signalling only

Not status quo (pure CLI/marker mix), not a full MCP surface. This is already the direction the
codebase has been moving in, and this todo makes it the recorded, intentional target state rather
than an unexamined drift:

- **Schema-validated MCP tools** for signals where a silent failure is expensive: turn
  status/title (`report_turn_status`), reaching Joe (`send_message`), close confirmation
  (`close_session`), permission relay (`approval_prompt`), mid-turn questions
  (`ask_user_question`), and inter-agent coordination (`list_peers`/`post_message`/
  `read_messages`).
- **Text markers stay** for the remaining low-stakes signals where a schema-enforced error isn't
  worth the standing per-turn cost: `<cc-progress:N/M>` (superseded by todo 410's TodoWrite
  bake-in, not migrated) and `<cc-autopilot:on|off>` (todo 435's own phase-2, never started).
- **Full MCP surface rejected.** Its main justification would be reachability from a client with
  no shell - Conductor only ever drives Claude Code sessions through a shell today, and no
  non-shell client is on the roadmap. Nothing else makes the full-surface option win.

## Reasoning

The cost measurement above is a wash, so it decides nothing - neither expanding nor rolling back
MCP saves or costs meaningful tokens. The decisive property is the one Joe actually asked for in
todo 435: "if its an mcp/api, i think you should get an error if you do smth wrong." A schema
rejects a bad argument; a text marker silently does nothing. That argument only applies where a
silent failure is actually expensive (status going stale, a message never reaching Joe, a close
that doesn't confirm) - it doesn't apply to `cc-progress`, which is cosmetic and already dying via
a different todo, or `cc-autopilot`, which nobody has proposed migrating yet.

## Disposition of overlapping todos

- **426** (review per-turn cost of the coordination-channel tools) - resolved by the measurement
  above: the cost is a wash, not a problem to engineer around. No gating work needed.
- **435** (retire text markers for MCP/API) - the correctness-critical migration is the intended
  end state per this decision; `cc-progress`/`cc-autopilot` staying as markers is now the accepted
  final shape, not an unfinished migration, unless a future session identifies a concrete silent
  failure in either.

## Amendment 2026-09-28: the per-turn cost argument is weaker than this doc assumed

The measurement section above concluded "no caching asymmetry either way" between marker prose
and a tool schema. That is no longer the whole picture, and the difference now favours tools:

- **Tool schemas can be deferred; system-prompt prose cannot.** Claude Code applies the API's
  tool-search deferral (`tool_search_tool_*` + `defer_loading`) to this server's tools. Observed
  directly in a Conductor chat session on 2026-09-28: `mcp__cc_conductor__send_message` and
  `report_turn_status` were present only as NAMES in the deferred-tool list, and the session had
  to call `ToolSearch` to fetch each schema before it could call the tool. So an unused tool
  costs its name (order of 5-10 tokens), not its schema.
- **What is not deferred is cache-read priced.** Per Anthropic's prompt-caching reference the
  render order is `tools` -> `system` -> `messages`, so tool definitions occupy the most cacheable
  position in the request, and `write_mcp_config` (`daemon/lifecycle/spawn.rs:106`) writes the
  list once per session, making it byte-identical across that session's turns. From turn 2 on
  those tokens are cache reads at roughly 0.1x input price.

Measured for reference on 2026-09-28 (character count / 4 over the `json!` blocks in
`mcp/tool_schemas_*.rs`): the 15 base tools were ~23,100 chars, ~5,800 tokens, of which
`ask_user_question` alone was ~728 and `write_draft` ~546. That is the number to quote as
*context-window* footprint; quoting it as a per-turn bill overstates the cost by roughly an order
of magnitude.

**Consequence for this doc's decision:** "MCP for correctness-critical signalling only" stands,
but it should be read as a decision about *surface coherence*, not cost. Do not reject a tool on
per-turn token grounds alone; reject it because no silent-failure argument justifies it, or
because a CLI already reaches the same capability.

## Amendment 2026-09-28: `schedule` added (16th base tool)

`schedule` (add|cancel) gives the model write access to the Schedule panel's
`scheduled-items.json`, previously reachable only by the user clicking the UI - the daemon is the
file's sole writer and the mutator RPCs (`schedule_create`/`_update`/`_delete`/`_fire_now`) are
desktop-only, so there was no CLI or marker path to the same capability. That is what makes it
consistent with the decision above rather than an expansion of it: this is not a second way to
say something the model could already say.

Shape, and why:

- **`add` defaults to spawning a NEW chat**, inheriting the caller's model/effort/account from
  `chat_config` exactly as `spawn_chat` does, and reusing that module's `resolve_target_cwd`
  guard so the tool cannot start a chat at an arbitrary path.
- **`target: "this_chat"` is allowed but cannot repeat.** A recurring `ScheduledKind::Message`
  aimed at the session that created it appends to one context window on every fire, so it
  degrades until that window is full; `methods::schedule_mcp::add` refuses that combination
  outright rather than silently downgrading it.
- **Time is `in_minutes` or `at`, never both.** A model knows "in 20 minutes" reliably and the
  current wall-clock time unreliably, so the relative form is the documented default and an `at`
  in the past is an error at the call rather than an item the tick loop later sweeps to `Missed`.
- **There is no `list` action.** Pending items relevant to the session ride the existing
  `UserPromptSubmit` injection (`methods::schedule_mcp::render_for_injection`, the fourth rider on
  the hook that already carries todos, drafts and killed subagents), which costs nothing when
  there is nothing scheduled and hands over the ids a `cancel` needs.
