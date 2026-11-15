# Markdown blockquote as a reply bubble

Read before editing `src/shared/chat/markdown-quote.ts`, `chat-messages-markdown.css`, the draft editor blockquote or `TURN_STATUS_PROMPT`.

- **A markdown blockquote is a quote of a person, drawn as a reply bubble on every surface.** `renderMarkdown` tags each one `.md-quote` and lifts a leading `**Name:**` onto a speaker line (`src/shared/chat/markdown-quote.ts`); the one style is `blockquote.md-quote` in `chat-messages-markdown.css` (the draft editor's untagged `.dr-body blockquote` rides it). The per-turn prompt (`TURN_STATUS_PROMPT`) tells chats to quote people that way and to put paste-ready text in a fenced code block: a quote has no copy button (the old transcript copy card, `wrapBlockquotes`/`.card-block`, is gone). Give a new markdown surface no blockquote rule of its own.

- **The speaker line grammar** (pc-1377): `> **Name -> To (source, date):**`, drawn by `speakerLine` in `markdown-quote.ts`. Each part after the name is optional, so `**Name:**`, `**Name -> To:**`, `**Name (source, date):**` and the whole form all parse.
  - `->` (or the arrow character) splits the speaker from who the words were addressed to. The parenthetical must close the line and holds where and when the statement lives, for example `sc-56481 comment, Oct 26`. It exists because a card that flattened two ticket threads into bold-name prose read as one conversation.
  - Each part is its own span on the `md-quote-who` line: the addressee is `.md-quote-to` (semibold), the source and date `.md-quote-src` (muted). Both styles sit in `chat-messages-markdown.css` beside the speaker rule, not in a surface's own CSS.
  - Limits keep prose out: the name and the addressee are at most 40 characters each, the note at most 80, and a bold lead-in longer than that overall is not a speaker (`splitSpeaker`). A line that does not fit stays a plain quote with a bold first word.
  - The DOM keeps the full text (`Name -> To (source, date)` plus the hidden colon), so the draft editor's `htmlToMarkdown` and a re-render read the line back unchanged.
  - `TURN_STATUS_PROMPT` tells chats to write it and to give statements from different threads their own quotes; a Rust test pins the example line. Not built: a structured `quotes` field on `send_message` and a thread view (the todo's other directions).
