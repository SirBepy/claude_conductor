# Voice mode revival: fast Wispr-style rewrite + words that learn

Status: plan, 2026-11-23. Decisions come from Joe's answers in the brainstorm chat: the rewrite is Wispr-like (free rewrite, never adds ideas); vocabulary is auto-seeded from his data AND learned from his edits; a 3-rater panel ranked the ideas and this plan follows the agreed order. Claims marked UNVERIFIED have not been read or run this session.

## 0. Starting point (read this session)

- `stt-sidecar/` (faster-whisper large-v3-turbo, CUDA fp16, LocalAgreement-2, VAD on). Model loads once per sidecar process (`engine.py:20-27`). Vocab: `voice-vocab.json` terms become Whisper `hotwords` (`engine.py:89-91`, `vocab.py:19`); `voice-corrections.json` pairs apply after commit as case-insensitive whole-word regex (`vocab.py:39-43`, `engine.py:122,128`). Nothing writes either file except a 13-term seed in `daemon/stt.rs:143`.
- faster-whisper 1.2.1 prepends hotwords to the decoder prompt whenever there is no `prefix`, independent of previous text (`transcribe.py:1542-1548`, from grep). So hotwords are not dropped once LocalAgreement supplies a prompt. Hotwords are truncated to `max_length // 2 - 1` tokens (same lines): the Whisper list must stay short.
- Sidecar shuts itself down after 5 idle minutes (`stt.rs:30,392`). It is not bundled in the installer (`docs/architecture/stt-sidecar.md`), so dictation works from a source checkout only. Setting is off by default.
- Cleanup today: `voice/cleanup.rs` spawns a fresh `claude -p --model haiku --effort low` per stop. The prompt (`cleanup.rs:21-33`) forbids punctuation and rephrasing, the opposite of the goal. Frontend: `composer-voice.ts` `cleanupDictation()` awaits it, and `finishForSend()` waits on it, so a slow rewrite delays Send. The swap assigns `textarea.value`, which loses native undo.
- `voice_clean_transcript` is a phone-reachable RPC (`remote_transport_table.rs:548`, row `P`).
- **Measured 2026-11-23 on this PC** (trivial one-word prompt, haiku, effort low): default `claude -p` = **6.1 s and 7.2 s**. With `--tools "" --no-session-persistence --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources "" --system-prompt "..."` = **2.5 s and 2.9 s**, and still authenticated on the subscription. So most of the "takes forever" is the CLI loading hooks, settings, tools and MCP, not the model.
- `src-tauri/src/voice/cleanup.rs` showed as modified in the session-start git status but `git diff` is empty now (checked 2026-11-23, someone committed it). Re-run `git status` and `git diff` on every file before editing; other sessions share this tree.

## 1. Goals and success criteria

1. Speed: rewrite lands within ~3 s of releasing the key with a lean cold spawn (measured floor 2.5 s), and within a target of ~1.2 s with the warm process (TARGET, to be measured). Raw text is on screen instantly either way, and Send never waits more than a short grace.
2. Quality: output has punctuation, capitalisation, filler and false starts removed, spoken lists as bullets, self-corrections resolved, no added ideas. Checked on a fixed sample set, not by eye.
3. Words: "zng", "zirtue", project and people names come out right. Checked on Joe's own recorded clips (section 8), before and after each vocab step.
4. Gentle on the PC: one rewrite in flight, one idle warm process at most with an idle kill, no new GPU load.
5. Subscription-only billing unchanged: every spawn passes the existing account, drift, credential and `check_metered_billing` guards.

## 2. Phase 0: measure and lean spawn (quick win, do first)

- Add per-stage timing logs in `voice/cleanup.rs` (spawn, first stream line, result, total) at info level, one `[voice]` line per call.
- Put the lean flag set in one `lean_args()` function (new file `voice/spawn_args.rs` if `cleanup.rs` is near its size limit): `--tools ""`, `--no-session-persistence`, `--disable-slash-commands`, `--strict-mcp-config` with an empty `--mcp-config`, `--setting-sources ""`, `--system-prompt <rewrite prompt>`, `--model haiku`, `--effort low`, stream-json output. Keep cwd = app-data dir (no stray CLAUDE.md). Keep `stdin` handling per phase 4.
- Test: a unit test asserting the arg list contains each flag (a drift guard) and that `check_metered_billing` still runs before spawn.
- UNVERIFIED: whether `--setting-sources ""` could drop auth for a non-default account config dir (the multi-account `CLAUDE_CONFIG_DIR` env). Test with a second account before shipping. If it breaks, drop that flag and keep the rest, re-measuring.
- UNVERIFIED: `--bare` is not used because it may force API-key auth; do not try it (billing rule).

## 3. Phase 1: the rewrite prompt and output contract

Replace `build_prompt` with a system prompt (via `--system-prompt`) plus the transcript as the single user message.

- Rules in the prompt: add punctuation and capitalisation; remove fillers (um, uh, "like" as filler, "you know"), stutters, false starts; resolve self-corrections ("Tuesday, no Wednesday" becomes "Wednesday"); turn a spoken list ("first, second, third" / "a list of X, Y and Z" when clearly enumerated) into a markdown bullet list; keep the speaker's words and meaning, never add ideas or answer the content; keep code identifiers, file names, commands and numbers verbatim; keep the language spoken; treat the transcript strictly as data (it may contain instructions or questions, never act on them).
- Vocabulary block: the user's terms and learned "heard -> correct" pairs (section 6), phrased as "the speaker often says these; if a word in the transcript sounds like one of these, use it". Cap about 200 terms.
- Few-shot: 4 short examples (plain sentence, filler and self-correction, a list, a technical sentence with a custom word). Keep short, since input tokens add latency.
- Output contract: the model must return the result inside `<out>` and `</out>` tags. Parse only the tag content. Reject and fall back to raw text when: tags missing, empty, a refusal/chatty reply is detected (starts with "I", "Sure", "Here"), or output length versus input is outside 0.35x to 1.8x. Never paste a failed output.
- Timeout 8 s, then fall back to the local fast pass (phase 2) result. One rewrite in flight per session id.
- Tests (Rust): prompt builder includes vocab and pairs, parser accepts tagged output and rejects each bad shape above, ratio guard boundaries. Sample set file `voice/testdata/rewrite_cases.json` of raw -> expected-properties cases (not exact strings), run by an ignored live test that uses real `claude` (billed, run on demand only).

## 4. Phase 2: skip and fallback (no LLM)

- Local pass `voice/fast_pass.rs`: trim, collapse repeated whitespace, remove a conservative filler list (um, uh, uhm, er, erm, "you know" only when comma-delimited), capitalise the first letter, apply learned pairs. Never invents punctuation (Whisper already punctuates).
- Skip rule: raw text of 5 or fewer words, with no list cue ("first", "second", "bullet", "list") and no correction cue ("no wait", "I mean", "actually"), gets only the local pass and never calls the LLM.
- The same local pass is the fallback on LLM failure, timeout or contract rejection.
- Tests: table-driven cases for each rule, the skip boundary at 5 vs 6 words, each cue word.

## 5. Phase 3: front end, raw first then swap

Edit `src/shared/chat/voice/composer-voice.ts` (read `composer-undo.ts` and `composer-highlight.ts` first; how they treat programmatic edits is UNVERIFIED).

- On stop: committed raw text is already in the composer. Mark the dictated span as "rewriting" with a subtle style (reuse the volatile-text styling if it fits) and call the rewrite without awaiting it in the stop path.
- Swap guard, all must hold or the swap is dropped silently: the span text still equals the raw we sent; no edits happened in the span; the caret was not moved into the span by the user (selection outside span or collapsed at its end); a per-dictation generation id still matches (a newer dictation or a reset cancels older swaps).
- Native undo: perform the swap with `textarea.setRangeText` plus selection, or `document.execCommand("insertText")` on a selected range so Ctrl+Z restores the raw text in one step. If neither integrates with `composer-undo.ts`, push an explicit undo entry there. Keep a per-dictation record `{start, end, raw, rewritten}` in memory (not persisted) for undo and for phase 6 learning.
- Send: `finishForSend()` awaits only the controller stop (the sidecar's trailing flush), then waits for a pending rewrite up to a 1.5 s grace; after that it sends the raw text (with the local pass applied) and cancels the swap. Update the doc comment that currently promises "always the cleaned text".
- Tests (vitest, under `tests/`, since `src/**/*.test.ts` never runs): swap applies when untouched; dropped on edit inside the span; dropped on newer generation; Send grace sends raw after timeout; undo restores raw. View spec for the mic and "rewriting" state with a `// asserts: src/shared/chat/voice/composer-voice.ts` header; run `pnpm run check:view-spec-coverage`.

## 6. Phase 4: the warm process (replaces pre-warm and warm-session ideas)

Design: a pool of one pre-booted lean process, used for exactly one dictation and replaced right after, so there is no context bleed and no reset logic.

- New daemon module `voice/warm.rs`: `claude -p --input-format stream-json --output-format stream-json --verbose` with the lean flags and the rewrite system prompt, stdin kept open, spawned (a) when recording starts if none is warm (hides boot behind the speech itself), and (b) right after a rewrite finishes only if the user dictated within the last ~2 minutes. At stop the transcript is written to its stdin as one user message, the `result` line is read, the process is dropped, and the pool refills per the rule above.
- Lifecycle: idle kill after 5 minutes (same as the sidecar), kill on daemon shutdown, `guard_orphan_tree` on spawn, one process maximum, replaced on any error. All billing and account guards run at spawn exactly as in `clean_transcript`. If a warm process is unavailable or fails, fall back to the lean cold spawn (phase 0), then to the local pass.
- Prompt-cache note: because each process is fresh, the system prompt is not cached across dictations; keep it compact.
- UNVERIFIED and must be measured before building the pool: how much of the 2.5 s lean boot is Node startup and settings load (hidden by a held-open process) versus the first model request (not hidden). If a warmed process still takes more than ~1.5 s after the transcript arrives, the pool is not worth its idle process: stop at phase 0 to 3 and say so.
- Tests: pool lifecycle with a fake child (TestCommand pattern): spawn-on-record-start, one use per process, refill rule, idle kill, error fallback, never two at once. Orphan check after the test run.

## 7. Phase 5: vocabulary store, auto-seed, settings page

Files: `voice-vocab.json` (terms), `voice-corrections.json` (heard to corrected), new `voice-learned.json` (candidates with counts and timestamps) under `<app_data>/voice/`. Any new settings field gets `#[serde(default)]` (the 2026-08-22 data-loss rule).

- Auto-seed (`voice/vocab_seed.rs`, daemon side): sources are Conductor project names and folder names, repo names (folder basenames and git remote basenames for each project), vault people names via `people/vault.rs` (`clients_at`, `vault_dir`, read-only, never leaks note bodies), plus the existing 13-term seed. Rank by recent use and cap the Whisper hotword list (about 60 terms, well inside the 223-token limit; measure token count, not term count). The rewrite prompt gets the longer list. Re-seed on daemon start and from a Settings button, never mid-utterance; call the sidecar's `reload_vocab` between utterances only when the file hash changed.
- Manual dictionary: Settings > Voice & dictation gets a "Dictionary" card: terms list (add, remove), corrections list (heard, corrected, remove), learned candidates (word pair, seen N times, Accept, Dismiss), a "Seed now" button listing which sources were read, and a Rewrite on/off switch (a switch for yes/no, a select for any choice, no chips). Phosphor icons, follow `refs/ui-polish.md`, shoot the page and show Joe.
- Daemon RPCs for read and write of these lists; each gets a `TRANSPORT_TABLE` row with a rationale comment and an allowlist test entry; the phone does not edit the dictionary (desktop pipe only) but benefits from the result.
- Tests: seed from fixture folders and a fixture vault (de-duplicates, caps, excludes personal-note bodies); atomic file writes with a `.bad` copy on parse failure (never read a corrupt file as empty); `serde(default)` round-trip with an old file; view spec for the settings card.

## 8. Phase 6: learn from edits

- At Send (and on a manual "I fixed it" gesture if added later), the front end compares each dictation's `rewritten` text with what is now in the composer span. Locate the span by the stored start/end plus anchors (the text before and after it); if the anchors no longer match, skip learning for that dictation.
- Word-level diff (LCS over tokens). Only a replacement of 1 to 3 words by 1 to 3 words is a candidate. Reject pairs that look like rewording: require a low edit distance or phonetic similarity between the sides, OR the corrected token already is a known term or a non-dictionary token. "Tuesday" to "Wednesday" is not learned; "sing" to "zng" is.
- Candidates are sent to a daemon RPC `voice_learn_edit` that updates `voice-learned.json`. A pair is promoted into `voice-corrections.json` and its corrected word into `voice-vocab.json` only after it is seen twice (or accepted in Settings). Everything learned is visible and deletable in the Dictionary card, so a bad lesson is one click to remove.
- Tests: diff extraction cases (substitution, insertion, deletion, multi-word), the rewording rejection, promotion at count 2, anchor mismatch skips.

## 9. Phase 7: Whisper-side accuracy and the eval set

- Eval set: an opt-in debug toggle, off by default, that saves each dictation's raw WAV plus the final accepted text into `<app_data>/voice/eval/` (local only; this persistence exists solely to measure word recall and is named in the settings caption). A script in `stt-sidecar/tests/` replays the WAVs through the engine with a given vocab and prints recall for a list of target words (zng, zirtue, ...). Joe records about 10 clips once; every vocab change is judged on those numbers, not by feel.
- Style sample in the Whisper prompt: only if the eval shows missing punctuation; keep under 100 tokens and test for prompt echo (a guard already exists near `whisper_online.py:391`).
- Feed corrections back into the text Whisper uses as its next-segment prompt, so it stops reinforcing a wrong spelling: investigate where `whisper_online.py` builds `init_prompt` (200-char tail) and whether the corrected text can be substituted there; UNVERIFIED feasibility.
- Fuzzy/phonetic post-correction against the vocab (edit distance, plus metaphone only as a hint): LAST, behind a setting, with a minimum length of 4 and a high threshold. Note "zng" is 3 letters, so fuzzy matching will not catch it: the learned pairs and hotwords are what fix it. Skip entirely if the eval shows recall is already good.
- Tests (pytest, fast, no GPU): fuzzy threshold and min-length cases, corrections whole-word behavior, vocab load on bad JSON.

## 10. Cross-cutting

- Docs: new `docs/architecture/voice.md` (warm pool, output contract, lean flags, vocab files, learning rules, measured numbers); update `docs/architecture/stt-sidecar.md`; add a pointer line in `CLAUDE.md` Rules only if the `claude-md-architecture` test requires one (UNVERIFIED, run it). Keep `README.md` in sync if the voice feature is described there.
- Every behavior change ships with a test that fails without it (prove red with `tools/red-check.ps1`). Fast checks before each commit: `cargo build`, `cargo test --lib` for voice and stt modules, `pnpm run typecheck`, vitest with the 5-thread flags, `check:css-vars`, `check:view-spec-coverage`, python `pytest` for the sidecar fast tests.
- Commits via `/commit`, by pathspec, one per phase; never touch the other session's hunks in `cleanup.rs`.
- Memory: the "Voice dictation unused (Wispr Flow)" note is now outdated and gets updated after the work lands; save the lean-flag measurement as a project memory.
- Phone: nothing changes except it benefits from a faster daemon RPC; the rewrite RPC keeps its `P` row.
- Out of scope: local LLM, per-segment rewrite while speaking, streaming the rewrite into the textarea, bundling the sidecar into the installer, changing the Whisper model.

## 11. Build order

1. Phase 0 (measure, lean flags) then phase 1 (prompt and contract) then phase 2 (skip and fallback).
2. Phase 3 (raw first, swap, undo, Send grace).
3. Measure the warm process, then phase 4 only if it clears the bar.
4. Phase 5 (store, seed, Settings card).
5. Phase 6 (learn from edits).
6. Phase 7 (eval set first, then only the tuning the numbers justify).

## 12. Assumptions to confirm early

- Lean flags keep auth working on every account kind used for dictation (subscription accounts only; API-credit and endpoint accounts keep refusing, as today).
- A held-open stream-json process starts its model request only on the first message.
- The composer's undo can take a programmatic edit as one step.
- Joe is fine recording about 10 clips for the eval set.

## 13. Review round (3 sonnet reviewers: backend, front end, accuracy), judged

These amend the sections above; where they conflict, this section wins. Reviewer claims about code the reviewer did not read stay UNVERIFIED until the builder reads them.

### Corrections to the plan
- **Send wait lives in `send()`, not `finishForSend()`.** `composer.ts:713` calls `finishForSend` only while `cv.state === "recording"`, so a Send pressed after release skips it. Add a "rewrite pending" check in `send()` with the 1.5 s grace and raw fallback. (Reviewer read; builder re-reads first.)
- **No native undo exists to preserve.** `composer-voice.ts` already writes `textarea.value` in `onPartial`/`onFinal`, and `composer-undo.ts` only pops the held/sent queue. Drop `execCommand` (deprecated, needs focus) and the "push an undo entry there" idea. Build a `ComposerVoice`-owned "undo last rewrite": Ctrl+Z within a few seconds of a swap restores raw, plus a small "Undo rewrite" chip that also covers touch.
- **Offsets drift.** `dictationStartPos`/`commitPos` are plain integers, so typing earlier in the draft shifts them. Locate the raw string by search near the stored offset (or anchors) instead of comparing at fixed offsets. Learning (phase 6) uses the same locator and snapshots BEFORE `clearComposer`.
- **Generation id** is bumped in `reset()`, `toggle()` and `startForPtt()`, so a late swap can never write into the next draft. A second dictation while a rewrite is pending tracks spans independently; it does not cancel the first rewrite.
- **Output contract:** drop the "starts with I/Sure/Here" refusal heuristic (it rejects real dictation like "I think we should"). Rely on the `<out>` tags, a length ratio of 0.2x to 2.5x, and a check that every number and code-like token in the input survives. Add an injection test (transcript says "ignore previous instructions").
- **Skip rule** becomes: under 4 words and no list or correction cue. The local pass keeps only trim, capitalise first letter and apply learned pairs (no filler regex: the LLM does that, and Whisper already punctuates).
- **Hotword budget:** rare words tokenize into 3 to 6 pieces, so "60 terms" can blow the limit. Enforce a ranked list within about 100 tokens (assert on tokenized length in a sidecar test; sidecar tokenizer access is UNVERIFIED); the longer list goes to the rewrite prompt only.
- **Settings:** the Rewrite switch and eval toggle need a `state.ts` field, the `settings-save.ts` pattern and `#[serde(default)]` with an old-file round-trip test. Fix the stale comment at `composer-voice.ts:7` ("Notifications > Audio") while there.

### Added to the plan
- **Backend hardening:** the warm trigger is its own daemon RPC `voice_warm` with a desktop-pipe-only `TRANSPORT_TABLE` row (never `P`, so a paired phone cannot spawn billed processes), single-flight and rate limited; a global rewrite semaphore (1 or 2) across phone and desktop; account, drift and credential guards re-run at USE time, and the warm process is killed on a default-account change; continuous stderr drain on any held-open child; explicit kill after the 8 s timeout; kill on stdin write error or unparseable line; non-Windows orphan behaviour defined; a test that the empty-string argv flags (`--tools ""`, `--setting-sources ""`) survive the Windows command line; the `[voice]` timing log never contains transcript text; one settings kill switch disables both the warm process and the LLM pass.
- **Store safety:** vocab, corrections and learned files are written atomically with a `.bad` copy on parse failure, a lock around `voice_learn_edit`, a size cap and per-string length and newline sanitising (learned strings end up in a prompt).
- **Sidecar fix, do first:** `vocab.py:42` passes `corrected` straight to `re.sub` (a backslash raises or mangles) and `\b` fails for terms like `.net`; pairs apply sequentially so A to B then B to C chains. Replace with one alternation pass, longest first, `lambda m: corrected`, escaped boundaries. Test each case.
- **Visible failure states:** sidecar missing or rewrite failed shows a small "Rewrite unavailable, kept raw" indicator instead of only `console.warn`; the rewriting state has `aria-live` text, not only a colour; the highlight layer gets a rewriting-span state and re-aligns when the swap changes length; the Dictionary card has labelled inputs and keyboard removal; a phone-width view spec covers the rewriting state and the touch caret case.
- **Eval first:** the clip saver and recall script move to the very front of the build (phase 7a), with a bake-off on Joe's clips: hotwords vs a sentence-style `initial_prompt` ("Notes about Claude Conductor, zng, zirtue.") vs both; large-v3-turbo vs large-v3; beam size. The model stays turbo unless the numbers say otherwise. Eval WAV saving stays opt-in, off by default, named in its settings caption.
- **Apply corrections before Whisper's next-segment prompt is built** (in `whisper_online.py` before `init_prompt` reads the committed words), so a fixed spelling stops being reinforced. Investigate feasibility early.
- **Rewrite faithfulness metric** in the sample-set test: count content words dropped or added, and flag changed numbers or identifiers.
- **LLM substitution rule:** the rewrite may swap a transcript word for a vocab term only when it is close in sound or spelling; stated in the prompt.

### Cut or deferred
- Fuzzy/phonetic post-correction: cut until the eval proves it is needed ("zng" is 3 letters, it cannot help).
- Per-project hotword rotation: deferred until after the eval.
- Warm pool: stays gated by the measurement and defaults to skipped.
- `voice-learned.json` starts as a plain "recent corrections" list with delete, promoted at 2 sightings; the richer Accept/Dismiss UI comes later. Learning is kept (Joe chose it) but a learned pair goes to the corrections file only, since separating Whisper-mishearing from LLM-wording fixes needs data first.

### Revised build order (superseded by section 14 if the two differ)
1. Phase 7a eval harness and the `apply_corrections` fix (small, unblocks measurement).
2. Phase 0 (lean spawn, timing), phase 1 (prompt and contract), phase 2 (skip and fallback).
3. Phase 3 with the corrections above (pending wait in `send()`, own undo, generation ids, error states).
4. Measure the warm process; phase 4 only if it clears the bar.
5. Phase 5 (store, seed, Settings card), then phase 6 (learn from edits).
6. Remaining phase 7 tuning only as the eval numbers justify.

## 14. Second review round (3 sonnet reviewers: security, delivery, product), judged

### Security and billing (adopt)
- **Transcript goes over stdin on every path, never argv.** `cleanup.rs:60-61` puts it in `-p` argv today, readable by any same-user process. Applies to the cold lean spawn too.
- **`--tools ""`, `--no-session-persistence`, `--setting-sources ""` are privacy and injection controls, not only speed flags.** The drift test asserts them as such. Today's spawn loads Joe's hooks and MCP servers and writes a session log for every dictation (`cleanup.rs:70`, stdin null). If `--setting-sources ""` must be dropped for auth on some account, the plan states the consequence (hooks see transcripts) instead of silently accepting it.
- **Phone `P` row** (`remote_transport_table.rs:548`) gets a per-minute cap and a max input length in addition to the global semaphore.
- **Prompt data hygiene:** vocab terms and learned pairs are quoted data in the prompt, with `<out>`, `</out>` and delimiter strings stripped; parse the LAST `</out>` and check the length ratio on the parsed content; a learned pair that would enter the prompt-visible list is promoted only with a visible entry in the Dictionary card (no silent promotion from a planted dictation).
- **Eval store:** about 30 clips cap, 14-day expiry, one-click wipe, never in logs, diagnostics or `release-report`, never mirrored to peer machines; caption states exactly what is stored (raw voice plus final text).
- **Names reaching haiku:** vault people and client names reaching a third-party model is new (today only the transcript goes). Seeds are names only, with an exclude list, never logged. Joe confirms this before the vault source ships; until then seeding uses project and repo names only.
- Idle kill of the warm process also fires on lock, sleep and account switch. `reload_vocab` and eval saving stay behind the sidecar's existing auth gate and never take a client path.

### Delivery (adopt)
- **CLAUDE.md budget:** `tests/claude-md-architecture.test.mjs` caps CLAUDE.md at 17500 chars (now 17359, 141 headroom) and requires every `docs/architecture/*.md` to be referenced. Do NOT add a new voice.md pointer line; extend the existing `stt-sidecar.md` pointer (CLAUDE.md:40) and put the voice doc content in `docs/architecture/stt-sidecar.md` or a new file only if the pointer fits, trimming elsewhere in the same commit if needed.
- `tests/composer-voice-finish-for-send.test.mjs` encodes "Send waits for cleanup"; phase 3 changes it deliberately.
- Fake-claude binary test (`scripts/build-fake-claude.ps1` exists, UNVERIFIED by me) for spawn, timeout, kill and argv without billing.
- Each phase states its ship-gate commands; a short Joe-only checklist (latency feel, caret, Undo chip, second-account run, about 10 clips) so builders never block on Joe.
- Rollout default: rewrite ON once dictation is on (dictation itself stays off by default), with the kill switch.
- Mutation proof, not `red-check.ps1`, for front-end swap and learning tests (red-check is vacuous for view specs).
- Splits: phase 3 one sub; phase 5 two subs (backend seed and store, then UI); the rest inline.

### Product (the part to decide)
- Dictation works only while the Conductor window has focus (document-level PTT listeners, stop on blur): the plan replaces Wispr for chat prompts only, not Slack, browser or tickets. Stated now so it is a decision, not a surprise.
- **First press after 5 idle minutes reloads Whisper onto the GPU.** Not in the plan until now. Add: pre-load the sidecar on window or composer focus, a visible "Loading model" state when a press arrives mid-load, and an optional longer idle timeout or "free GPU now".
- Raw-then-swap may feel worse than Wispr's arrive-clean if the rewrite takes longer than about 1.5 s; the warm-process measurement and the swap timing are judged together on Joe's feel.
- Candidates not in the plan (Joe's call, off by default): hands-free lock (double-tap PTT), voice edit commands ("scratch that", "make that a list") on the existing rewrite pass, a snippet list in the Dictionary card, a global shortcut that dictates into any app.
- Reorder by felt value: lean spawn and prompt first, then sidecar cold-start handling, then raw-then-swap with Undo, then auto-seed, then the rest. Eval harness moves to just before vocab work, but the cheap `apply_corrections` fix stays first.

## 15. Scope verdict (2 opus judges, engineering economy and product outcome): build the trimmed plan, not all of it

Both judges independently said do not build all of it (cut 40 to 60 percent) and agreed on the minimum below. Adopted.

### Build now, in order
1. `vocab.py` `apply_corrections`: one longest-first alternation pass, `lambda m: corrected`, escaped boundaries, pytest.
2. `cleanup.rs` lean spawn: transcript over stdin (never argv), `--tools ""`, `--no-session-persistence`, `--setting-sources ""`, empty MCP config, system prompt; a drift test asserting those flags as privacy controls; a test that the empty-string args survive the real spawn path (`util/claude_bin.rs:82,85` may resolve to `claude.cmd`, UNVERIFIED); auth checked on a second account; 8 s timeout that kills the child; one rewrite in flight; a `[voice]` timing line with no text.
3. New Wispr-style prompt with the vocab terms as quoted data, the `<out>` contract (last `</out>`, ratio 0.2 to 2.5, numbers and code tokens survive, delimiter strings stripped from prompt data), skip the LLM under 4 words with no cue, raw on any failure. Max input length on the phone `P` row.
4. Front end, minimal: raw shows at once, swap only if the dictated text is still exactly as left (generation id bumped in `reset`/`toggle`/`startForPtt`), Ctrl+Z within a few seconds restores raw, 1.5 s Send grace in `send()`, a one-line "kept raw" note on failure. Update `tests/composer-voice-finish-for-send.test.mjs` deliberately.
5. Sidecar cold start: preload on composer focus, a "Loading model" state, longer idle timeout (60 min or never, set after an `nvidia-smi` check).
6. Auto-seed project and repo names into `voice-vocab.json` on daemon start, ranked and capped at about 100 tokens.
7. CLAUDE.md: extend the existing `stt-sidecar.md` pointer only (budget 141 chars headroom); rewrite ON when dictation is on.

### STOP: Joe uses it for a few days, then picks by evidence
- Rewrite feels slow: measure the warm process (1.5 s bar), then phase 4.
- zng or zirtue still wrong: hand-written pairs first, then the dev eval script plus about 10 recorded WAVs (hotwords vs `initial_prompt` bake-off), then learn-from-edits.
- Wants dictation outside Conductor: a separate global-shortcut project.
- Wants a UI for words: a minimal terms and pairs editor.

### Cut or deferred (with reason)
- Warm pool and `voice_warm`: costs most, most failure modes, likely misses the bar (the model round trip is not hidden).
- Learn from edits, `voice-learned.json`, locks, promotion: unproven value for about 5 words; revisit with eval numbers.
- Dictionary card, learned candidates, extra RPCs and transport rows: Joe can hand-edit the JSON meanwhile.
- `fast_pass.rs` module: the sidecar already applies pairs and Whisper punctuates; keep only the skip rule and raw fallback.
- In-app eval saver and its retention rules: use a dev script and clips Joe records once.
- Fuzzy matching, style prompt, turbo vs large-v3, corrections into `init_prompt`, per-project hotword rotation: cut or deferred.
- Vault people names in the seed: deferred until Joe OKs names reaching haiku.
- Undo chip, highlight-layer rewriting state, phone-width spec, per-minute phone cap, hands-free lock, voice edit commands, snippets, global shortcut: deferred.

### Judges' warnings
- A realistic call (system prompt, few-shots, vocab, about 80 output tokens) will likely take 3 to 4 s, not the 2.5 s of a one-word prompt; raw-then-swap is what makes it tolerable.
- A fixed pair like `zing` to `zng` rewrites the real word "zing"; the word fix for 3-letter coinages mostly has to come from the LLM seeing the vocab list in context.
- Dictation works only while Conductor has focus (`composer-ptt.ts:71-75`), so this replaces Wispr for chat prompts only. This needs Joe's decision.
