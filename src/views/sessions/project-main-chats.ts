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
  if (!row) return null;
  const chat = pointedChat(row.id, sessions);
  if (!chat || chat.closing || !isSubchatsOn(chat.session_id)) return null;
  return { chat, projectName: row.name };
}

/** Whether a main chat gets a row of its own in the sidebar's Main chats group: the
 *  project's pointed chat does, and so does any main chat whose project has no open
 *  pointer (before the pointers load, or a phone that cannot read them). A second
 *  chat that also has the mode on draws in the group it would otherwise sit in. */
export function listedAsProjectMain(s: Instance, sessions: readonly Instance[]): boolean {
  const pointed = pointedChat(s.project_id, sessions);
  return !pointed || pointed.session_id === s.session_id;
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
