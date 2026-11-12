// Every markdown blockquote is a quote of a person, drawn as a reply bubble
// (`blockquote.md-quote` in chat-messages-markdown.css, one rule for every
// surface). A quote whose first words are `**Name:**` gets that name lifted onto
// its own speaker line above the quoted words, the way Slack or Telegram head a
// reply with who said it. The chat guidance (TURN_STATUS_PROMPT in
// daemon/claude_config/args.rs) tells Claude to write quotes in exactly this
// shape. The colon stays in the DOM, hidden by CSS, so the draft editor's
// htmlToMarkdown turns the line back into `**Name:**` and a re-render still
// finds the speaker.
import type MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];
type StateCore = Parameters<Parameters<MarkdownIt["core"]["ruler"]["push"]>[1]>[0];

/** Longer than any name; a whole bold sentence ending in a colon is a lead-in, not a speaker. */
const MAX_SPEAKER = 40;

/** The speaker of a quote whose first inline run is `**Name:**` or `**Name**:`.
 *  Null when the quote does not open that way. */
function speakerOf(children: Token[]): { name: string; colonInNext: boolean } | null {
  const [open, text, close, after] = children;
  if (open?.type !== "strong_open" || text?.type !== "text" || close?.type !== "strong_close") return null;
  let name = text.content.trim();
  let colonInNext = false;
  if (name.endsWith(":")) name = name.slice(0, -1).trim();
  else if (after?.type === "text" && after.content.startsWith(":")) colonInNext = true;
  else return null;
  if (!name || name.length > MAX_SPEAKER) return null;
  return { name, colonInNext };
}

function speakerLine(state: StateCore, name: string, level: number): Token[] {
  const pOpen = new state.Token("paragraph_open", "p", 1);
  pOpen.block = true;
  pOpen.level = level;
  pOpen.attrSet("class", "md-quote-who");
  const inline = new state.Token("inline", "", 0);
  inline.level = level + 1;
  inline.content = `**${name}:**`;
  const sOpen = new state.Token("strong_open", "strong", 1);
  sOpen.markup = "**";
  const text = new state.Token("text", "", 0);
  text.content = name;
  // Renderer output, not parsed input: html:false only stops raw HTML in the
  // source, and this span carries no text Claude wrote.
  const colon = new state.Token("html_inline", "", 0);
  colon.content = `<span class="md-quote-colon">:</span>`;
  const sClose = new state.Token("strong_close", "strong", -1);
  sClose.markup = "**";
  inline.children = [sOpen, text, colon, sClose];
  const pClose = new state.Token("paragraph_close", "p", -1);
  pClose.block = true;
  pClose.level = level;
  return [pOpen, inline, pClose];
}

const isGap = (t: Token): boolean =>
  t.type === "softbreak" || t.type === "hardbreak" || (t.type === "text" && !t.content.trim());

function markQuotes(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== "blockquote_open") continue;
    tokens[i]!.attrJoin("class", "md-quote");
    const pOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    if (pOpen?.type !== "paragraph_open" || inline?.type !== "inline" || !inline.children) continue;
    // markdown-it leaves empty text tokens around emphasis delimiters.
    const live = inline.children.filter((t) => !(t.type === "text" && t.content === ""));
    const who = speakerOf(live);
    if (!who) continue;
    const rest = live.slice(3);
    if (who.colonInNext) rest[0]!.content = rest[0]!.content.slice(1);
    // Drop what separated the name from the words: the line break and the
    // space after the colon.
    while (rest.length && isGap(rest[0]!)) rest.shift();
    if (rest[0]?.type === "text") rest[0].content = rest[0].content.replace(/^\s+/, "");
    const line = speakerLine(state, who.name, pOpen.level);
    if (rest.length) {
      inline.children = rest;
      tokens.splice(i + 1, 0, ...line);
    } else {
      // The name sat alone in its paragraph (`> **Name:**` then a blank `>`).
      tokens.splice(i + 1, 3, ...line);
    }
  }
}

export function quoteSpeakers(md: MarkdownIt): void {
  md.core.ruler.push("quote_speakers", markQuotes);
}
