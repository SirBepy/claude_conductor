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
  `&`/`<`/`>` (Go style) in both hex cases, `\/` on the base64 forms (PHP), and the
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
- The 1 to 5 secret bytes at the edges of an alignment-only base64 hit: the groups there also
  encode neighbouring bytes, so only whole groups inside the secret are matched, and only when
  the fragment is at least 12 base64 chars.
- A secret shorter than about 9 bytes has no alignment variant (the 12-char floor would mask
  unrelated text), so `base64(unknownuser:shortsecret)` is not masked; give the masker the user
  with `secret_with_user` when it is known.
- HTML entities (`&amp;`, `&quot;`) and MIME-wrapped base64 with line breaks.
- Binary `out_file` content (the plan marks that audit entry as unmasked).

## Rules to lift into CLAUDE.md (step 9)

- Broker output (bodies, headers, errors, `out_file` text) goes through `broker::mask::Masker`
  before it is returned or written, and the masker matches exact values only, never by shape.
- A new secret form (a new encoding a service is seen to echo) is added to
  `secret_store::encoded_variants` or `mask::extra_variants` with a test, never as a regex.
