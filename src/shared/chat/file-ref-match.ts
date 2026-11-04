// Recognising an absolute file path in text, apart from the chips in file-refs.ts:
// chat-transforms needs the matcher for its markdown instances, and file-refs.ts
// pulls in menus and IPC that the markdown renderer has no use for.

import type MarkdownIt from "markdown-it";

// Windows drive path or a Unix absolute path with at least 3 segments. The
// lookbehinds keep a URL (`https://a/b/c`, `://` and `m/a/b/c`) and a path glued
// to a word from matching; `:` is excluded from the body so the optional
// `:line[:col]` suffix is explicit and a trailing sentence colon is not eaten.
// `& ^ % !` join the excluded set because the path can reach `cmd /C code` on
// Windows, where they are command syntax (the Rust side refuses them too).
const WIN = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|&^%!*?:` + "`" + String.raw`()\[\]{},;]+`;
const UNIX = String.raw`(?<![\w./:~@-])\/(?:[\w.@+~-]+\/){2,}[\w.@+~-]+`;
// 9 digits max so the value fits the backend's u32; an overlong number drops
// the whole suffix (the trailing lookahead forces the backtrack) rather than
// carrying a truncated line.
const SUFFIX = String.raw`(?::\d{1,9}(?::\d{1,9})?)?(?!\d)`;
const PATH_RE = new RegExp(`(?:${WIN}|${UNIX})${SUFFIX}`, "g");

export interface FileRef {
  path: string;
  line: number | null;
  col: number | null;
  /** Source text as written, including any `:line:col`. */
  text: string;
  index: number;
}

function refFrom(raw: string, index: number): FileRef | null {
  const suffix = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(raw)!;
  const path = suffix[1]!;
  // A Windows path needs a name after the drive and slash, not just `C:\`.
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return null;
  return { path, line: suffix[2] ? Number(suffix[2]) : null, col: suffix[3] ? Number(suffix[3]) : null, text: raw, index };
}

/** Finds paths in plain text; trailing sentence punctuation is not part of one. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    // A closing `_` of `_C:\a\b.txt_` emphasis is not part of the path. Cost: a
    // file whose name really ends in `_` loses it, a rarer case than Claude
    // wrapping a path in underscores; `__init__.txt` is safe since the dot
    // follows the `_`. Looking for an unmatched opener instead would keep that
    // file, with more logic than the case earns.
    const raw = m[0].replace(/[.\-+~@_]+$/, "");
    const ref = refFrom(raw, m.index);
    if (ref) out.push(ref);
  }
  return out;
}

// Same exclusions as WIN/UNIX (`& ^ % !` stay out for `cmd /C code`), except a
// space and `()` are allowed: `C:\Program Files (x86)\a.txt`. The Rust side
// allows parentheses and refuses only & | ^ % < > " and line breaks.
const WHOLE_WIN = String.raw`[A-Za-z]:[\\/][^"'<>|&^%!*?:` + "`" + String.raw`\[\]{},;\t\r\n]+`;
const WHOLE_UNIX = String.raw`\/(?:[\w.@+~ -]+\/){2,}[\w.@+~ -]+`;
const WHOLE_RE = new RegExp(`^(?:${WHOLE_WIN}|${WHOLE_UNIX})${SUFFIX}$`);

/** The inline-code span `text` when the whole of it is ONE path that contains a
 *  space (`C:\Program Files\x.txt`), else null. Prose cannot do this: `see
 *  C:\foo and bar.txt` is not told apart from a folder named `foo and bar.txt`,
 *  but a code span holding only a path is unambiguous. Only a space inside a
 *  folder name counts, so a command (`/usr/bin/env python`, `C:\x\run.exe --v`,
 *  `C:\x\a.txt | head`) is left to the prose matcher, which chips its path alone. */
export function wholeSpanFileRef(text: string): FileRef | null {
  const raw = text.trim();
  if (!raw.includes(" ") || !WHOLE_RE.test(raw)) return null;
  const body = raw.replace(/:\d+(?::\d+)?$/, "");
  // The final segment has no space: `C:\My Dir` or `/usr/bin/env python` could
  // as well be a path followed by an argument.
  if (/ /.test(body.slice(Math.max(body.lastIndexOf("\\"), body.lastIndexOf("/"))))) return null;
  // A token after a space that opens like a flag or a second path is a command.
  if (raw.split(" ").slice(1).some((t) => /^[-/\\]/.test(t))) return null;
  return refFrom(raw, text.indexOf(raw));
}

/** Markdown leaves a file path as written. Unguarded, `\.` and `\_` are escapes
 *  that drop the backslash (`C:\Users\x\.claude` renders as `C:\Users\x.claude`)
 *  and `__init__` turns bold, so the chip built from the rendered text opens a
 *  path that does not exist. */
export function keepFilePathsLiteral(md: MarkdownIt): void {
  let src: string | null = null;
  let refs: FileRef[] = [];
  // Before `text`, whose stops land on the first markdown-significant character
  // inside a path (`:` of a drive, `_` of a Unix folder), so the check sees every
  // one of them; by then `text` has consumed the path's plain start as literal.
  md.inline.ruler.before("text", "file_path_literal", (state, silent) => {
    // Parsed once per inline block: this rule runs at every stop, and renders
    // are synchronous, so the last block's matches stay valid until src changes.
    if (state.src !== src) {
      src = state.src;
      refs = findFileRefs(src);
    }
    const ref = refs.find((r) => state.pos >= r.index && state.pos < r.index + r.text.length);
    if (!ref) return false;
    // A link label narrows posMax to its closing bracket.
    const end = Math.min(ref.index + ref.text.length, state.posMax);
    if (!silent) state.pending += state.src.slice(state.pos, end);
    state.pos = end;
    return true;
  });
}
