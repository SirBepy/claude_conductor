// The File view's text body: a CodeMirror editor. A working-tree file inside
// a registered project is editable and autosaves shortly after typing stops;
// anything else (a past revision, a file outside every project, one on
// another machine) opens read-only. Loaded lazily by file-surface.ts so
// CodeMirror stays out of the boot bundle. Styles in file-editor.css.

import { EditorState, EditorSelection, Compartment, StateEffect, StateField, Transaction, type Text } from "@codemirror/state";
import {
  EditorView, Decoration, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { SearchCursor } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { invoke } from "../ipc";
import { basename } from "../path-utils";
import { escapeHtml } from "../escape-html";
import type { TextFileData, TextFileStamp } from "../../types/ipc.generated";
import "./file-editor.css";

/** Quiet after typing before the write goes out. */
const SAVE_DELAY_MS = 600;
/** How often an open file checks whether something else changed it on disk. */
const POLL_MS = 1500;
const MAX_MATCHES = 5000;

export type EditorStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "readonly"; reason: string }
  | { kind: "error"; message: string };

export interface EditorOpts {
  /** Absolute path of the working-tree file on this machine; null when the
   *  content is a past revision or lives on another machine. */
  diskPath: string | null;
  /** File name or path: picks the language and names the file in the
   *  changed-on-disk notice. */
  name: string;
  /** Read-only source used when there is no diskPath (or it can't be read). */
  fallback: () => Promise<TextFileData>;
  onStatus: (s: EditorStatus) => void;
}

export interface FileEditor {
  readonly diskPath: string | null;
  text(): string;
  truncated(): boolean;
  /** Marks every match; returns [current index, total]. */
  search(query: string): [number, number];
  step(dir: 1 | -1): [number, number];
  revealLine(line: number): void;
  destroy(): void;
}

/** What survives switching tabs: the editor state (undo history, cursor) and
 *  what is known about the file on disk. One per path, per window. */
interface Session {
  state: EditorState;
  /** mtime of the content `saved` holds on disk. */
  mtime: number;
  saved: Text;
  bom: string;
  readonly: string | null;
  truncated: boolean;
  conflict: boolean;
  /** Scroll position when its tab was last left. */
  scroll: number;
}

const sessions = new Map<string, Session>();

// Only Windows folds case: on Linux (and case-sensitive macOS volumes) `A.md`
// and `a.md` are two files, and sharing one session would show one file's
// text, undo history and unsaved typing in the other's tab.
const keyOf = (p: string) => {
  const slashed = p.replace(/\\/g, "/");
  return navigator.userAgent.includes("Windows") ? slashed.toLowerCase() : slashed;
};

/** Whether a file can round-trip through the editor unchanged. CodeMirror
 *  rejoins lines with one separator, so a file mixing CRLF and LF would be
 *  rewritten whole; U+FFFD means the read replaced bytes that weren't UTF-8. */
export function readonlyReason(content: string, stamp: TextFileStamp, truncated: boolean): string | null {
  if (!stamp.writable) return "Read-only: outside your projects";
  if (truncated) return "Read-only: too large to edit here";
  if (content.includes("\uFFFD")) return "Read-only: not UTF-8 text";
  const crlf = content.includes("\r\n");
  // CodeMirror splits on a lone CR too, so a save would turn each one into
  // the file's main separator.
  if ((crlf && /(^|[^\r])\n/.test(content)) || /\r(?!\n)/.test(content)) return "Read-only: mixed line endings";
  return null;
}

// Mirrors Shiki's github-dark, the theme the diff views use, so a file reads
// the same in its File and Diff views.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "#ff7b72" },
  { tag: [t.string, t.special(t.string), t.regexp, t.url], color: "#a5d6ff" },
  { tag: [t.comment, t.meta], color: "#8b949e", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom, t.null, t.propertyName, t.attributeName, t.constant(t.name)], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: "#ffa657" },
  { tag: [t.tagName, t.angleBracket], color: "#7ee787" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#a5d6ff", textDecoration: "underline" },
  { tag: t.invalid, color: "#f85149" },
]);

// ── search marks ──────────────────────────────────────────────────────

const setMarks = StateEffect.define<DecorationSet>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
const hit = Decoration.mark({ class: "fe-hit" });
const hitCur = Decoration.mark({ class: "fe-hit fe-hit-cur" });

function findAll(doc: Text, query: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const cur = new SearchCursor(doc, query.toLowerCase(), 0, doc.length, (s) => s.toLowerCase());
  while (!cur.next().done && out.length < MAX_MATCHES) out.push({ from: cur.value.from, to: cur.value.to });
  return out;
}

// ── loading ──────────────────────────────────────────────────────────

interface Loaded {
  content: string;
  truncated: boolean;
  stamp: TextFileStamp | null;
}

async function loadFromDisk(path: string): Promise<Loaded> {
  // Stamp first: a write landing between the two reads leaves the stamp
  // older than the content, which the next poll treats as a change.
  const stamp = await invoke<TextFileStamp>("stat_text_file", { path });
  const data = await invoke<TextFileData>("read_text_file", { path });
  return { content: data.content, truncated: data.truncated, stamp };
}

function splitBom(content: string): [string, string] {
  return content.startsWith("\uFEFF") ? ["\uFEFF", content.slice(1)] : ["", content];
}

function crlfOf(content: string): boolean {
  return content.includes("\r\n");
}

export async function openFileEditor(host: HTMLElement, opts: EditorOpts): Promise<FileEditor> {
  const key = opts.diskPath ? keyOf(opts.diskPath) : null;
  let sess = key ? sessions.get(key) ?? null : null;

  if (opts.diskPath && key) {
    let loaded: Loaded | null = null;
    try {
      const stamp = await invoke<TextFileStamp>("stat_text_file", { path: opts.diskPath });
      // A cached session on an unchanged file keeps its undo history; anything
      // newer on disk wins unless the cached copy still has unsaved typing.
      const dirty = sess && sess.state.doc !== sess.saved;
      if (!sess || (stamp.mtime_us !== sess.mtime && !dirty)) loaded = await loadFromDisk(opts.diskPath);
    } catch {
      sess = null;
    }
    if (loaded?.stamp) {
      const [bom, body] = splitBom(loaded.content);
      const reason = readonlyReason(loaded.content, loaded.stamp, loaded.truncated);
      const state = buildState(body, crlfOf(body), reason === null);
      sess = { state, mtime: loaded.stamp.mtime_us, saved: state.doc, bom, readonly: reason, truncated: loaded.truncated, conflict: false, scroll: 0 };
      sessions.set(key, sess);
    }
  }

  if (!sess) {
    const data = await opts.fallback();
    const [bom, body] = splitBom(data.content);
    const state = buildState(body, crlfOf(body), false);
    sess = { state, mtime: 0, saved: state.doc, bom, readonly: "", truncated: data.truncated, conflict: false, scroll: 0 };
  }

  return mountSession(host, opts, sess);
}

const lang = new Compartment();
const editable = new Compartment();
// Its own compartment so a reload can switch it: a chat that rewrites the
// file with the other line ending would otherwise be split by the old one.
const separator = new Compartment();

function separatorExt(crlf: boolean) {
  return crlf ? EditorState.lineSeparator.of("\r\n") : [];
}

function buildState(body: string, crlf: boolean, canEdit: boolean): EditorState {
  return EditorState.create({
    doc: body,
    extensions: [
      // Round-trips a CRLF file as CRLF; without it every line would come
      // back LF and an autosave would rewrite the whole file.
      separator.of(separatorExt(crlf)),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(highlight),
      marksField,
      lang.of([]),
      editable.of(editableExt(canEdit)),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    ],
  });
}

function editableExt(on: boolean) {
  return [EditorState.readOnly.of(!on), EditorView.editable.of(on)];
}

function mountSession(host: HTMLElement, opts: EditorOpts, sess: Session): FileEditor {
  host.innerHTML = `<div class="fe-host"><div class="fe-conflict" hidden></div><div class="fe-cm"></div></div>`;
  const conflictEl = host.querySelector<HTMLElement>(".fe-conflict")!;
  const cmHost = host.querySelector<HTMLElement>(".fe-cm")!;
  const path = opts.diskPath;
  let saveTimer: number | null = null;
  let saving = false;
  let again = false;
  let destroyed = false;
  let matches: { from: number; to: number }[] = [];
  let cur = -1;

  const status = (): void => {
    if (sess.readonly) opts.onStatus({ kind: "readonly", reason: sess.readonly });
    else if (saving) opts.onStatus({ kind: "saving" });
    else opts.onStatus({ kind: "idle" });
  };

  const view = new EditorView({
    state: sess.state,
    parent: cmHost,
    dispatchTransactions(trs, v) {
      v.update(trs);
      sess.state = v.state;
      if (trs.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))) {
        if (matches.length) clearMarks();
        scheduleSave();
      }
    },
  });
  requestAnimationFrame(() => { if (!destroyed) view.scrollDOM.scrollTop = sess.scroll; });
  // Ctrl+S has nothing left to do with autosave, but it must not fall through
  // to the webview's own save-page action.
  cmHost.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save(false);
    }
  });

  const desc = LanguageDescription.matchFilename(languages, basename(opts.name));
  if (desc) {
    void desc.load().then((support) => {
      if (!destroyed) view.dispatch({ effects: lang.reconfigure(support) });
    }).catch(() => {});
  }

  function scheduleSave(): void {
    if (sess.readonly !== null || !path) return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(false), SAVE_DELAY_MS);
  }

  async function save(force: boolean): Promise<void> {
    if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
    if (!path || sess.readonly !== null) return;
    if (sess.conflict && !force) return;
    if (saving) { again = true; return; }
    const doc = sess.state.doc;
    if (doc === sess.saved && !force) return;
    saving = true;
    status();
    try {
      sess.mtime = await invoke<number>("write_text_file", {
        path,
        content: sess.bom + sess.state.sliceDoc(),
        expectedMtimeUs: force ? null : sess.mtime,
      });
      sess.saved = doc;
      sess.conflict = false;
      showConflict(false);
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("CHANGED_ON_DISK")) {
        sess.conflict = true;
        showConflict(true);
      } else {
        opts.onStatus({ kind: "error", message: `Not saved: ${msg}` });
        saving = false;
        return;
      }
    }
    saving = false;
    if (!destroyed) status();
    if (again) { again = false; void save(false); }
  }

  function showConflict(on: boolean): void {
    if (destroyed) return;
    conflictEl.hidden = !on;
    if (!on) { conflictEl.innerHTML = ""; return; }
    conflictEl.innerHTML = `<i class="ph ph-warning"></i><span>${escapeHtml(basename(opts.name))} changed on disk while you were editing.</span>`
      + `<button type="button" class="fe-cbtn" data-act="disk">Load the disk version</button>`
      + `<button type="button" class="fe-cbtn" data-act="mine">Keep mine</button>`;
  }
  conflictEl.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "mine") void save(true);
    else if (act === "disk") void reloadFromDisk(true);
  });

  async function reloadFromDisk(discard: boolean): Promise<void> {
    if (!path) return;
    const loaded = await loadFromDisk(path).catch(() => null);
    if (!loaded?.stamp || destroyed) return;
    if (!discard && sess.state.doc !== sess.saved) return;
    const [bom, body] = splitBom(loaded.content);
    const scroll = view.scrollDOM.scrollTop;
    const head = view.state.selection.main.head;
    // Before the insert: CodeMirror splits inserted text by the separator the
    // transaction starts with.
    const crlf = crlfOf(body);
    if (crlf !== (view.state.lineBreak === "\r\n")) {
      view.dispatch({ effects: separator.reconfigure(separatorExt(crlf)), annotations: Transaction.addToHistory.of(false) });
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: body },
      // Not an undo step and not a save trigger: it is the disk's content.
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
    // Clamped against the doc CodeMirror built, not the raw string: a CRLF
    // break is one character there and two in `body`.
    view.dispatch({ selection: EditorSelection.cursor(Math.min(head, view.state.doc.length)), annotations: Transaction.addToHistory.of(false) });
    view.scrollDOM.scrollTop = scroll;
    sess.bom = bom;
    sess.mtime = loaded.stamp.mtime_us;
    sess.saved = view.state.doc;
    sess.truncated = loaded.truncated;
    // The new content can stop being editable (grown past the cap, a CRLF/LF mix).
    sess.readonly = readonlyReason(loaded.content, loaded.stamp, loaded.truncated);
    view.dispatch({ effects: editable.reconfigure(editableExt(sess.readonly === null)) });
    status();
    sess.conflict = false;
    showConflict(false);
    if (matches.length) clearMarks();
  }

  const poll = window.setInterval(() => {
    if (!path || saving || sess.conflict || document.visibilityState !== "visible") return;
    if (sess.state.doc !== sess.saved) return;
    void invoke<TextFileStamp>("stat_text_file", { path }).then((stamp) => {
      if (!destroyed && stamp.mtime_us !== sess.mtime && !saving) void reloadFromDisk(false);
    }).catch(() => {});
  }, POLL_MS);

  // ── search ────────────────────────────────────────────────────────

  function paintMarks(): void {
    const ranges = matches.map((m, i) => (i === cur ? hitCur : hit).range(m.from, m.to));
    view.dispatch({ effects: setMarks.of(Decoration.set(ranges)) });
    const m = matches[cur];
    if (m) view.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: "center" }) });
  }

  function clearMarks(): void {
    matches = [];
    cur = -1;
    view.dispatch({ effects: setMarks.of(Decoration.none) });
  }

  function search(query: string): [number, number] {
    if (!query) { clearMarks(); return [-1, 0]; }
    matches = findAll(view.state.doc, query);
    // Start from the match at or after the cursor, like VS Code's find.
    const head = view.state.selection.main.head;
    cur = matches.length ? Math.max(0, matches.findIndex((m) => m.from >= head)) : -1;
    paintMarks();
    return [cur, matches.length];
  }

  function step(dir: 1 | -1): [number, number] {
    if (!matches.length) return [-1, 0];
    cur = (cur + dir + matches.length) % matches.length;
    paintMarks();
    return [cur, matches.length];
  }

  function revealLine(line: number): void {
    const n = Math.min(Math.max(1, line), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }

  function destroy(): void {
    if (destroyed) return;
    // Leaving a file flushes its pending write instead of dropping it.
    if (saveTimer !== null) void save(false);
    destroyed = true;
    window.clearInterval(poll);
    sess.state = view.state;
    sess.scroll = view.scrollDOM.scrollTop;
    view.destroy();
    host.innerHTML = "";
  }

  status();
  if (sess.conflict) showConflict(true);

  return {
    diskPath: path,
    text: () => sess.state.sliceDoc(),
    truncated: () => sess.truncated,
    search,
    step,
    revealLine,
    destroy,
  };
}

/** Typed-but-unsaved text the editor holds for `diskPath`, so the rendered
 *  markdown view shows what is being typed. Null once it is saved: the disk
 *  copy is then at least as new, and may hold a chat's later edit. */
export function unsavedText(diskPath: string): string | null {
  const s = sessions.get(keyOf(diskPath));
  return s && s.state.doc !== s.saved ? s.state.sliceDoc() : null;
}
