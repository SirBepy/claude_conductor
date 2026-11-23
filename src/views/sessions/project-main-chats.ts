// A project knows its main chat (`ProjectConfig.main_chat_id`, kept true by the
// daemon's `subchats/main_pointer.rs`). Two surfaces read it: the new-chat draft,
// which sends to the project's main chat instead of starting a chat of its own, and
// the sidebar, whose Main chats group lists one row per project.
//
// The pointer is read from the project list, not from the chats: the daemon sets it
// when a main chat starts and clears it when the chat closes, and it can lag a crash
// by up to its 60 second heal, so every reader here also checks the chat it names is
// still live before trusting it.

import { api } from "../../shared/api";
import type { Instance } from "../../types/ipc.generated";
import { isSubchatsOn } from "./permission-modal/gating";
import { sessionSubtitle } from "./sessions-helpers";
import { pausedSubs } from "./put-away";
import { isNoProjectPath } from "../../shared/no-project";

interface PointerRow {
  id: string;
  path: string;
  name: string;
  mainChatId: string | null;
}

let rows: PointerRow[] = [];
const listeners = new Set<() => void>();

/** Run `cb` after the pointers were re-read. The draft's "Goes to" line and the
 *  sidebar's Main chats group both repaint from it. */
export function onProjectMainChatsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function samePath(a: string, b: string): boolean {
  const key = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key(a) === key(b);
}

/** (Re)reads every project's pointer. Safe to call often: a failed read keeps what
 *  was there, so a flaky link never turns every project back into "no main chat". */
export async function loadProjectMainChats(): Promise<void> {
  try {
    const list = (await api.listProjects()) as unknown as Array<{
      id: string;
      path: string;
      name: string;
      main_chat_id?: string | null;
    }>;
    rows = (list ?? []).map((p) => ({ id: p.id, path: String(p.path), name: p.name, mainChatId: p.main_chat_id ?? null }));
    for (const cb of listeners) cb();
  } catch (e) {
    console.warn("[main-chats] pointer read failed:", e);
  }
}

/** The "No project" folder: every main chat started there stands alone (its own Plan card, subs and
 *  put-away), so the project has no single main chat for a new chat to go to and no pointer that
 *  decides which of them is "the" main chat. */
function standsAlone(projectId: string): boolean {
  const row = rows.find((r) => r.id === projectId);
  return !!row && isNoProjectPath(row.path);
}

function isOpen(s: Instance): boolean {
  return !s.ended_at && !(s as { end_reason?: unknown }).end_reason && !s.subchat_of;
}

/** The chat a project points at while it is still open and in main-chat mode, even one
 *  that is closing. A pointer at a chat without the mode is stale (the daemon's heal can
 *  lag a flip), and trusting it would drop the project's real main chats from the group. */
function pointedChat(projectId: string, sessions: readonly Instance[]): Instance | null {
  const id = rows.find((r) => r.id === projectId)?.mainChatId;
  const chat = id ? sessions.find((s) => s.session_id === id) : undefined;
  return chat && isOpen(chat) && isSubchatsOn(chat.session_id) ? chat : null;
}

export interface ProjectMainChat {
  chat: Instance;
  projectName: string;
}

/** Where a new chat in the project at `projectPath` goes: its main chat, when the
 *  pointer names a chat that is still open, not on its way out, and in main-chat mode.
 *  Null for every other case, including a pointer that is not loaded yet, which
 *  leaves the draft the ordinary chat it always was. */
export function mainChatFor(projectPath: string, sessions: readonly Instance[]): ProjectMainChat | null {
  const row = rows.find((r) => samePath(r.path, projectPath));
  if (!row || standsAlone(row.id)) return null;
  const chat = pointedChat(row.id, sessions);
  // A put-away chat keeps the pointer (the daemon's reopen needs it) but cannot take a message: the
  // draft is then an ordinary chat, not a send the daemon would refuse with PUT_AWAY.
  if (!chat || chat.closing || chat.hidden_at || !isSubchatsOn(chat.session_id)) return null;
  return { chat, projectName: row.name };
}

/** A put-away main chat a new chat in the project would reopen, with how many subs the
 *  pause left. `mainChatFor` skips it (the daemon refuses a message into a put-away
 *  chat), so a draft asks this next. Null when the pointer names no put-away chat. */
export interface ReopenTarget extends ProjectMainChat {
  paused: number;
}

export function reopenTargetFor(projectPath: string, sessions: readonly Instance[]): ReopenTarget | null {
  const row = rows.find((r) => samePath(r.path, projectPath));
  if (!row || standsAlone(row.id)) return null;
  const chat = pointedChat(row.id, sessions);
  if (!chat || chat.closing || !chat.hidden_at || chat.machine) return null;
  return { chat, projectName: row.name, paused: pausedSubs(chat.session_id, sessions).length };
}

/** The project's main chat for the dashboard's "Open main chat" door: the pointed chat whether it
 *  is live or put away, so the door is the one deliberate way to it. Null with no open main chat. */
export function openableMainFor(projectPath: string, sessions: readonly Instance[]): { chat: Instance; putAway: boolean; paused: number } | null {
  const row = rows.find((r) => samePath(r.path, projectPath));
  if (!row || standsAlone(row.id)) return null;
  const chat = pointedChat(row.id, sessions);
  if (!chat || chat.closing || chat.machine) return null;
  const putAway = !!chat.hidden_at;
  return { chat, putAway, paused: putAway ? pausedSubs(chat.session_id, sessions).length : 0 };
}

/** The draft's reopen line: "Reopens <title>: paused, 3 subs" (just "Reopens <title>" when nothing is paused). */
export function reopenLine(t: ReopenTarget): { title: string; paused: string } {
  const n = t.paused;
  return { title: sessionSubtitle(t.chat), paused: n === 0 ? "" : `: paused, ${n} ${n === 1 ? "sub" : "subs"}` };
}

/** Whether a main chat gets a row of its own in the sidebar's Main chats group: the
 *  project's pointed chat does, and so does any main chat whose project has no open
 *  pointer (before the pointers load, or a phone that cannot read them). A second
 *  chat that also has the mode on draws in the group it would otherwise sit in. */
export function listedAsProjectMain(s: Instance, sessions: readonly Instance[]): boolean {
  if (standsAlone(s.project_id)) return true;
  const pointed = pointedChat(s.project_id, sessions);
  return !pointed || pointed.session_id === s.session_id;
}

/** Whether `s` is the chat its project's pointer names, still open and in main-chat mode: the
 *  one chat whose close is a put-away (daemon `put_away::is_project_main_chat`). Unlike
 *  `listedAsProjectMain` this is false while the pointers are not loaded, because offering
 *  "Put away" on a chat the daemon would really close hides a destructive close behind a soft word. */
export function isPointedMainChat(s: Instance, sessions: readonly Instance[]): boolean {
  // The daemon's `is_project_main_chat` also needs an interactive chat.
  if (s.machine || s.subchat_of || s.kind !== "interactive") return false;
  // Every open main chat in "No project" is its own; the daemon's `is_no_project_main` says the same.
  if (standsAlone(s.project_id)) return isOpen(s) && isSubchatsOn(s.session_id);
  return pointedChat(s.project_id, sessions)?.session_id === s.session_id;
}

/** The "Goes to ..." line's text, escaped for markup. */
export function goesToLine(main: ProjectMainChat): { title: string; project: string } {
  return { title: sessionSubtitle(main.chat), project: main.projectName };
}

/** Test seam: replaces the loaded pointers. */
export function setProjectMainChatsForTest(next: Array<{ id: string; path: string; name: string; mainChatId: string | null }>): void {
  rows = next;
  for (const cb of listeners) cb();
}
