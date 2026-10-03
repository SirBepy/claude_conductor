// Code mode in its own OS window (`session-code`, desktop only). The chat
// window that popped it out stays the source of truth for the chat itself
// (title, busy, latest line, this chat's edits) and streams that across as
// Tauri events; the Code window streams back mention / focus / dock asks.

import { invoke } from "../../../shared/ipc";
import type { FileEditView } from "../../../shared/chat/file-edits";
import type { Instance } from "../../../types/ipc.generated";
import {
  closeCodeMode,
  isCodeModeOpen,
  openCodeMode,
  restoreView,
  snapshotView,
  type CodeModeChat,
  type CodeModeTarget,
  type ViewSnapshot,
} from "./code-mode";
import { currentCodeModeChat, popOut, rememberPopOut } from "./entry";

/** A CodeModeTarget that survives JSON: a PR's description template travels
 *  as its HTML. */
type WireTarget =
  | Exclude<CodeModeTarget, { kind: "pr" }>
  | { kind: "pr"; title: string; commits: { sha: string; msg: string }[]; descHtml: string | null };

interface ChatState {
  sessionId: string;
  owner: string;
  cwd: string;
  title: string;
  busy: boolean;
  line: string;
  /** Omitted when unchanged since the last state, to keep per-second ticks small. */
  edits?: FileEditView[];
  snap?: ViewSnapshot | null;
  target?: WireTarget;
}

function toWire(t: CodeModeTarget): WireTarget {
  return t.kind === "pr" ? { kind: "pr", title: t.title, commits: t.commits, descHtml: t.desc?.innerHTML ?? null } : t;
}

function fromWire(t: WireTarget): CodeModeTarget {
  if (t.kind !== "pr") return t;
  let desc: HTMLTemplateElement | null = null;
  if (t.descHtml !== null) {
    desc = document.createElement("template");
    desc.innerHTML = t.descHtml;
  }
  return { kind: "pr", title: t.title, commits: t.commits, desc };
}

function myLabel(): string {
  return (window as unknown as { __TAURI__?: { window?: { getCurrentWindow: () => { label: string } } } })
    .__TAURI__?.window?.getCurrentWindow().label ?? "main";
}

function listen<T>(event: string, cb: (payload: T) => void): void {
  void window.__TAURI__?.event?.listen?.<T>(event, (e) => cb(e.payload));
}

function emit(event: string, payload: unknown): void {
  void window.__TAURI__?.event?.emit?.(event, payload);
}

export function isCodeWindow(): boolean {
  return new URLSearchParams(window.location.search).get("codewindow") === "1";
}

// ── chat-window side ────────────────────────────────────────────────────

/** Sessions whose Code mode currently lives in the Code window. */
const popped = new Set<string>();
/** Handed to the Code window on its first hello for that session. */
const handoff = new Map<string, { snap: ViewSnapshot | null; target: WireTarget }>();
let ownerWired = false;
let lastSig = "";
let lastEditsLen = -1;

function stateFor(chat: CodeModeChat, full: boolean): ChatState {
  const edits = chat.edits();
  const s: ChatState = {
    sessionId: chat.sessionId!,
    owner: myLabel(),
    cwd: chat.cwd,
    title: chat.title(),
    busy: chat.busy(),
    line: chat.latestLine(),
  };
  if (full || edits.length !== lastEditsLen) s.edits = edits;
  lastEditsLen = edits.length;
  return s;
}

function chatFor(sessionId: string): CodeModeChat | null {
  const chat = currentCodeModeChat();
  return chat?.sessionId === sessionId ? chat : null;
}

function wireOwner(): void {
  if (ownerWired) return;
  ownerWired = true;
  listen<{ sessionId: string }>("code-mode:hello", ({ sessionId }) => {
    const chat = chatFor(sessionId);
    if (!chat) return;
    popped.add(sessionId);
    const h = handoff.get(sessionId);
    handoff.delete(sessionId);
    emit("code-mode:state", { ...stateFor(chat, true), snap: h?.snap ?? snapshotView(chat.key), target: h?.target });
  });
  listen<{ owner: string }>("code-mode:focus-chat", ({ owner }) => {
    if (owner === myLabel()) void invoke("focus_app_window", { label: owner }).catch(() => {});
  });
  listen<{ sessionId: string; owner: string; path: string }>("code-mode:mention", ({ sessionId, owner, path }) => {
    if (owner !== myLabel()) return;
    chatFor(sessionId)?.mention?.(path);
    void invoke("focus_app_window", { label: owner }).catch(() => {});
  });
  listen<{ sessionId: string }>("code-mode:git-changed", ({ sessionId }) => chatFor(sessionId)?.onGitChanged?.());
  listen<{ sessionId: string; owner: string; snap: ViewSnapshot | null }>("code-mode:dock", ({ sessionId, owner, snap }) => {
    if (owner !== myLabel()) return;
    popped.delete(sessionId);
    rememberPopOut(false);
    const chat = chatFor(sessionId);
    if (!chat) return;
    if (snap) restoreView(chat.key, chat.cwd, snap);
    openCodeMode(chat, { kind: "default" }, { popOut: () => popOut(chat) });
    void invoke("focus_app_window", { label: owner }).catch(() => {});
  });
  listen("code-window-closed", () => popped.clear());
  // Keep the Code window's back pill live: the chat's title, whether Claude
  // is writing, its latest line, and (when it changes) this chat's edits.
  window.setInterval(() => {
    const chat = currentCodeModeChat();
    if (!chat?.sessionId || !popped.has(chat.sessionId)) return;
    const s = stateFor(chat, false);
    const sig = JSON.stringify([s.sessionId, s.title, s.busy, s.line, lastEditsLen]);
    if (sig === lastSig && !s.edits) return;
    lastSig = sig;
    emit("code-mode:state", s);
  }, 1000);
}

export function isPoppedOut(sessionId: string): boolean {
  return popped.has(sessionId);
}

export function markPoppedOut(chat: CodeModeChat, snap: ViewSnapshot | null, target: CodeModeTarget): void {
  wireOwner();
  handoff.set(chat.sessionId!, { snap, target: toWire(target) });
  popped.add(chat.sessionId!);
  void invoke("open_code_window", { sessionId: chat.sessionId }).catch((err) => {
    console.error("[code-mode] open_code_window failed", err);
    popped.delete(chat.sessionId!);
    openCodeMode(chat, target);
  });
}

/** An entry (sha, file chip, PR card) while Code mode is popped out: raise
 *  the Code window and send it there. */
export function forwardToCodeWindow(chat: CodeModeChat, target: CodeModeTarget): void {
  emit("code-mode:target", { sessionId: chat.sessionId, target: toWire(target) });
  void invoke("open_code_window", { sessionId: chat.sessionId }).catch(() => {});
}

// ── Code window side ────────────────────────────────────────────────────

let windowSession: string | null = null;
let windowState: ChatState | null = null;
let windowEdits: FileEditView[] = [];
let windowLayout: HTMLElement | null = null;

export function dockFromCodeWindow(): void {
  if (!windowSession || !windowState) return;
  emit("code-mode:dock", { sessionId: windowSession, owner: windowState.owner, snap: snapshotView(windowSession) });
  closeCodeMode();
  void invoke("close_code_window").catch(() => {});
}

function proxyChat(layout: HTMLElement): CodeModeChat {
  const sessionId = windowSession!;
  return {
    key: sessionId,
    sessionId,
    cwd: windowState!.cwd,
    layout,
    title: () => windowState?.title ?? "",
    busy: () => windowState?.busy ?? false,
    latestLine: () => windowState?.line ?? "",
    edits: () => windowEdits,
    mention: (path) => emit("code-mode:mention", { sessionId, owner: windowState?.owner, path }),
    onGitChanged: () => emit("code-mode:git-changed", { sessionId }),
  };
}

function hooks() {
  return {
    dock: dockFromCodeWindow,
    focusChat: () => emit("code-mode:focus-chat", { owner: windowState?.owner }),
  };
}

function openInWindow(target: CodeModeTarget, snap: ViewSnapshot | null | undefined): void {
  const chat = proxyChat(windowLayout!);
  if (snap) restoreView(chat.key, chat.cwd, snap);
  document.title = `Code · ${windowState?.title ?? ""}`;
  openCodeMode(chat, target, hooks());
}

/** No chat window answered (it moved on to another chat, or was closed):
 *  open from the session's registry row, with no live chat behind it. */
async function fallbackOpen(sessionId: string): Promise<void> {
  if (windowState || windowSession !== sessionId) return;
  const rows = await invoke<Instance[]>("list_instances").catch(() => [] as Instance[]);
  const row = rows.find((r) => r.session_id === sessionId);
  if (!row?.cwd || windowState || windowSession !== sessionId) return;
  windowState = { sessionId, owner: "main", cwd: String(row.cwd), title: row.name ?? "", busy: row.busy, line: "" };
  openInWindow({ kind: "default" }, null);
}

function hello(sessionId: string): void {
  windowSession = sessionId;
  windowState = null;
  windowEdits = [];
  emit("code-mode:hello", { sessionId });
  window.setTimeout(() => void fallbackOpen(sessionId), 2000);
}

export function mountCodeWindow(app: HTMLElement, sessionId: string): void {
  app.innerHTML = `<div class="code-window-layout"></div>`;
  windowLayout = app.querySelector<HTMLElement>(".code-window-layout")!;
  listen<ChatState>("code-mode:state", (s) => {
    if (s.sessionId !== windowSession) return;
    const first = !windowState;
    windowState = s;
    if (s.edits) windowEdits = s.edits;
    if (first) openInWindow(s.target ? fromWire(s.target) : { kind: "default" }, s.snap);
  });
  listen<{ sessionId: string; target: WireTarget }>("code-mode:target", ({ sessionId, target }) => {
    if (sessionId !== windowSession || !windowState) return;
    openCodeMode(proxyChat(windowLayout!), fromWire(target), hooks());
  });
  listen<{ sessionId: string }>("code-window-set-session", ({ sessionId: next }) => {
    if (next === windowSession && isCodeModeOpen()) return;
    closeCodeMode();
    hello(next);
  });
  hello(sessionId);
}
