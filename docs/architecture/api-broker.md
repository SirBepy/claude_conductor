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
| `policy.rs` | `Policy` trait and `PolicyRequest` / `PolicyDecision`. Step 3b implements it from `broker-policy.json`. |

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

- The policy file, hot reload and seed (step 3b, per the brief). The engine only knows `trait Policy`.
- Session binding (`broker_services`), the HMAC session token and `spawn.rs` injection (step 4).
- Anything that reads the engine's output into a front: MCP tools (5), HTTP loopback and `out_file` (6).
  Binary bodies come back as lossy UTF-8 text until `out_file` exists.
- Daemon wiring: nothing constructs an `Engine` yet. Step 4 or 5 builds it once with
  `SystemSecrets::new(data_dir)`, the real policy, and `AuditLog::new(data_dir/broker-audit.jsonl)`.
- Audit log rotation. It is append-only and grows; rotation is a later chore.
- The tracker clients in `tickets/` are not reused for the calls: they hard-code their hosts, have no
  request cap, no masking and no redirect guard. The engine reuses `crate::env_file` (through
  `api_keys`) and `tickets::effective_tracker` is left for step 4's binding.

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
- A new secret form (a new encoding a service is seen to echo) is added to
  `secret_store::encoded_variants` or `mask::extra_variants` with a test, never as a regex.
