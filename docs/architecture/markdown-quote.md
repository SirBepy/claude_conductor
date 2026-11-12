# Markdown blockquote as a reply bubble

Read before editing `src/shared/chat/markdown-quote.ts`, `chat-messages-markdown.css`, the draft editor blockquote or `TURN_STATUS_PROMPT`.

- **A markdown blockquote is a quote of a person, drawn as a reply bubble on every surface.** `renderMarkdown` tags each one `.md-quote` and lifts a leading `**Name:**` onto a speaker line (`src/shared/chat/markdown-quote.ts`); the one style is `blockquote.md-quote` in `chat-messages-markdown.css` (the draft editor's untagged `.dr-body blockquote` rides it). The per-turn prompt (`TURN_STATUS_PROMPT`) tells chats to quote people that way and to put paste-ready text in a fenced code block: a quote has no copy button (the old transcript copy card, `wrapBlockquotes`/`.card-block`, is gone). Give a new markdown surface no blockquote rule of its own.
