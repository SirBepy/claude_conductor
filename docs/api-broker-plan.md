# API token broker: plan

Status: approved by Joe 2026-11-18 after an /iterate-it run (8 rounds, final 8/10, main audit 8).
Build it as one full-scope version, one writer sub per numbered step below, in order.

## Problem

Chats need Joe's personal tokens for Shortcut, Figma, Trello, Linear, Clockify and Hubstaff. Today
they read `~/.claude/.env` themselves, each skill its own way (Bash grep in
`~/.claude/refs/shortcut-api.md`, PowerShell `Get-Content` in `~/.claude/skills/linear/SKILL.md`,
Python in `~/.claude/skills/_shared/figma_client.py`, about 20 consumers in total). The
results, measured 2026-11-18:

- `settings.json` denies the Read tool on `**/.env`. No hook blocks reading it
  (`~/.claude/hooks/sensitive-file-guard.py` covers writes only). Every other path is judged
  by the auto-mode classifier, per command and nondeterministically: PowerShell reads are
  usually denied, Bash grep usually passes, and unattended runs get `[Unauthorized Access]`
  (`~/.claude/.claude/todos/pc-1367-...`).
- About 5 of 9 sampled refusals were chats saying "can't read .env" without trying. The belief
  is copied between chats through briefs and memories.
- Tool output is stored verbatim in transcripts. 49 transcript `.jsonl` files under
  `~/.claude/projects` hold a token-shaped string. The recall index is redacted, but the raw
  transcripts are not. They are local and gitignored, and not synced anywhere.

## Goals (Joe's)

Tokens are protected, and no one else can reach them. The model can't read them, and a chat can
use them only when its task needs them. It all has to work unattended (hidden subs, autopilot).

## Honest limits (state these in the arch doc, never oversell)

- DPAPI and Keychain protect a token at rest, against file reads, copies and backups. They do NOT
  stop code running as Joe's user. The boundary against the model is that no token appears in any
  model-readable output, plus scoped authority on what a chat may do with the token.
- The loopback front can't tell a script from the model. A model with shell access can read its
  own session's broker token and call the endpoint. That gives it only its own session's
  authority, and the call is audited, which is the same authority the MCP tool already grants.

## Design

1. **Engine** (`src-tauri/src/daemon/broker/`):
   - A SERVICES table in code: host and auth shape (header, query, or oauth-refresh) for each of
     the six services.
   - Request guards: relative paths only, redirects off, a size cap, and no host-override headers.
   - Shortcut and Linear ownership checks live in the engine.
   - An append-only JSONL audit log: service, method, path, status and session, plus GET volume
     with outlier flags.
   - Reuse what exists: the `src-tauri/src/api_keys.rs` registry (already the owner of key
     storage, and its public API never returns a value; today it lists only
     SHORTCUT_API_TOKEN, LINEAR_API_KEY, TRELLO_API_KEY and TRELLO_TOKEN, so Figma, Clockify and
     Hubstaff entries are new registry rows; `.env` keeps the plaintext path via `set_key`, the
     broker store is the new protected path and needs its own read function), the `crate::env_file` reader, and the
     tracker clients in `src-tauri/src/tickets/`.
2. **Policy**:
   - `<data_dir>/broker-policy.json`, hot-reloaded, edited only through a card Joe answers.
   - Rows are `{method, path regex, require_owner}`, plus Linear named-mutation rows.
   - GET is open on bound services. Shortcut `POST /api/v3/search` is an explicit read row.
   - Writes go through pattern rows on owned objects. Deletes and bulk endpoints are never seeded.
   - Linear writes are pinned to named operations (`commentCreate`, `issueCreate`, `issueUpdate`),
     never to a generic GraphQL mutation parse.
   - Seed the defaults from a scan of the last 30 days of transcripts for the calls Joe actually
     makes. Anything not seen there stays denied.
   - A denial prints the exact policy line to add.
3. **Scope**:
   - `broker_services` on `ProjectConfig` (`#[serde(default)]`). When the field is absent it
     resolves at read time to the project's tracker (`tickets::effective_tracker`) plus `figma`,
     and that default is never persisted.
   - It applies to every session kind. Hidden subs inherit their parent's set, and autopilot gets
     the project's set.
   - An unbound service returns `ok:false` with the binding line to add, and no card.
4. **Fronts**:
   - MCP `api_read` / `api_write` in `cc_conductor`, pretrusted in the single
     `PRETRUSTED_TOOLS` list in `daemon/claude_config/args.rs` (line 171; a test there lists the
     names that must be present, add the two tools to it). The `TRANSPORT_TABLE` row is desktop-pipe only, with a
     rationale comment and an allowlist test entry.
   - A loopback HTTP front for scripts and hooks, via a ~30-line `cc_api.py` / `cc_api.mjs`
     client. Optional `out_file` goes to the project or temp dir only. Binary `out_file` is
     allowed only for GET on named download paths, and the audit marks it as unmasked.
   - The HTTP front requires `CC_BROKER_TOKEN` = HMAC(daemon key, session_id + role + bound
     services). It is injected at spawn in `daemon/lifecycle/spawn.rs` and stays stable across the
     per-turn respawn. The daemon token file alone is rejected.
5. **Masking**: each stored secret's raw, url-encoded, base64, JSON-escaped and Basic forms are
   masked in bodies, headers, errors and `out_file` text. Mask exact values only, never by regex
   shape.
6. **Store**:
   - Windows: `util/secret_store.rs` (DPAPI).
   - Mac: a new Keychain write path (`security add-generic-password`), with no plaintext fallback.
     If the Keychain is unavailable, that service is off and the error says why.
     `accounts/keychain.rs` only reads today, so this is new work.
   - Hubstaff (rotating refresh token) is PC-only, and the Mac error says "PC only".
   - Two cards only Joe can answer: import, where the daemon copies from `~/.claude/.env` itself,
     and add/replace, one per machine. Both list the services that are missing.
   - The `TRELLO_KEY` vs `TRELLO_API_KEY` name mismatch (`.env` vs the `api_keys.rs` registry)
     is resolved at import.
7. **Guards stay hooks**: `outbound-verify-guard.py`, `shortcut-create-guard.py`, the linear
   guards and `commit-window-guard`-style window checks keep running as `~/.claude` hooks. They
   are re-pointed at `mcp__cc_conductor__api_write` and at the `cc_api` command string. The engine
   does not duplicate them: the daemon has no transcript to verify against.

## Build steps (Conductor repo, one writer sub each)

1. `secret_store`: Mac Keychain write path, strict no-plaintext mode, encoded-variant storage,
   unit tests.
2. Masker module plus unit tests covering every encoded variant.
3. Engine: SERVICES table, policy loader with hot reload and the seed, request guards, audit
   JSONL, ownership checks. Includes the transcript-scan script that produces the seed.
4. Session token mint and verify (HMAC), env injection in `spawn.rs`, `broker_services` with its
   resolver, and the scoped-token tests (another session's token, a revoked token and the daemon
   token file alone are all rejected).
5. MCP front: tool schemas, pretrust, `TRANSPORT_TABLE` row.
6. HTTP loopback front, `cc_api.py` / `cc_api.mjs`, `out_file`.
7. Cards: import, add/replace and policy edit, all answerable only by Joe.
8. Tests on a private daemon instance (`CC_DAEMON_INSTANCE`, never the live data dir):
   - a canary integration test: a mock server echoes the canary in the body, headers, error and
     redirect `Location`, and through `out_file`. The canary must be absent from the tool result
     AND from the session JSONL.
   - prompt-injection tests: an out-of-policy write is denied, an in-policy write on a non-owned
     object is denied, and a read from A followed by a comment write carrying that data is denied
     unless a row allows it.
   - Gate 0: an attended chat, a hidden sub, autopilot and a phone-driven chat on the PC all run
     with zero permission cards. Add a friction counter: denials per day, with a target of 2 or
     fewer by day 7.
9. Docs: `docs/architecture/api-broker.md`, a CLAUDE.md rule entry, and a README line. Ship as one
   release.

## Global `~/.claude` steps (separate repo, Joe OKs each in session)

Tracked in `C:\Users\tecno\.claude\.claude\todos\` (see the todo that links this doc).

- **G0, now, before the release.** A global rule says never to read a token file, to use the
  `cc_conductor` api tools when they exist, and otherwise to ask Joe with the exact command.
  "Can't read .env" is never an answer before trying the tool. Purge the stale "can't read .env"
  memories and briefs.
- **G1, after the release and before any migration.** Hooks PR: guard matchers on `api_write` and
  `cc_api`, with tests. A test proves that a comment with no verifier is denied at the hook layer.
- **G2.** Migrate the consumers in batches against a grep checklist, ticket skill first. The old
  `.env` path stays working throughout.
- **G3.** Tripwire hook on `~/.claude/.env` and the store path, log-only. After a week with zero
  hits, switch it to deny, rotate every token through the add/replace card, and delete `.env`
  last. Deleting `.env` is the only irreversible step.

## Rejected (do not re-propose)

- Credential Manager or a password manager as the boundary against the model.
- Third-party MCP servers.
- A script broker behind an allow rule.
- Regex masking by token shape.
- Blanket write approval cards.
- Compiled named-op allowlists.
- A trimmed read-only v1.
- Copying a rotating refresh token between machines.
- A plaintext store on the Mac.
- Moving outbound-verify into the engine.

## Out of scope

`api_call_local` for project `.env.local` keys: a separate plan later, with the base URL pinned to
localhost or a project alias, through `daemon/secret_target.rs`.
