# API token broker

Spec: `docs/api-broker-plan.md`. Built one numbered step at a time; this file grew with each step.
CLAUDE.md carries a short rule for it; the full text it was trimmed from is at the end under "CLAUDE.md entry".

Code: `src-tauri/src/daemon/broker/`. Stored-secret wrapping: `src-tauri/src/util/secret_store.rs`.

Read before editing any of it.

## What it is

The daemon makes authenticated calls to Shortcut, Linear, Trello, Figma, Clockify and Hubstaff
for a chat, so the chat never reads or sees a token. A chat names a service and a relative path;
the daemon adds the host and the secret, checks the call against a scope, a policy and (for
writes) an ownership rule, masks every byte that comes back, and appends one audit line. A denial
is an `ok:false` answer that names the exact line Joe adds, never a permission card.

## Honest limits (read before relying on it)

- **At rest is not a boundary against code running as Joe.** DPAPI (Windows) and the Keychain
  (macOS) protect a stored token against a file read, a copy of the data folder and a backup. They
  do not stop any process of the same OS user. The boundary against the model is only that no token
  appears in model-readable output (masking), plus scoped authority over what a chat may do with it.
- **A chat with a shell can lift its own session token.** `CC_BROKER_TOKEN` sits in the `claude`
  child's env, so `env`, `ps eww` or a PEB read shows it. That gives the chat its own session's
  authority and nothing more (audited), the same authority the MCP tools already grant. It can
  also lift another chat's token, because `list_peers` hands out pids and an env var is readable
  by any same-user process; scoping stops a chat reaching a service by mistake or on a model's own
  initiative, not a hostile shell on the same account.
- **A same-user process can also** POST another chat's id to `/hooks/api-broker`, open the desktop
  pipe and call `respond_broker_card`, or edit `broker-policy.json`. The desktop pipe is the trust
  boundary for the cards.
- **Masking matches exact values in listed encodings.** A secret a service re-encodes into
  an unlisted form (a hash, double base64, a value split over two fields) is not masked. See
  "Not covered" under the masker. Binary downloads are the one deliberately unmasked path.
- **The data-carry rule is a speed bump, not a wall.** It catches an injected "copy this text into
  another service" only when 40 or more characters repeat unchanged across services.
- **Nothing here is proven against a real `claude` CLI or a real phone**: see "Gaps, by name".
- **Deleting `~/.claude/.env` is a later, separate step** (G3). Until then the broker falls back
  to `.env` when the store has no entry, so a plaintext copy still exists on disk.

## File map

| Path | Role |
|---|---|
| `daemon/broker/engine.rs` | `Engine::call`, the one entry point; `require_scope`; `forget_service` |
| `daemon/broker/services.rs` | `Service`, `ServiceTable::production`, auth shapes, `DOWNLOAD_PATHS` |
| `daemon/broker/guards.rs`, `graphql.rs`, `ownership.rs` | request rules, Linear reader, owner rules |
| `daemon/broker/policy.rs`, `policy_rules.rs`, `policy_file.rs`, `broker-policy-seed.json` | policy trait, rows, `FilePolicy`, seed |
| `daemon/broker/carry.rs` | data-carry tracker |
| `daemon/broker/mask.rs` | `Masker`, `MaskStream` |
| `daemon/broker/store.rs` | `SecretSource`, `SystemSecrets` |
| `daemon/broker/audit.rs`, `friction.rs` | audit JSONL, friction report |
| `daemon/broker/session.rs`, `binding.rs`, `daemon/lifecycle/broker_env.rs` | token mint/verify/revoke, bound set, spawn env |
| `daemon/broker/front.rs`, `out_file.rs` | shared front logic (`run`, `run_script`, `daemon_engine`), `out_file` confinement |
| `daemon/broker/cards.rs`, `card_ops.rs` | the three cards and what approval applies |
| `daemon/hooks_server/api_broker.rs`, `api_broker_http.rs`, `api_broker_card.rs` | routes: MCP relay, script front, `api_card` |
| `daemon/methods/broker_card.rs`, `broker_friction.rs` | RPCs `respond_broker_card`, `broker_friction` |
| `mcp/tool_schemas_broker.rs`, `mcp/dispatch_broker.rs` | tools `api_read`, `api_write`, `api_card` |
| `api_keys.rs`, `util/secret_store.rs` | key registry and broker store; protected wrapping and encoded variants |
| `scripts/cc-api/`, `scripts/broker-seed-scan.mjs`, `scripts/broker-gate0.mjs` | script clients, seed scan, live Gate 0 rig |

## Request flow

```text
chat -> api_read | api_write (MCP, session from CC_SESSION_ID)   or   cc_api.py|mjs (Bearer CC_BROKER_TOKEN)
     -> /hooks/api-broker  or  /hooks/api-broker-http  (loopback hooks server)
     -> SessionClaims (bound services)  -> front::run | front::run_script
     -> Engine::call: service known? bound? -> guards -> (Linear) graphql
        -> Policy::decide (+ carry_from) -> read secret -> (require_owner) ownership
        -> send, no redirects -> mask -> audit line -> shaped answer (or out_file)
```

`DaemonState::broker_engine()` builds the one engine on first use. The MCP and script routes
spawn the call detached (the engine is not cancel-safe).

## Masker (`broker/mask.rs`, step 2)

Every broker result passes through a `Masker` before it leaves the daemon: response bodies,
header values, error strings, `Location` values and `out_file` text. The engine builds one per
call from the called service's secrets AND every other secret in the store (`Engine::stored_secret_values`),
because a response can quote another service's token (Joe's Linear key pasted into a Shortcut story).
The stored values are read once per two minutes (a Settings-page or `.env` edit shows up within that) and
dropped at once when an add/replace/import card stores a token (`forget_service`).

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
| `guards.rs` | relative paths only, prefix per service, no dot or encoded-separator segments, credential-named query params refused (and Trello's own `key`/`token`), method-override query params refused (`_method`, `x-http-method-override`, `x-http-method`, `x-method-override`, any case, percent-decoded first, pairs split on `&` and `;`: the policy matches the path without its query and a GET is always open), only `accept` and `content-type` headers pass (host-override and credential headers refused by name), request and response caps, methods GET POST PUT PATCH DELETE. `build_url` re-proves the final URL has the table's host. |
| `graphql.rs` | Linear's narrow reader: a `query` (or `{}`) is a read; a write is one `mutation` with one root field, no alias or directive, every argument a `$variable`. Anything else is `Unsupported` and refused. |
| `ownership.rs` | Pure rules: Shortcut story/epic target from the path, owned when Joe is in `owner_ids` or is `requested_by_id`; Linear target from the variables per named operation (`commentCreate` -> `input.issueId`, and only when the input holds nothing but `body`, `bodyData` and `issueId`, because `parentId`, `projectUpdateId` and the like name another target; `issueUpdate` -> `id`), owned when Joe is `creator` or `assignee`. No target means not owned. |
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
- **Masking is built from every secret the call carried** and every other stored secret (see "Masker"),
  including the Hubstaff access token and rotated refresh token (also in another service's response), and runs over the status line's headers (names and values), the body, every
  error message and hint, and the audited path. The other stored secrets are read once per 120 seconds and
  reused; a card that stores a token and a rotated refresh token clear them at once, a read that began before
  that clear never writes its older answer back, and a read that failed is never cached (a store that stays
  unreadable is read again on every call). The Hubstaff access and refresh tokens are mirrored in a plain
  mutex (`memory_secrets`), so a call to another service never waits on a Hubstaff refresh. A token added by hand
  (Settings, an edited `.env`) goes unmasked for those 120 seconds at most.
- **Ownership fails closed.** A lookup that errors, a path or operation with no nameable target, and
  a service with no owner rule are all refusals.
- **Audit failure does not lose the result.** The call has already happened; the response carries
  `audit_failed: true` and the error is logged.
- A policy `Deny` carries a `hint` (the exact line to add), returned verbatim.

### Not built in 3a (and why)

- The policy file, hot reload and seed: built in 3b (see "Policy" below). The engine only knows `trait Policy`.
- Session binding (`broker_services`), the HMAC session token and `spawn.rs` injection (built in step 4, see "Session scope").
- Anything that reads the engine's output into a front: MCP tools (5), HTTP loopback and `out_file` (6).
  `BrokerResponse.raw` carries a binary download for step 6; every other body is lossy UTF-8 text.
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
  name is the place to narrow it. (`out_file` is the exception: the HTTP front refuses it for a read-only
  sub, see below.)
- **No `out_file` on the MCP tools** (on purpose): a chat that needs a file or a large body goes through
  the HTTP front below (`cc_api` with `-o`), because a path the model names is written by the daemon and
  belongs behind the session token.
- **`api_read`'s POST reads are a short list in code** (Linear queries, Shortcut searches). A new
  service with a read-by-POST needs a line in `front::require_read` and a test; until then it is
  refused with "send it with api_write", which is safe and visible, not silent.
- **A write that may have been applied is never retried** by the front: the engine's hint says so, a
  5xx answer to an `api_write` call carries the same cue in its error text, and the tool description
  repeats it.
- **A repeated response header keeps its last value** (`headers` is a map keyed by lowercase name), so
  several `Link` headers collapse to one; a chat pages through the body's own cursor instead.
- **No Hubstaff-specific result shaping, pagination helper or retry**: a chat pages through `link`
  or the body's own cursor.
- **Counting denials for the friction counter** (plan step 8) reads `broker-audit.jsonl`'s
  `denied_*` outcomes; step 8b built it (see "Gate 0 and the friction counter").

## HTTP front for scripts and hooks (`hooks_server/api_broker_http.rs`, `broker/out_file.rs`, `scripts/cc-api/`, step 6)

For code that is not the model's MCP tool: a skill's script, a `~/.claude` hook, a build step. It reaches
the same engine through the same `front` module as the MCP tools, so every rule above (scope, policy,
ownership, masking, audit) holds unchanged.

```text
script -> scripts/cc-api/cc_api.py | cc_api.mjs   (reads CC_BROKER_TOKEN + CC_BROKER_URL, prints the masked JSON answer)
       -> POST $CC_BROKER_URL/hooks/api-broker-http   Authorization: Bearer <CC_BROKER_TOKEN>
       -> BrokerSessions::verify(token) -> SessionClaims   (any failure: 401, no engine work)
       -> front::run_script -> claims.request(..) -> Engine::call (spawned detached) -> answer, or out_file
```

- **Client.** `scripts/cc-api/cc_api.py` and `cc_api.mjs` (about 30 lines each, tests in
  `cc_api.test.mjs`, run with `node --test scripts/cc-api/cc_api.test.mjs`). Usage:
  `cc_api.py SERVICE PATH [-X METHOD] [-d JSON|@file] [-o OUT_FILE] [--download]`. They read two env vars the
  daemon sets on every chat's `claude` child (`broker_env::apply`): `CC_BROKER_TOKEN` and `CC_BROKER_URL`
  (`http://127.0.0.1:<hooks port>`, the instance's own port, an address and not a credential). They print
  the broker's JSON answer and nothing else, exit 1 when `ok` is false, send no proxy (the token goes only to
  loopback), and never print the token, including in an error. The mjs also exports `call(service, path, opts)`.
- **Auth is the session token and nothing else.** `Authorization: Bearer <CC_BROKER_TOKEN>` verified by
  `BrokerSessions::verify`. A missing, malformed, tampered, other-daemon or revoked token, the daemon's own
  `remote-access-token.txt`, a bare session id and a `session_id` in the body all get a 401 with one fixed
  message and no engine call; a `session_id` in the body is ignored when the token is good, and the audit
  names the token's session. (A body that is not JSON at all is rejected by the shared `ValidatedJson`
  extractor before the token is read: a 200 `ok:false` decode answer logged in `rejected-sends.jsonl`, never an
  engine call.) The route sits on the loopback hooks server (`origin_guard`: `Host` is
  127.0.0.1 or localhost, no `Origin`).
- **Not reachable from a phone or a peer machine.** The remote server (`remote_server.rs`), the only one
  those transports reach, mounts no `/hooks` route, and `TRANSPORT_TABLE` has no broker row (the route is not an
  RPC method). Two tests hold it: the transport table test lists `api_broker_http` and `cc_api` among the
  names that must stay absent, and `the_remote_server_mounts_no_hooks_route_and_never_names_this_one` scans the
  remote server's sources. A phone-driven chat on this PC runs its `claude` here and uses this machine's broker.
- **Read or write is decided by the call.** A script names no tool: a GET, a Linear query and a Shortcut POST
  search are reads (`front::require_read`), everything else a write, which only changes the "may have applied"
  cue on a 5xx. The `~/.claude` guards key on the `cc_api` command string.
- **Body fields:** `service`, `path`, `method` (GET by default, POST for Linear), `body`, `out_file`,
  `download`. No host, header or credential field, as everywhere.

### `out_file`

`out_file` makes the daemon write the response to a file; the answer then carries `out_file` (the path as
written) and `bytes` instead of `body`, and the `[MASKED]` text is whatever the engine produced. Confinement
(`out_file.rs`, each rule has a test):

- **Roots:** the chat's own folder (its project folder, or a sub's worktree) and one folder of the OS temp dir
  that is the chat's alone, `<temp>/cc-api/<session id>` (`OutTarget::for_session`; the daemon creates that one
  folder, an id's capital letters and odd characters become `%xx`, so ids that differ by case never share a
  folder; a folder that is not where its name says, a link or junction planted at `cc-api` or at the chat's
  folder, gives no temp root, and `resolve` checks it again at write time, so a link swapped in during the
  upstream call moves no write, short of the few-line swap window the module's "Not covered" note names; `cc-api` is checked before the chat's folder is created in it). The bare
  temp dir is no root: another chat's temp files, and
  anything else a program keeps there, cannot be overwritten. A relative path is relative to the chat's folder;
  with the folder unknown only the temp folder is open. A refusal names the chat's own temp folder, so a
  script that wrote to `/tmp/x.json` learns where to write. A chat whose folder is the user's home, a folder
  above it or a drive root gets only the temp folder (everything under those would be a destination).
- **A read-only sub gets no `out_file`:** a sub whose brief says `writes: false` is refused before the call
  (`front::is_read_only_sub`), because the daemon writes the file itself and the sub's write guard never sees
  it, and before the chat's temp folder is made. The test reads the brief alone: the Edit/Write guard also asks
  the registry and the one-writer slot, so a writing sub still queued for the slot can write a file here. A
  chat whose brief cannot be read is not a read-only sub (the same fail-open the brief lookup has everywhere),
  and the lookup is a small synchronous file read per `out_file` call. A writing sub, a gate and a plain chat
  are unaffected.
- **The folder is resolved, not the text:** the parent is canonicalized (symlinks and junctions followed) and
  must sit under a canonicalized root, so `..`, a link pointing out, and an absolute path elsewhere fail the same
  check; a `..` in the text is refused as well. The parent must already exist (the daemon creates no folders).
- **The file is never followed:** an existing symlink, folder or special file at the name is refused, and the
  bytes go to a temp file in the same folder that is renamed over the name.
- **Never a destination, even inside a root:** a `.git` or `.claude` folder anywhere on the canonical parent
  path (a chat whose own folder is a `.claude` folder, the `~/.claude` project, gets no `hooks/x.py` or
  `settings.json` either; the one exception is a sub's worktree, `<repo>/.claude/worktrees/<id>`, and only
  when the root itself sits inside it, so a root of the `.claude` folder cannot reach `worktrees/<id>/...`;
  a worktree made inside another worktree has two such pairs and both are exempt; a sub of the `~/.claude`
  repo works in `~/.claude/.claude/worktrees/<id>`, whose outer `.claude` has no `worktrees` after it, so its
  `out_file` is refused: a named limit that fails closed, as does a temp dir below a `.claude` folder),
  a `.env*` file, the daemon's data
  folder (`broker-policy.json`, `broker-secrets.json`), and on Windows a device name, a colon, a trailing dot,
  any name holding `~<digit>` (it may be a short name: `GIT~1` is `.git`; `backup~2.json` is refused too), a network (UNC) path and a verbatim or device path. An existing
  file is also judged by its canonical name.
- The path is checked before the call goes out (a bad path never spends a write) and again at write time.
- **Text is masked:** the full masked body (the chat-context cut at 200,000 bytes does not apply) goes in the file.
  Only a 2xx answer writes a file: a 4xx or 5xx comes back as the usual `ok:false` error, and a redirect
  (never followed) or 304 as `ok:false` saying so, with the `Location` not echoed (often a signed URL). On a
  write the error carries the same "may have been applied, check before retrying" cue as a 5xx.
- **Binary is `download: true`,** and the engine refuses it unless the call is a GET on a path in
  `services::DOWNLOAD_PATHS` (`not_a_download_path`, with the list in the hint, before the policy and before any
  secret read). A 2xx answer then goes to the file as raw bytes, unmasked, and the audit line has
  `"unmasked": true` (the only way that flag is ever set); the answer says `unmasked: true`. An error answer to a
  download is masked text and writes nothing. `download` without `out_file` is refused.

### Known limits and not built in step 6

- **Same-user limit, again.** `CC_BROKER_TOKEN` sits in the `claude` child's env, so a shell the model runs can
  read it and call this route: it gets its own session's authority, audited, which is the MCP tool's authority.
  A process of the same user swapping a folder for a link between `out_file`'s check and its rename can still win
  that race; the same process could write the file directly.
- **A chat's temp folder is never cleaned up** by the daemon (`<temp>/cc-api/<session id>` stays until the OS
  clears the temp dir), and a chat can still write anywhere in its own folder, a sibling file of another
  chat's project included only if that is its own folder. Narrowing the temp root broke no client: the only
  `cc_api` consumers when this was written are the scripts' own tests, and a refusal names the folder to use.
  A read-only sub is told to read without `out_file`; the check reads the sub's brief only, so a chat with no
  brief (not a sub) is never refused.
- **One named download path, UNVERIFIED live.** `DOWNLOAD_PATHS` holds only Trello's attachment download
  (`/1/cards/*/attachments/*/download/*`), taken from Trello's documented attachment API, not from the
  transcript scan; it is the only binary endpoint on the six services' API hosts that is known. No download
  was run against api.trello.com, and Trello's
  newer attachment URLs may want a header the engine's query auth does not send. Figma image export, Shortcut
  files and Hubstaff screenshots are believed (UNVERIFIED) to answer with a URL on another host, which the
  engine never follows, so none is a download row here. A new download endpoint is one row and one test.
- **No audit field for `out_file`.** The audit line records the call and `unmasked`, not the file path (a path is
  the chat's choice, and the audit is about what left the daemon).
- **The `~/.claude` hooks (plan step 7, G1) are not part of this repo's step.** They match the `cc_api` command
  string and `api_write`.
- **No streaming and no upload:** a response is read whole under the engine's size cap, and a request body is
  JSON only.
- **A same-name file is replaced** (a regular one). A script that must not overwrite checks first.

## Cards: import, add/replace, policy edit (`broker/cards.rs`, `card_ops.rs`, step 7)

Three cards only Joe can answer. A chat asks with the `api_card` MCP tool
(`kind` import | replace | policy; `hooks_server/api_broker_card.rs`); the daemon builds the card from what it
reads itself, raises it through `subchats::cards::raise_card_with`, and returns at once (the chat retries after Joe
answers). The tool has no field for a value, a token or a row.

| Card | What the daemon builds | What approval does | Audit line |
|---|---|---|---|
| import (`broker_import`) | the rows of `api_keys::REGISTRY` against `~/.claude/.env` and the store: copy, kept (already stored, never replaced), missing, PC only; `TRELLO_API_KEY` is read from `TRELLO_KEY` | copies the `copy` rows into the protected store (strict on Mac); `.env` is left as it is; no value is ever returned | `CARD import`, `card_import` |
| add/replace (`broker_replace`) | one registry name, its label and purpose, whether it is stored, this machine and its store | the pasted value goes `respond_broker_card` -> `card_ops::replace_secret` -> `api_keys::set_broker_secret`, then `Engine::forget_service` drops the cached token | `CARD replace`, `card_replace` |
| policy (`broker_policy`) | the exact row `card_ops::propose_row` makes for the denied call; no card when the policy already allows it, the service is not bound to the asker, the asker has no claims at all (a daemon restart empties them until the chat relaunches, and a forged id never had any: refused, never passed), or no row can allow it | `policy_file::add_row` (the one write function) appends that row; an identical row is `added:false` | `CARD policy`, `card_policy` |

A decline is `card_declined`, a store or write that failed is `card_failed` (the card stays open so Joe can retry).
Each line names the asking chat (a sub's own id, not the main chat that shows it), the card's path and no value.
Hubstaff is PC-only (DPAPI): the Mac refuses the replace card and the import marks it `pc_only`.

### What makes it Joe-only (each has a test)

- A raised card is an ordinary `question-requested` prompt with `daemon_card: true`, `card_kind` and a `broker_card`
  body, so the ring, the push and the parked store work. Every path that answers a question refuses it:
  `respond_question_as` returns false for a broker card (skip, answer, the when-done marker and the auto-answer
  alike) and `settle_answered_questions` leaves it alone.
- The only answer is the `respond_broker_card` RPC, on the **local desktop pipe**: it has no `TRANSPORT_TABLE` row
  and also checks `ctx.transport`, so a phone or a paired machine gets `method_not_found`.
  `list_pending_prompts` hides a broker card from every non-local transport (mirrored prompts included), and the
  remote WS global pump skips a `question_request` frame whose params are a broker payload.
- The pasted token lives in the card's input and in the `value` of one `respond_broker_card` call. It is never in a
  prompt payload, a question answer, the decisions log, the audit log or an error string; the frontend wrapper
  never logs it and clears the input the moment the call settles. A malformed `respond_broker_card` call (a type
  mismatch, a bad action) gets a fixed error text, never serde's, because serde quotes the string that did not
  fit and that can be the pasted value (`respond_from_params`).
- `cards.rs` takes a card out of its registry before applying it and puts it back when the apply fails, so a double
  answer cannot apply twice. At most three broker cards are open per chat; the same ask while one is open returns that card.
- A broker store write takes `BROKER_STORE_LOCK`, so an import and a replace never interleave their read-modify-write.

### Known limits and not built in step 7

- **Same-user limit, again.** `respond_broker_card` is as reachable as `respond_secret`: a process of Joe's own user
  (a chat's Bash tool included) could open the desktop pipe, or edit `broker-policy.json`, directly. The cards
  stop the model's tools, not a same-user process; the desktop pipe is the trust boundary for both.
- **A respawned main chat keeps its old key in the dedupe.** `Open.display` is the chat that showed the card when it
  was raised; after the main chat respawns, a new ask for the same card can raise a second one and the cap counts
  against the old id. Joe answers the extra card, nothing applies twice.
- **A card's registry entry stays while its answer applies**, marked busy: a second answer gets "this card is being
  answered", and a call dropped mid-way clears the mark, so the card still answers. A reserved slot for a card
  being raised is freed by a drop guard; a second ask for the same card meanwhile is told to retry.
  An ask for a card that is mid-answer is told to retry too, never "already open". A broker prompt left with no
  entry (an answer or a raise cut off at the wrong moment) is taken down by the next answer, which says "already
  closed". Known limit: the store write runs on a blocking thread that outlives a dropped answer call, so a retry
  in that moment can apply a second time.
- **Raised cards are not persisted** across a daemon restart (the sub-chat cards are the same); the chat asks again.
- **No Settings entry for import or replace yet**, and no phone path: the phone and a peer never see these cards.
- **Escape folds the card, never declines it.** Declining a token is a click.
- A card shows the asking chat as a face only for a sub or a main chat in subchats mode (the shared `askerFaceOf`).

## Canary, injection and scope tests, and the data-carry rule (step 8a)

Tests: `daemon/hooks_server/broker_rig.rs` (the rig), `broker_canary_tests.rs`, `broker_injection_tests.rs`,
`broker_scope_regression_tests.rs`. Rule: `broker/carry.rs`, `carry_from` in `policy_rules.rs`.

### The rig is an in-process "private daemon"

One real `DaemonState`, the real routes (`on_api_broker`, `on_api_broker_http`), the real `FilePolicy` and
`AuditLog`, under a throwaway `CC_DATA_DIR` (`TempDataDir`, which also holds the env lock), with a mockito server
standing in for the six services. It is not a spawned daemon process on purpose: the production engine pins the real
service hosts (a host override env var would be a way to send a token anywhere), so a process cannot be pointed at a
mock without adding that hole. `CC_DAEMON_INSTANCE` is not set (it is process-global and would leak into parallel
tests); the data dir never is the live one. The MCP side runs the real `tools/call` routing
(`mcp::dispatch_for_test`) and relays to the real route handler.

**The session JSONL is modelled.** The daemon never writes the model's tool results: the `claude` child writes its own
transcript. The rig appends every answer it hands back (both fronts) to a `session.jsonl` in the chat's folder as a
`tool_result` line, then scans that file, every file under the data dir and the chat's folder (`out_file`s included)
for the canary in raw, form-encoded, `%20`, base64 (std and url-safe), JSON-escaped, `\/`-escaped and hex form. A
positive control (`[MASKED]` is found) proves the scan reads those sinks. What the daemon itself writes
(`broker-audit.jsonl`, `rejected-sends.jsonl`) is inside that scan.

### The data-carry rule

A page, ticket or file a chat reads can tell the model to copy it into another service. The policy row for a
comment is the same whatever the comment says, so the engine remembers what each chat's reads answered
(`CarryTracker`, owned by `Engine`) and a write that repeats it is held to `carry_from`.

- Recorded: the string values of a 2xx read answer or Shortcut search answer (JSON parsed, else the whole text), after
  masking, and the text of a UTF-8 download, per chat.
  Normalized (lower case, whitespace collapsed), hashed in windows of 40 characters.
- Checked: only for a write (`!read`; a Shortcut `POST /search` is a write to the engine). The string values of the
  body and the values of the query are windowed the same way; a shared window from a read of ANOTHER service makes
  that service `PolicyRequest::carried`.
- Decided: the rows that allow the call must name every carried service between them in `carry_from`
  (union, like `require_owner`). Otherwise `policy_denied`, with a printed row that has `carry_from` set, so the card
  (`api_card` kind `policy` takes `carry_from`) writes a row that lets the same call through. `same_row` counts
  `carry_from`, so the seed's plain comment row does not swallow the carry row.
- Caps: 200,000 characters of one answer, 200,000 hashes per chat (oldest reads first out), 32 chats (least recently
  used first out), 2 hours.

### Known limits and not built in step 8a

- **Same-service carry is not carry.** Reading a story and commenting on another story is the normal workflow, and a
  rule that blocked it would be turned off at the first card. Only cross-service repeats are held.
- **A value under 40 characters** (an id, a title, a status, an email) never matches. A shorter window would match
  ordinary phrases; a longer one would miss a pasted sentence.
- **Paraphrase, translation and re-encoding** (base64 of a file's text, one character of every word changed) are not
  caught. The rule stops the injected "post this file's text" case, not a model that is trying to evade a hash.
- **Not remembered across a daemon restart**, past two hours, past the caps, or for text beyond the first 200,000
  characters of one answer. A miss means the write runs as the policy row always allowed it.
- **The hash is a plain rolling hash** (not a security boundary): there is no secret key, so the rule is not a defence
  against a model that knows it.
- **`carry_from` on the card is the chat's word.** `api_card` takes the list from the chat; the card shows the row
  line, so Joe sees what he is allowing. The daemon does not derive it from its own tracker.
- **A sub chat has its own session id**, so what a sub read does not count for its parent, and the other way round.
  UNVERIFIED: a resume or respawn that mints a new session id starts with an empty tracker; check
  `spawn_session` before relying on the rule across one.
- **Long ids and URLs in an answer can match.** Any run of 40 or more characters that two services both print (a
  signed URL, a long hash) counts as carried text. UNVERIFIED which real fields hit this; the cost is one denial
  naming the service, and the card adds the row.
- **JSON keys, bare query keys and the path are not scanned**, only string values, and the write side's decoded
  query values.
- **A download is remembered only when its bytes are UTF-8 text** (a `.txt` attachment is; a PNG fails UTF-8 and is not, while an ASCII-only SVG or PDF would be). A text
  file is read by the chat from disk, so it counts as an answer the chat holds.
- **Splitting defeats the match.** A value under 40 characters never matches, so a read made only of short values
  (one checklist item per element) is never remembered, and a write sent as 39-character pieces never matches. This
  falls under "a model that is trying to evade a hash".
- **"Least recently used" means least recently read**: a write does not refresh a chat, and the 2 hours count from
  its last recorded read.
- **Shortcut search answers are remembered** (a POST to the engine, a read to the model); the write side has no
  character budget, so padding a body ahead of the carried text hides nothing.
- **The rig's proof is narrower than its names.** `broker_canary_tests.rs` mock expectations that are not asserted
  only shape the answer, and the "daemon token file" scope test proves that a random bearer is refused, not that
  the daemon's own token file is.
- **The friction counter and the live run were step 8b** (next section).

## Gate 0 and the friction counter (`broker/friction.rs`, `methods/broker_friction.rs`, `scripts/broker-gate0.mjs`, step 8b)

### The friction counter

- **The audit log is the only store.** `broker::friction::report` reads `<data_dir>/broker-audit.jsonl`; nothing is kept
  in memory, so the counts survive a daemon restart. A missing file is an empty report, a line that is not JSON or has
  no readable date is skipped and counted in `skipped_lines`, and `CARD` lines are not calls.
- **What counts as friction:** `denied_policy`, `denied_owner` and `denied_scope`. Each is a call that a policy row, an
  owned object or a binding line would have let through, so each costs Joe a card or an edit. `denied_guard` (an
  absolute path, a path or query the guards refuse, an unknown service, a method outside GET/POST/PUT/PATCH/DELETE, a body that is not JSON) is a malformed call
  no row can allow: it is listed per
  day as `guard_denials` and never added to the count. `upstream_error`, `no_secret` and `error` are not denials.
  The count is by outcome, not by reason: a `denied_owner` from a failed owner lookup (the service was down) or a
  `denied_scope` for a call with no scope (a front wiring bug) counts although no row or binding would fix it; the
  day's audit lines carry the `reason`.
- **The day-7 target: 2 or fewer friction denials per day, from day 7 on.** Day 1 is the UTC date of the first line in
  the audit log; `target_due` is true from day 7. A day over the target means a missing policy row, a missing binding or
  a chat that keeps asking for something it should not, and that day's audit lines say which. `within_target` and a
  day's `over_target` compare the number only, whatever the day number: read them with `target_due`, because before
  day 7 the target does not apply yet. Constants:
  `friction::TARGET_PER_DAY` (2) and `friction::TARGET_DAY` (7), repeated in the report so a reader never guesses them.
- **Days are UTC dates** (the audit `ts` is UTC), so a day turns over at 01:00 or 02:00 in Croatia, not at midnight.
- **`broker_friction` RPC** (desktop pipe only, no `TRANSPORT_TABLE` row, so a phone and a peer machine are refused):
  params `{ "days": 1..=90 }` (14 by default; anything else is `-32602`). The result is `friction::Report`:
  `target_per_day`, `target_day`, `today`, `first_day`, `day_number`, `target_due`, `today_friction`, `within_target`,
  `skipped_lines` and `days` (oldest first, zero days filled in: `date`, `calls`, `friction`, `by_outcome`,
  `guard_denials`, `over_target`). Counts only: no path, session or service name leaves it.

### Gate 0: zero permission cards

"Zero cards" holds for every kind of chat for two reasons, and both are proven.

1. **The `claude` child never asks.** `spawn_session` builds the argv with `claude_config::base_claude_args` in one
   place for every chat (a fresh start, a resume, the per-turn respawn, a hidden sub, an autopilot run, a phone's
   start), and that argv carries `PRETRUSTED_TOOLS`, which names `api_read`, `api_write` and `api_card`. The permission
   relay (the `approval_prompt` MCP tool, `hooks_server/permission.rs`) is the only thing that raises a permission
   card. `broker_gate0_tests.rs` asserts the list in every argv shape, that the base argv sets no permission mode and
   disallows only `AskUserQuestion`, and that `spawn.rs` has exactly one `base_claude_args(` call and adds no
   `--allowedTools`, `--disallowedTools`, `--tools` or permission-mode flag of its own.
2. **The daemon never raises one for a broker call.** A denial is an `ok:false` answer carrying the row or binding
   line, never a card. Two proofs:
   - **In process** (`hooks_server/broker_gate0_tests.rs`, on the step 8a rig): four chats are launched through
     the real `broker_env::mint_for_launch` (a plain chat, a hidden sub of it, and one marked autopilot and one plain
     chat standing for the phone-driven kind), each makes `api_read` calls through the MCP front and the script front
     against a mock service with a canary token, the daemon ends with no open prompt, every audit line is `ok` and
     the friction counter reads 0. A control asks the relay for an unlisted tool and the same check sees that card.
     The engine has no notion of autopilot or of a phone chat, so those two kinds are told apart only by the argv
     test and the live run; the hidden sub is the one kind with its own binding rule, tested on its own.
   - **A live daemon process** (`node scripts/broker-gate0.mjs --daemon <cc-conductor-daemon.exe>`, 29 checks, last
     run 29/29 on 2026-11-18): starts a private daemon (own data dir, own instance label, own remote port) with the
     fake `claude` of `e2e/fixtures/fake-claude` as its CLI, the project bound to Figma only, then drives four chats: an attended chat over the
     desktop pipe, a hidden sub spawned through `/chat/spawn` by a main chat, an autopilot chat (the reply carried
     `<cc-autopilot:on>`), and a chat a phone started and drove over `POST /api/rpc` with the device token (an
     `is_remote` chat). The fake (`broker-probe.cjs`) does what a `claude` child does around a tool call: it reads
     `--allowedTools` from the real argv and sends a tool outside it to the permission relay, and it calls the broker
     through the real MCP child (`--mcp-config`) and through the loopback front with the chat's own
     `CC_BROKER_TOKEN` (presence only is ever recorded). The rig polls `list_pending_prompts` every 100 ms for the
     whole run and passes only when no probe chat ever had a card, a control chat did (so the poll can see one),
     every call reached the engine (20 audit lines) and `broker_friction` reports exactly the 12 friction and 8
     guard denials those calls made. It also checks a phone is refused `broker_friction`.

### Gaps, by name (not proven)

- **The real `claude` CLI honouring `--allowedTools` for an MCP tool in each mode** (default, auto-accept, plan) is
  not verified: the fake applies the rule the code states. Only a billed real run settles it, and the brief did not
  call for one. If a card ever shows for `api_read`, this is the first place to look.
- **The live calls are denials only.** The daemon's secret source falls back to the real `~/.claude/.env`
  (`dirs::home_dir()` ignores `USERPROFILE` on Windows) and the service hosts are pinned, so a private live daemon
  that made a call reaching the secret read would send a real token to a real service. The live rig therefore uses an
  unbound service (`denied_scope`), an absolute URL path (`denied_guard`) and a DELETE no policy row allows
  (`denied_policy`). The success path with canary tokens is the in-process rig's job. Never extend the live rig to a
  call that reaches the secret read.
- **The phone path is `/api/rpc` on a private daemon**, not a real phone: the transport and the `is_remote` flag are
  real, the Android shell and the tunnel are not.
- **Nothing alerts on the target.** The counter is read on demand; there is no UI, no notification and no release
  gate on it. Joe or a later step reads `broker_friction` and acts.
- **A fresh audit log starts the clock.** Deleting `broker-audit.jsonl` restarts "day 1"; a rotated file is not
  followed.

## Broker store and key names (`api_keys.rs`)

- `broker-secrets.json` in the data dir holds `name -> protected form` (`secret_store::protect_strict`).
  A missing file is an empty store; a corrupt one is an error and is never overwritten.
- `FIGMA_TOKEN`, `CLOCKIFY_API_KEY` and `HUBSTAFF_REFRESH_TOKEN` are registry rows (names from the
  `~/.claude` skills that read them today).
- `TRELLO_API_KEY` also reads as `TRELLO_KEY` (what the `.env` carries): `api_keys::read_env_value`
  tries both, `is_key_set` and `tickets` use it, and `set_key` replaces an aliased line in place.

### Store per platform

| Platform | Backend (`secret_store::native_backend`) | At rest | Notes |
|---|---|---|---|
| Windows | `Backend::Dpapi` | `broker-secrets.json` holds `ccsec1:` DPAPI blobs | all six services, Hubstaff included |
| macOS | `Backend::Keychain` | the file holds `cckc1:<name>`; the value is in the Keychain (service `cc-conductor-broker`, hex text, written through `security -i` on stdin so argv never shows it, then read back to prove it) | no plaintext fallback; a refused write is an error that says so; Hubstaff is refused (`can_rotate()` is false, error says "PC only") |
| Linux | `Backend::Unavailable` | nothing | every strict write errors; reads fall back to `.env` only |

Read order is `api_keys::resolve_secret`: broker store first, `.env` second, and a store entry that
exists but will not decrypt is an error, never a quiet fall-through to a stale `.env` copy. A
rotated value (Hubstaff) is written back to the place it was read from (`SecretOrigin`). The
Keychain path is tested through an injected `CommandRunner`; no test touches a real Keychain.

### Audit log (`broker/audit.rs`)

`<data_dir>/broker-audit.jsonl`, append-only, opened per line so rotation or deletion between
calls is safe. One line per call, refusals included:
`ts, session, service, method, path (masked), status, outcome, reason, req_bytes, resp_bytes,
unmasked, get_volume, flags`. `outcome` is one of `ok`, `upstream_error`, `denied_guard`,
`denied_policy`, `denied_owner`, `denied_scope`, `no_secret`, `error`. A card answer writes a
`CARD <kind>` line (`card_import`, `card_replace`, `card_policy`, `card_declined`, `card_failed`).
A GET also carries a rolling per-(session, service) volume and flags `burst` (60 a minute),
`sustained` (600 an hour) and `large_response` (1 MiB); flags annotate, they never block. No
token, header or body is ever written. There is no rotation (see below).

### How to add a service

1. `services.rs`: add a `Service` variant, put it in `Service::ALL` (a fixed-size array, so the
   compiler flags it), `name` and `parse`, and a `ServiceTable::production` row with its host,
   path prefix and `AuthShape` (header, query or oauth refresh).
2. `api_keys.rs`: add `REGISTRY` rows for each secret name; the test
   `registry_names_are_unique_and_cover_every_broker_service` lists the names, add yours.
3. Ownership: if writes should be owner-checked, add the rule in `ownership.rs` (a service with no
   owner rule refuses `require_owner` rows, which is the safe default).
4. Policy: a seed row only through `scripts/broker-seed-scan.mjs` (add the host to its table) or a
   card at runtime. Never seed DELETE or a wildcard action segment.
5. Fronts: add the name to the `enum` lists in `mcp/tool_schemas_broker.rs` (three places) and to
   the tool descriptions; a read made by POST needs a line in `front::require_read` and a test.
6. A binary download endpoint is one `DOWNLOAD_PATHS` row and one test.
7. Masking needs no change: the engine masks every secret the call carried. A new encoding the
   service is seen to echo goes in `secret_store::encoded_variants` or `mask::extra_variants`.
8. Tests: extend the broker rig (`hooks_server/broker_rig.rs`) so the canary scan covers the new
   service, and check `broker_gate0_tests.rs` still passes (it asserts per-call audit line counts).

### Tests and the rig

- Rig: `hooks_server/broker_rig.rs` (`Rig`: real `DaemonState`, real routes, real `FilePolicy` and
  `AuditLog` under a throwaway data dir, mockito standing in for the services).
- Canary (`broker_canary_tests.rs`):
  `a_service_that_reflects_the_credential_leaks_nothing_through_either_front_or_to_any_file`,
  `an_error_body_a_redirect_location_and_an_upstream_error_text_are_masked`,
  `a_connection_failure_text_carries_neither_the_url_nor_the_credentials_in_it`,
  `hubstaff_access_and_rotated_refresh_tokens_are_masked_though_only_the_exchange_returned_them`,
  `a_binary_download_is_the_one_unmasked_path_and_the_audit_line_says_so`.
- Prompt injection and carry (`broker_injection_tests.rs`):
  `a_write_the_policy_does_not_list_is_denied_with_the_row_to_add_and_never_reaches_the_service`,
  `an_allowed_shortcut_write_is_denied_on_a_story_that_is_not_the_users_and_goes_through_on_one_that_is`,
  `an_allowed_linear_comment_is_denied_on_an_issue_that_is_not_the_users`,
  `text_read_from_one_service_cannot_be_written_into_another_until_a_row_allows_it`.
- Scope (`broker_scope_regression_tests.rs`):
  `the_script_front_gives_a_token_its_own_chats_services_and_nothing_a_neighbour_holds`,
  `the_script_front_rejects_a_closed_chats_token_a_superseded_token_and_the_daemons_own_token_file`,
  `the_mcp_front_takes_the_session_from_its_channel_and_scopes_it_to_that_chats_launch`,
  `a_hidden_sub_holds_its_parents_set_on_both_fronts_and_no_more`.
- Gate 0: `hooks_server/broker_gate0_tests.rs` (in process) and `node scripts/broker-gate0.mjs --daemon <exe>`
  (private daemon process, denials only).
- Other: `node --test scripts/cc-api/cc_api.test.mjs`, `node --test scripts/broker-seed-scan.test.mjs`.
  Run Rust ones with `cargo test --manifest-path src-tauri/Cargo.toml --lib broker`.

### Global G1 hooks dependency (not in this repo)

Until G1 lands in `~/.claude` (todo pc-1375), the guard hooks (`outbound-verify-guard.py`,
`shortcut-create-guard.py`, the linear guards) match the command string only, so a write through
`mcp__cc_conductor__api_write` bypasses them. The engine does not duplicate them (the daemon has
no transcript to verify against). G1 re-points their matchers at `api_write` and the `cc_api`
command string, with a test that a comment with no verifier is denied. **Do not migrate any consumer
to the broker before G1 lands.** G2 migrates consumers; G3 adds a tripwire on `~/.claude/.env` and
the store path, then rotates tokens and deletes `.env`.

### Design items not built (and why)

- **Settings UI for `broker_services`**: a hand edit works only with the app closed. Belongs with a
  Settings pass; not in the plan's steps.
- **A per-process channel for the session token** (to close the same-user env read): needs a handle
  or pipe handed to the child; out of scope for the plan's HMAC-env design.
- **Audit log rotation, and audit lines for ownership lookups**: left as chores; the log is
  append-only and its writer is safe against an external rotate.
- **The `tickets/` clients are not reused**: they hard-code hosts, with no cap, masking or redirect
  guard, so the engine has its own request path.
- **Hooks G1 to G3 and the CLAUDE.md rule**: outside this repo or this sub's write scope.
- **A private spawned daemon for the canary and injection tests**: the plan asked for one; the
  rig is in process because the production engine pins real hosts (a host override would be a hole).
  Only Gate 0 runs a real daemon process, with denials only.
- **A role-based narrowing** (a read-only sub still reaches `api_write`): the token carries the role,
  the engine ignores it, by spec.
- **No live proof** with a real `claude` CLI, a real Mac Keychain, a real phone, or a real Trello
  download.

## CLAUDE.md entry

Paste this as one rule under `## Rules` (the main chat trims it; a sub cannot edit CLAUDE.md):

```text
- **API token broker** (`src-tauri/src/daemon/broker/`): chats call Shortcut, Linear, Trello, Figma, Clockify and Hubstaff through the `api_read`, `api_write` and `api_card` MCP tools or `scripts/cc-api/`, and never see a token. Hard rules: every call goes through `Engine::call`, a front never builds a URL, reads a secret or sets an auth header, and a new service follows "How to add a service" in the doc, starting with a row in `services.rs`; every result is masked by exact value through `broker::mask::Masker`, never by token shape; a chat reaches a script front only with its own `CC_BROKER_TOKEN` (`BrokerSessions::verify`, never the daemon's token file or a session id alone) and every request is built by `SessionClaims::request`; a denial is `ok:false` with the exact row or binding line, never a card; `api_read`/`api_write`/`api_card` stay in `PRETRUSTED_TOOLS` and no broker method gets a `TRANSPORT_TABLE` row (`respond_broker_card` and `broker_friction` are desktop-pipe only); a token enters the store and a policy row is added only through a broker card answered on the desktop pipe; `out_file` is written only by `broker::out_file::OutTarget`; a live daemon rig never makes a call that reaches the secret read (the real `~/.claude/.env` is a fallback). The honest limits (a same-user process can read a session token and the desktop pipe; the engine does not stop a hostile shell) are in the doc and must not be oversold. Before editing the broker, read docs/architecture/api-broker.md.
```

## Rules behind the entry (detail, from steps 2 to 8)

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
- Scripts and hooks reach the broker only through `scripts/cc-api/` (`cc_api.py` / `cc_api.mjs`) and the
  loopback route `/hooks/api-broker-http`, with the chat's own `CC_BROKER_TOKEN` in `Authorization: Bearer`
  and nothing else accepted. The route stays off the remote server and off `TRANSPORT_TABLE`.
- `out_file` is written only by `broker::out_file::OutTarget` (the chat's folder or the chat's own folder in the temp dir, parent
  canonicalized, never a `.git`, `.claude`, `.env*` or the data folder; refused for a read-only sub); binary bytes leave the engine only for
  `download: true` on a GET named in `services::DOWNLOAD_PATHS`, and that call's audit line is `unmasked: true`.
- A token enters or changes the broker store, and a policy row is added, only through a broker card
  (`broker/cards.rs`) answered by `respond_broker_card` on the desktop pipe. That RPC stays off `TRANSPORT_TABLE`;
  `respond_question_as` refuses a broker card; the `api_card` tool carries no value or row; a card applies through
  `card_ops` only (`replace_secret`, `apply_import`, `policy_file::add_row`) and leaves a `CARD` audit line.
- A new secret form (a new encoding a service is seen to echo) is added to
  `secret_store::encoded_variants` or `mask::extra_variants` with a test, never as a regex, and the rig's
  `broker_rig::forms` list (what the canary scan looks for) gets the same form.
- A write that repeats text a chat read from another service passes only when the rows that allow it name that
  service in `carry_from` (`broker/carry.rs`, `PolicyRequest::carried`); a read is never held, same-service text is
  not carry, and a policy row's identity includes `carry_from` (`policy_file::same_row`).
- The friction counter reads only `broker-audit.jsonl` (`broker::friction`); a new refusal outcome decides in that
  file whether it counts (a denial Joe fixes with a row, an owner or a binding) or is listed apart (a malformed
  call). The target is 2 or fewer friction denials per day from day 7, and `broker_friction` stays off
  `TRANSPORT_TABLE`.
- A live daemon rig never makes a broker call that reaches the secret read (the real `~/.claude/.env` is a fallback
  source): `scripts/broker-gate0.mjs` uses denials only.
- Broker end-to-end tests use `broker_rig::Rig` (real routes and policy under a private data dir, mock services),
  never the live data dir and never a spawned daemon pointed at a host override.
