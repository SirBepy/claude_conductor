# People system

Read before editing `src-tauri/src/people.rs`, `daemon/methods/people.rs` or `write_draft`'s person gate.

- **People system: the Obsidian vault is the only store.** `src-tauri/src/people.rs` reads `People/*.md` plus client notes (any vault-root note whose frontmatter lists `repos:`; slug = lowercased note name). `daemon/methods/people.rs` serves the one `person` MCP tool (`find`/`remember`, routes `/people/find` and `/people/remember`) and the per-turn "People on <client>" rider; the caller's client comes from its own Conductor project's name/folder matched against `repos:`, never from an argument. `write_draft`'s person gate resolves client-only nicknames through the same lookup. The questionnaire wording lives in the global `/people` skill.
