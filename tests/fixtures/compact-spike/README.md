# Compaction fixtures (spike S1)

The lines a real `/compact` wrote, rebuilt from `docs/research/compact-spike.md`
(the spike's own transcript was deleted in its cleanup, section 12).

- `transcript.jsonl`: transcript lines 142-146 of section 3 (boundary, continuation
  summary, local-command caveat, `/compact` command, local-command stdout) plus three of
  the attachment lines that follow. Field names, flags, figures and timestamps are the
  measured ones; uuids are placeholders and the summary body is shortened from 6,487
  chars (its first and last sentences are verbatim).
- `stdout.jsonl`: the child's stdout between the send and the `result`, section 2.
- `history-events.json` / `live-events.json`: the `ChatEvent`s the parser makes of them
  (live: what the pump publishes, so no `session_started`). Pinned to the real parser by
  `src-tauri/src/chat/parser/compaction.rs`'s tests and fed to the renderer by
  `tests/chat-compaction-row.test.mjs`.
