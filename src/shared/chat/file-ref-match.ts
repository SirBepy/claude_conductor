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

// Prose cannot say where a path with a space ends, so the plain matcher stops at
// the first space: `C:\x\Josip Muzic - CV.pdf` chips as `Josip`. This picks the
// rest back up only when it is unambiguous enough: the cut-off name has no
// extension of its own, and up to 5 more space-separated tokens lead to a
// filename ending in a 2-5 character extension with a letter in it. Tokens may
// carry `\` or `/` so a folder with a space (`C:\Users\Josip Muzic\CV.pdf`) joins
// too. A joining word (`and`, `the`) means prose, not a name, so it stops this,
// and so do two or more all-lowercase words before the last token:
// `C:\out\dir now holds a.txt` is a directory and a sentence. One lowercase
// word still joins, since `meeting notes final.pdf` is a common real name; the
// cost is that a one-word phrase (`dir holding a.txt`) still reads as a name.
const CONTINUATION_RE = /((?: [^\s"'<>|&^%!*?:`()[\]{},;]+){1,5}?\.(?=[A-Za-z0-9]{0,4}[A-Za-z])[A-Za-z0-9]{2,5})(?![\w\\/-])/y;
const PROSE_WORDS = new Set(["a", "an", "and", "or", "the", "to", "in", "on", "at", "as", "is", "of", "for", "with", "then", "but", "into", "from", "by", "if", "so", "also"]);

function spaceContinuation(text: string, end: number, raw: string): string {
  const last = raw.slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1);
  // Nothing to join: the name already has an extension, ends in a separator, or
  // is empty.
  if (!last || last.includes(".")) return "";
  CONTINUATION_RE.lastIndex = end;
  const m = CONTINUATION_RE.exec(text);
  if (!m) return "";
  const tokens = m[1]!.trim().split(" ");
  // A token opening with a separator is a second path, one opening with `-` a
  // flag (a lone `-` is a name's dash): both mean a command, not one name.
  if (tokens.some((t) => PROSE_WORDS.has(t.toLowerCase()) || /^[\\/]|^-./.test(t))) return "";
  if (tokens.slice(0, -1).filter((t) => /^[a-z]+$/.test(t)).length >= 2) return "";
  return m[1]!;
}

/** Finds paths in plain text; trailing sentence punctuation is not part of one. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    // A closing `_` of `_C:\a\b.txt_` emphasis is not part of the path. Cost: a
    // file whose name really ends in `_` loses it, a rarer case than Claude
    // wrapping a path in underscores; `__init__.txt` is safe since the dot
    // follows the `_`. A last segment that opens with as many underscores as the
    // path closes with (`/repo/src/__tests__`, `__pycache__`) is a dunder name,
    // not emphasis, so it keeps them.
    let raw = m[0].replace(/[.\-+~@]+$/, "");
    const closing = /_+$/.exec(raw)?.[0].length ?? 0;
    if (closing) {
      const opening = /^_*/.exec(raw.slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1))![0].length;
      if (opening < closing) raw = raw.replace(/[.\-+~@_]+$/, "");
    }
    // Only a path the matcher took whole (no trimmed tail, no `:line` suffix) can
    // continue past a space.
    if (raw === m[0] && !/:\d+$/.test(raw)) {
      const more = spaceContinuation(text, m.index + raw.length, raw);
      if (more) {
        raw += more;
        PATH_RE.lastIndex = m.index + raw.length;
      }
    }
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
