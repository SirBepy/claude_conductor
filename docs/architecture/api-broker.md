# API token broker

Spec: `docs/api-broker-plan.md`. Built one numbered step at a time; this file grows with each step
and the final step adds the CLAUDE.md rule entry (a sub cannot edit CLAUDE.md, so the main chat
adds it from the "Rules to lift into CLAUDE.md" list below).

Code: `src-tauri/src/daemon/broker/`. Stored-secret wrapping: `src-tauri/src/util/secret_store.rs`.

## Masker (`broker/mask.rs`, step 2)

Every broker result passes through a `Masker` before it leaves the daemon: response bodies,
header values, error strings, `Location` values and `out_file` text. Build one per call from the
secrets of the services the call can touch.

```rust
let m = MaskerBuilder::new().secret(&token).secret_with_user(&user, &pass).build();
let safe = m.mask_str(&body);          // text
let safe = m.mask_bytes(&bytes);       // bytes not known to be UTF-8
let mut s = m.stream();                // chunked body
let out = s.push(chunk);               // release what is safe so far
let tail = s.finish();                 // release the rest at end of body
```

Rules the code holds (each has a test):

- **Exact values only.** No regex, no token-shape match. A look-alike string stays untouched.
- **Forms.** `secret_store::encoded_variants` supplies raw, percent (upper and lower hex), JSON
  (with and without `\/`), hex, standard and URL-safe base64 padded and unpadded, and the base64 of
  `secret:` and `:secret`. `mask.rs` adds uppercase hex, `+` for a space, percent-encoding with the
  other common safe sets (`encodeURIComponent`, form encoding, Python `quote` with `/` raw, a
  sub-delimiters-raw profile) in both hex cases for the secret and for every base64 form that
  carries `+`, `/` or `=`, JSON with `\uXXXX` for non-ASCII (Python style) and
  unicode escapes for `&`, `<` and `>` (Go style) in both hex cases, `\/` on the base64 forms (PHP), and the
  base64 of the secret as it sits inside a longer base64 string at each of the three byte
  alignments. That last one is how `base64(user:secret)` shows the secret when the user is not
  known; `secret_with_user` adds the exact `user:secret` forms when it is.
- **Fixed marker.** A hit becomes `[MASKED]` whatever its length, so the output reveals no length
  class.
- **Empty secret ignored.** It would match everywhere. A builder with only empties `is_empty()`.
- **Short secrets are masked, not skipped.** Skipping would leak them. The cost is over-masking
  (a one-character secret masks every occurrence of it), which is the safe side.
- **Merged regions.** Overlapping, repeated and touching hits collapse into one marker, so no
  fragment survives between two hits.
- **Streaming.** `MaskStream` keeps at most `longest pattern + 2` bytes after any push, whatever
  the body is. A region that reaches the hold-back point gets its marker at once and is remembered
  as `lead`, so a hit that keeps growing (a one-char secret in a body of that char) is never held
  whole, and a later hit that overlaps or touches it joins it without a second marker. Total
  output equals `mask_bytes` of the whole body for every chunking, valid UTF-8 or not (tests: every
  two-way split, every chunk size 1 to 40, a seeded random fuzz, stray continuation bytes after a
  hit). For valid UTF-8 a released chunk never ends mid-char; the cut only ever moves left to get
  there, so it cannot release part of a hit.
- **Single pass.** The marker is never rescanned.
- `Masker`'s `Debug` prints a pattern count only, never a pattern.

### Not covered (state these, do not oversell)

- A secret re-encoded by the remote service into a form not listed above (a hash, a custom
  cipher, double base64, a secret split across two JSON fields).
- The 0 to 4 secret bytes at the edges of an alignment-only base64 hit: the groups there also
  encode neighbouring bytes, so only whole groups inside the secret are matched, and only when
  the fragment is at least 12 base64 chars.
- A secret shorter than 11 bytes lacks some alignment variants (fewer than 9 bytes has none; the
  12-char floor stops them masking unrelated text), so `base64(unknownuser:shortsecret)` may not be
  masked; give the masker the user with `secret_with_user` when it is known.
- Go's always-on escape of U+2028 and U+2029 with HTML escaping off (only the full HTML-escaped
  form is built).
- HTML entities (`&amp;`, `&quot;`) and MIME-wrapped base64 with line breaks.
- Binary `out_file` content (the plan marks that audit entry as unmasked).

## Engine (`broker/engine.rs` and friends, step 3a)

`Engine::call(BrokerRequest { session, service, method, path, body, headers }) -> Result<BrokerResponse, BrokerError>`
is the one place a broker call is made. A front (steps 5 and 6) builds the request and maps the
result; it never touches a secret, a host or a header of its own.

```text
unknown service / empty session -> guards::check -> (Linear) graphql::parse_body
  -> Policy::decide -> read secrets -> (require_owner) ownership -> send -> mask -> audit
```

Every ending, including each refusal, writes one audit line. The secret is read only after the
policy says yes, so a denied call never touches the store.

| Module | Holds |
|---|---|
| `services.rs` | `SERVICES` in code: base URL, path prefix, auth shape per service. Shortcut `Shortcut-Token` header, Linear raw `Authorization`, Trello `key`+`token` query, Figma `X-Figma-Token`, Clockify `X-Api-Key`, Hubstaff oauth refresh then `Bearer`. `ServiceTable::with_base_url` / `with_token_url` are the test seams. |
| `guards.rs` | relative paths only, prefix per service, no dot or encoded-separator segments, credential-named query params refused (and Trello's own `key`/`token`), only `accept` and `content-type` headers pass (host-override and credential headers refused by name), request and response caps, methods GET POST PUT PATCH DELETE. `build_url` re-proves the final URL has the table's host. |
| `graphql.rs` | Linear's narrow reader: a `query` (or `{}`) is a read; a write is one `mutation` with one root field, no alias or directive, every argument a `$variable`. Anything else is `Unsupported` and refused. |
| `ownership.rs` | Pure rules: Shortcut story/epic target from the path, owned when Joe is in `owner_ids` or is `requested_by_id`; Linear target from the variables per named operation (`commentCreate` -> `input.issueId`, `issueUpdate` -> `id`), owned when Joe is `creator` or `assignee`. No target means not owned. |
| `audit.rs` | Append-only `<data_dir>/broker-audit.jsonl` (the engine takes the path; the daemon wiring is step 4+). Per GET: rolling `last_min`, `last_hour`, `bytes_last_min` and `flags` (`burst`, `sustained`, `large_response`), which annotate and never block. |
| `store.rs` | `SecretSource` trait and `SystemSecrets`: broker store first (`api_keys::resolve_secret`), `.env` second; a rotated value is written back where it was read. |
| `policy.rs` | `Policy` trait and `PolicyRequest` / `PolicyDecision`. `policy_file::FilePolicy` implements it (step 3b, section below). |

### Rules the code holds (each has a test)

- **The engine adds the host and the secret.** A chat gives a service name and a path. There is no
  host, scheme, credential or arbitrary header field, and redirects are never followed (the
  `Location` comes back masked).
- **Auth by shape.** Trello's key and token go in the query, and reqwest errors are built with
  `without_url()` and masked, because that URL carries both. Hubstaff exchanges the refresh token
  at `account.hubstaff.com/access_tokens` (browser User-Agent, because Cloudflare refuses library
  agents with a 403 that looks like a dead token), caches the access token per process, and writes
  the rotated refresh token back; if that write fails the new token is kept in memory and the audit
  line says so, so the next refresh does not spend a dead token. A tokio mutex serializes refreshes.
- **Hubstaff is PC only.** `SecretSource::can_rotate()` is true only for the DPAPI backend; elsewhere
  the call fails with `pc_only` before any secret is read.
- **Masking is built from every secret the call carried**, including the Hubstaff access token and
  rotated refresh token, and runs over the status line's headers (names and values), the body, every
  error message and hint, and the audited path.
- **Ownership fails closed.** A lookup that errors, a path or operation with no nameable target, and
  a service with no owner rule are all refusals.
- **Audit failure does not lose the result.** The call has already happened; the response carries
  `audit_failed: true` and the error is logged.
- A policy `Deny` carries a `hint` (the exact line to add), returned verbatim.

### Not built in 3a (and why)

- The policy file, hot reload and seed: built in 3b (see "Policy" below). The engine only knows `trait Policy`.
- Session binding (`broker_services`), the HMAC session token and `spawn.rs` injection (built in step 4, see "Session scope").
- Anything that reads the engine's output into a front: MCP tools (5), HTTP loopback and `out_file` (6).
  Binary bodies come back as lossy UTF-8 text until `out_file` exists.
- Daemon wiring: nothing constructs an `Engine` yet. Step 4 or 5 builds it once with
  `SystemSecrets::new(data_dir)`, the real policy, and `AuditLog::new(data_dir/broker-audit.jsonl)`.
- Audit log rotation. It is append-only and grows; rotation is a later chore.
- The tracker clients in `tickets/` are not reused for the calls: they hard-code their hosts, have no
  request cap, no masking and no redirect guard. The engine reuses `crate::env_file` (through
  `api_keys`) and `tickets::effective_tracker` is left for step 4's binding.

### Known limits (found in review, left on purpose)

- **Not cancel-safe.** `Engine::call` writes its audit line after the call returns, and a Hubstaff
  exchange plus its write-back run in the same future. A front that can drop the future (timeout,
  closed session) must spawn the call detached (`tokio::spawn`) and await the handle; steps 5 and 6
  must do that. A dropped call can lose an audit line and, mid-rotation, a spent refresh token.
- **Store writes are not serialized.** `api_keys::set_broker_secret` loads, edits and renames
  `broker-secrets.json` with no lock, so the engine's rotation write and a Settings write racing can
  lose one. Step 4 (which wires Settings) should put one process-wide lock around both.
- **Owner id cache is per process and per service**, not per token: replacing the Shortcut or Linear
  token with another account's needs a daemon restart for ownership checks to follow. Step 4 should
  clear it from the code path that stores a new token.
- **A refusal's audit failure is only logged.** `audit_failed` rides on a successful response; a
  `BrokerError` carries no flag, so a failed append on a denied call shows only in the app log.
- **The ownership lookups are not audited or counted.** `my_id` and the target fetch go upstream
  without an audit line, so GET volume undercounts a chat that triggers many `require_owner` writes.
  The volume map also keeps a key per (session, service) until restart.
- **A timeout or over-cap response after a write was sent** returns an error with a hint that the
  request may have been applied; the audit line still has no status.

## Policy (`policy_rules.rs`, `policy_file.rs`, step 3b)

`FilePolicy` implements the engine's `Policy` trait from `<data_dir>/broker-policy.json`
(`FilePolicy::open(data_dir)`; nothing constructs one yet, step 4 or 5 wires it into the one
`Engine`). A row is one of:

```json
{"service":"shortcut","method":"PUT","path":"^/api/v3/stories/\\d+$","require_owner":true,"note":"optional, for Joe"}
{"service":"linear","op":"commentCreate","require_owner":true}
```

Rules the code holds (each has a test in `policy_tests.rs`):

- **Anything not allowed is denied.** GET is open (the engine marks a GET and a Linear query
  document `read`), so a row is only ever a write. Whether the chat is bound to the service is
  step 4's check, not the policy's. Shortcut `POST /api/v3/search` is not a GET, so it is an
  explicit row in the seed.
- **Whole-path match.** A path pattern runs as `^(?:pattern)$` against the path without its
  query string, so an alternation or a missing anchor cannot match a prefix or a part. Size
  limit on the compiled regex, 4200 characters on the text (a printed row for the longest path the
  guards accept, 2048, even with every character escaped). A printed row keeps empty segments, so
  a call to `/api/v3/stories/` gets a row that matches that exact path.
- **`require_owner` defaults to true** when a row omits it. When several rows allow a call, any
  `true` wins. `issueCreate` has no existing issue, so its row is `require_owner: false`
  (the engine refuses `require_owner` with no nameable target).
- **Linear writes are pinned to `commentCreate`, `issueCreate`, `issueUpdate`** (`LINEAR_OPS`).
  A row for another operation, a Linear method+path row, or an op row on another service makes
  the file fail to load; a call for another operation is denied with no line to print, because
  no row can add it.
- **A bad file never applies half.** One bad row fails the whole file, and `FilePolicy` keeps the
  last good policy (the seed at startup), says so in every denial (`... last good policy is in
  force: row 3: ...`) and exposes `last_error()`. The file is re-read at the start of every
  decision and recompiled only when its bytes changed, so there is no watcher thread and no
  mtime race.
- **No file means the seed; a file is the whole policy.** `add_row` on a missing file writes the
  seed plus the new row, so a row can later be removed by editing the file. A malformed file is
  never overwritten by `add_row` or `write_policy`.
- **A denial prints the exact line.** `into_decision` words the hint as
  `to allow this call, Joe adds this row to "rows" in broker-policy.json (the policy card writes it): {row json}`.
  The row is `suggest_row`: ids in the path become classes (`\d+`, uuid, 24-hex), the service's
  own prefix stays literal, and `require_owner` is true for a Shortcut row that could cover a story or
  epic, decided from the call's path the way `path_shape` prints it (not by probing the
  pattern): the collection segment has a digit (it prints as `[^/]+`, so it could be `stories`:
  `%73tories`), or it is a literal `stories` or `epics` (any case) and the object segment is an
  id the engine may not read (a digit, a uuid, a 24-hex id: `12x/comments`, a 19-digit id). The
  engine then refuses for want of a target rather than a wildcard row opening every story. A
  pinned word like `stories/search` stays false. `%73tories/search` prints true and so can
  never be allowed (it fails safe) and for Linear `commentCreate` and
  `issueUpdate`. A test proves the printed row allows the call it was printed for, also for a
  trailing slash, an empty segment, and a 2048-byte path of 1000 id segments (the compile size
  limit is 8 MB for that reason; a Unicode `\d` costs a few KB).
- **Writes only through `policy_file::write_policy` / `add_row`** (process-wide lock, validate
  first, temp file then rename). The engine and the policy never write. Step 7's card calls them.

### The seed and the scan script

`broker-policy-seed.json` (next to the code, embedded with `include_str!`) is produced by
`node scripts/broker-seed-scan.mjs` (add `--days N`, `--summary-only`, `--projects <dir>`). It
reads the tool_use inputs of the last 30 days of transcripts under `~/.claude/projects` and
`~/.claude-personal/projects`: shell commands, and the body of a `.py/.sh/.ps1/.js/.mjs` script a
chat wrote. It never reads a tool result, a repo source file or anything that looks like test code
(mockito, `#[test]`), because those are fixtures, not calls. It reads the verb from the one `curl`
or `Invoke-RestMethod` invocation the URL belongs to (so a `cut -d=` is not a request body, and
`-G` makes `--data-urlencode` a GET).

It writes rows only: a method and a path SHAPE per service, never a value or a ticket id, and
every string it prints or writes passes `redact` (any 24+ character letters-and-digits run
becomes `[REDACTED]`). It seeds POST, PUT and PATCH only, never DELETE, never a path with `bulk` or
`batch`, and Linear only for the three pinned operations. Shortcut `POST /api/v3/search` is always
added. Rerun it to refresh the seed; review the diff, because the verb and path come from reading
shell text, not from the wire. Its tests: `node --test scripts/broker-seed-scan.test.mjs`
(outside the vitest `tests/` glob because step 3b could only write under `scripts/`).

A seeded write row never holds a wildcard segment (`[^/]+`): a wildcard would allow every sibling
endpoint under it, which the scan never saw. A denial's printed row pins an action name (a segment
with no digit, `archiveAllCards`) and wildcards only id-like segments (those with a digit).

### Known limits of the policy (found in review, left on purpose)

- **Nothing in the daemon stops a chat from writing `broker-policy.json` itself.** "Edited only
  through a card Joe answers" holds for the broker's own code (the engine never writes it) but a
  chat with Write or Bash access could edit or delete the file, and a missing file means the seed.
  The tripwire hook on the file and store path is the `~/.claude` G3 step, not this repo.
- **A new seed never reaches a machine that already has a policy file.** The first `add_row` copies
  the seed into the file, which is then the whole policy; a later release that removes a seed row
  does not remove it from that file.
- **`\d` in a row is Unicode** (the regex crate's default), so it also matches non-ASCII digits.
  An owner row still fails closed (`ownership::shortcut_target` is ASCII only); an owner-less row
  would match more than it reads.
- **The scan keeps a lowercase segment of up to 24 characters as a literal** (`stories`, but also a
  lowercase-only board slug). Review the seed diff after a rescan; the current seed has none.
- **A few seeded rows look like scan artifacts** (Trello `PUT /1/cards`, `PUT /1/boards/<id>/cards`,
  Shortcut `POST /api/v3/search/stories`), and `POST /story-links` and Trello `PUT /1/cards/<id>`
  carry `require_owner: false` because the engine can only check an owner from a Shortcut story or
  epic path or a Linear variable. Linear, Figma and Hubstaff have no seed rows because 30 days of
  transcripts held no pinned Linear mutation and no Figma or Hubstaff write; the first one of each
  takes a card.
- **No fsync before the rename** in `write_locked`: a crash can leave an empty file, which loads
  as malformed and falls back to the seed. Unknown JSON keys in rows are dropped on a write.
- A UTF-8 BOM (Notepad) fails to parse; the policy stays on the last good one and the error says
  the file is not valid.

## Session scope (`session.rs`, `binding.rs`, `lifecycle/broker_env.rs`, step 4)

Every chat the daemon spawns carries `CC_BROKER_TOKEN` in its `claude` child's env, and the engine
refuses any service outside the chat's bound set. The token is the only credential an HTTP front
(step 6) accepts; the stdio MCP front (step 5) is identified by the channel itself (the MCP child
belongs to one `claude` child) and reads the set with `broker_sessions.current(session_id)`.

**Token.** `ccb1.<session>.<role>.<services>.<epoch>.<mac>`, `mac` = HMAC-SHA256 over those five
fields (NUL-joined, version first) with a random 32-byte daemon key. HMAC is built on the `sha2`
already in the tree (RFC 4231 vectors in the tests), so there is no new crate. Fields are readable on
purpose: the mac is the protection, and `verify` checks it before it interprets a field.

- **The key is in memory only** (`DaemonState.broker_sessions`), never written. A file the model can
  read would let it mint a token for any session; a daemon restart invalidates every token instead,
  and each chat's next spawn (its `claude` child dies with the daemon) issues a new one.
- **Stable across the per-turn respawn.** `mint` is a pure function of key, claims and epoch, so a
  respawn with the same binding hands back the same string. A changed binding mints a new token and
  the old one stops verifying (`verify` compares the token's claims with the latest mint's). Only
  the canonical spelling verifies (an epoch of `+0` or `00` is refused), so a cache keyed on the
  token string sees one key per token.
- **A settings change takes effect at the next launch, not mid-turn.** A binding is read when the
  chat's child is spawned, and every turn spawns one, so editing `broker_services` reaches a chat
  at its next turn. Cutting a running turn off at once is `revoke`, not a settings edit.
- **Revocation.** `Registry::set_ended_hook` (in `DaemonState::new`) calls `revoke(session)`, which
  bumps the session's epoch and drops its claims. Every close path ends in `mark_ended`. A resume
  mints under the next epoch, so the closed chat's copy never works again.
- **What fails** (each has a test): another session's token (fields edited or a mac spliced on,
  `BadSignature`; a valid token for the wrong channel's session, `verify_for` -> `WrongSession`), a
  revoked or superseded token (`Revoked`), a token from another daemon key, the daemon's
  `remote-access-token.txt` / `remote-access.json` contents, and any malformed string. A front tells
  the chat only `TokenError::message()`, never which check failed.
- **Never printed.** `BrokerToken` has no `Display` and a redacted `Debug`; `expose()` is called
  once, in `broker_env::apply` (`spawn.rs` only passes the token to it), to set the env var, and a
  test fails if `spawn.rs` or `broker_env.rs` logs it, formats the command, or reads it a second time.
  Spawn logs no env. The token does appear in the child's own process env, so a Bash call that prints
  `env` shows it to the model: that is the plan's stated limit.
- **Known limit: same-user processes.** An env var is readable by any process of the same OS user
  (`/proc/<pid>/environ`, `ps eww`, a PEB read on Windows), and `list_peers` hands every chat the
  pids of the others. A chat with a shell can therefore lift another chat's token. Scoping stops a
  chat from reaching a service by mistake or by a model's own initiative; it is not a boundary
  against a hostile shell on the same account, the same as the daemon's own data files. Closing it
  needs a per-process channel (a handle or pipe handed to the child), which is not built.

**Binding (`ProjectConfig.broker_services: Option<Vec<String>>`, `#[serde(default)]`).**

- Absent resolves at read time to the project's tracker (`tickets::effective_tracker`: the stored
  tracker, else the git remote) plus `figma`, and is never written back, so a later tracker change
  follows. A present list is exactly that set; `[]` binds nothing. Unknown names are dropped.
- It applies to every chat `spawn_session` starts. A hidden sub copies the claims its parent was last
  launched with (`broker_sessions.current(parent)`), so while the parent's claims are live a binding
  Joe widened since cannot give a sub more than its main chat holds. With no live claims (the daemon restarted, or the parent is on
  another machine) it resolves from the root main chat's folder (walked up `subchat_of`, at most 8
  hops, because a sub works in a worktree outside any project); a parent the registry does not know
  falls back to the sub's own folder. Autopilot is a flag on a chat, not a role, so an autopilot chat
  resolves from the project.
- The role in the token is `chat` or `sub`; it is part of the mac but the engine does not branch on it
  yet.
- `SessionClaims::request` builds a `BrokerRequest` carrying the session id and the bound set
  (`bound_services`). `Engine::call` checks it right after the service name parses: an unbound service
  returns `service_not_bound` with a hint holding the whole list to store
  (`"broker_services": ["figma", "linear", "shortcut"]`), writes an audit line with outcome
  `denied_scope`, reads no secret, and raises no card. A request with `bound_services: None` is
  unscoped and only in-process code may build one.
- A front must build every chat-originated request through `SessionClaims::request` after
  `BrokerSessions::verify` (HTTP front, token from the env) or `verify_for` / `current` (a channel
  that already knows the session id, such as the MCP child's `CC_SESSION_ID`).

### Not built in step 4 (and why)

- **No Settings UI for `broker_services`.** The field is stored and read, but the app loads
  `settings.json` once and the next UI save writes its in-memory copy over the file, so a hand edit
  counts only with the app closed (the hint prints the exact line). A UI belongs with step 7's cards.
- **The MCP child does not get the token.** `CC_BROKER_TOKEN` is in the `claude` child's env only;
  the MCP tools (step 5) know the session from `CC_SESSION_ID` and read the bound set with
  `broker_sessions.current(session_id)`, so the token never needs to sit in the MCP config file on
  disk.
- **No daemon-wide `Engine` yet.** Built in step 5 (`DaemonState::broker_engine()`, see "MCP front").
- **Sessions the daemon does not spawn** (an external terminal chat, an adopted one) have no token and
  so no broker access.
- **Epochs are kept for every closed session** until restart (one small entry each).
- **Mint is not tied to the row being open.** `mark_ended` fires the revoke hook only on its first
  flip, and `spawn_session` mints after its MCP probes. A chat closed inside that window would end
  up with a live token for an ended row until the daemon restarts (the child is already an orphan
  of the same race, which exists without the broker). The reverse order, a late end hook landing
  between a resume's mint and its reopen, kills a fresh token; the next turn's spawn mints again.
- **`bound_services: None` is an unscoped request.** `BrokerRequest::new` leaves it unset (the
  engine tests use it), so the daemon's one engine must be built with `Engine::require_scope()`,
  which refuses such a request (`no_scope`); step 5 does that where it constructs the engine.

## MCP front (`front.rs`, `mcp/tool_schemas_broker.rs`, `hooks_server/api_broker.rs`, step 5)

`api_read` and `api_write` are tools of the `cc_conductor` MCP server, listed for every chat. The
path of a call:

```text
model -> mcp/dispatch_broker.rs (adds the MCP child's own session_id and the tool name, over any the model wrote)
      -> POST /hooks/api-broker (loopback hooks server, origin_guard)
      -> broker_sessions.current(session_id) -> SessionClaims   (none: "no scope for this chat", no engine built)
      -> front::run -> claims.request(..) -> Engine::call (spawned detached) -> shaped, masked result
```

- **Scope.** The session comes from the channel (`CC_SESSION_ID` of the MCP child), never from an
  argument; the claims are the ones minted at the chat's launch (a sub's are its parent's). The
  engine is the daemon's one, `DaemonState::broker_engine()`, built on first use by
  `front::daemon_engine(data_dir)` with `require_scope()`: real hosts, `SystemSecrets`, `FilePolicy`,
  `<data_dir>/broker-audit.jsonl`.
- **Arguments.** `service`, `path` (relative; Linear defaults to `/graphql`), `method`, `body` (JSON,
  or a string holding JSON). There is no host, header, credential or `out_file` field. `api_read`
  defaults to GET; `api_write` needs a `method` (Linear defaults to POST).
- **Read versus write is the tool's contract**, because the `~/.claude` hooks (plan step 7) match
  `api_write`. `api_read` sends only a GET, a Linear document `graphql.rs` classifies as a query, or a
  Shortcut POST search (`/api/v3/search`, `/api/v3/search/<kind>`, `/api/v3/<collection>/search`); any
  other call is refused with "send it with api_write". `api_write` refuses a GET ("send it with
  api_read") so a read never pays a write's hook checks. The policy still decides every call: a
  Shortcut search needs its seed row.
- **Pretrusted.** Both names are in `PRETRUSTED_TOOLS` (`daemon/claude_config/args.rs`): the broker
  is their permission layer (scope, policy rows, ownership, audit), and an unattended chat cannot
  answer a generic card. A test lists the names and the count.
- **Results.** Success is `{ok:true, status, body, headers?}`: `body` is the masked response text, never
  parsed (parsing JSON would decode escapes back into a form the masker never saw), cut at 200,000
  bytes with `truncated:true`; only `content-type`, `location`, `retry-after`,
  `link` and two rate-limit headers come back. An upstream 4xx or 5xx is `{ok:false, status, error}`
  with the status, a `retry-after` value if the service sent one, and up to 4,000 bytes of the (masked)
  body in `error`, because the relay shows a chat only `error`. A refusal is `{ok:false, code, error}` where `error` is
  `<code>: <message>. <hint>`: the hint is the exact `broker-policy.json` row to add, or the
  `"broker_services": [...]` line. A chat passes that line to Joe; it never asks him for a token.
- **No secret in a result.** The engine masks the body, every header, errors and hints before `front`
  sees them; `front` adds only its own refusals, built from the model's own arguments. The route logs
  no arguments and a denial is never written to `rejected-sends.jsonl` (it is expected control flow).
- **Transport.** `TRANSPORT_TABLE` has no broker row on purpose (desktop-pipe only, comment at the end
  of the table): the tools are not an RPC, so a phone token or a paired machine cannot name a session
  of its own. A phone-driven chat on this PC and a mirrored chat on its host each use the broker of
  the machine its `claude` process runs on. `broker_tools_are_desktop_pipe_only` fails if a row named
  `api_*` or containing `broker` appears.

### Known limits and not built in step 5

- **The route trusts the session id the MCP child sends**, as every hooks route does. A same-user
  process can POST another chat's id to `/hooks/api-broker` and get that chat's authority, the same
  same-user limit as the env token (see Session scope). The HTTP front (step 6) is the path that
  takes a token.
- **A read-only sub can still call `api_write`.** Both tools are pretrusted and the engine ignores the
  role, so a sub whose brief says `writes:false` (blocked only from Edit/Write by
  `subchat_write_guard`) can write through a policy row on its parent's bound services. The plan
  scopes the broker to every session kind, so this is by spec; a hook in `~/.claude` keyed on the tool
  name is the place to narrow it.
- **No `out_file`** (step 6): a binary or very large body comes back as lossy text or cut.
- **`api_read`'s POST reads are a short list in code** (Linear queries, Shortcut searches). A new
  service with a read-by-POST needs a line in `front::require_read` and a test; until then it is
  refused with "send it with api_write", which is safe and visible, not silent.
- **A write that may have been applied is never retried** by the front: the engine's hint says so and
  the tool description repeats it.
- **No Hubstaff-specific result shaping, pagination helper or retry**: a chat pages through `link`
  or the body's own cursor.
- **Counting denials for the friction counter** (plan step 8) reads `broker-audit.jsonl`'s
  `denied_*` outcomes; nothing aggregates them yet.

## Broker store and key names (`api_keys.rs`)

- `broker-secrets.json` in the data dir holds `name -> protected form` (`secret_store::protect_strict`).
  A missing file is an empty store; a corrupt one is an error and is never overwritten.
- `FIGMA_TOKEN`, `CLOCKIFY_API_KEY` and `HUBSTAFF_REFRESH_TOKEN` are registry rows (names from the
  `~/.claude` skills that read them today).
- `TRELLO_API_KEY` also reads as `TRELLO_KEY` (what the `.env` carries): `api_keys::read_env_value`
  tries both, `is_key_set` and `tickets` use it, and `set_key` replaces an aliased line in place.

## Rules to lift into CLAUDE.md (step 9)

- Every broker call goes through `broker::engine::Engine::call`. A front never builds a URL, reads a
  secret or sets an auth header itself, and a new service is a row in `services.rs`, not a new path.
- A write the engine cannot attach a named target to is refused when its row says `require_owner`.
  Linear writes are admitted only in the shape `graphql.rs` accepts; widen the reader, not the policy.

- Broker output (bodies, headers, errors, `out_file` text) goes through `broker::mask::Masker`
  before it is returned or written, and the masker matches exact values only, never by shape.
- A chat reaches the broker only with its own `CC_BROKER_TOKEN`, checked by
  `BrokerSessions::verify` (never the daemon's token file or the session id alone), and every
  chat-originated request is built by `SessionClaims::request` so the engine can refuse an unbound
  service. A hidden sub gets its parent's `broker_services`; the token is never logged or printed
  (`BrokerToken::expose` has one caller, `broker_env::apply`). The stdio MCP front is the one
  exception to "token only": it trusts its own channel, never a session id in a request body.
- `api_read` / `api_write` (and any later front) answer with `ok:false` and the exact row or binding line
  for a denial, never a card; both stay in `PRETRUSTED_TOOLS`, and a broker method never gets a
  `TRANSPORT_TABLE` row (the tools are not an RPC). `api_read` sends only a read (GET, a Linear query,
  a Shortcut POST search), because the `~/.claude` hooks key on the tool name.
- A new secret form (a new encoding a service is seen to echo) is added to
  `secret_store::encoded_variants` or `mask::extra_variants` with a test, never as a regex.
