// The pure half of "Turn into a project" (turn-into-project.ts): who is offered the action, and the
// rows the dialog shows. Kept apart from the dialog so the menu can ask without loading it.

import { isNoProjectPath } from "../../shared/no-project";
import { isRemote } from "../../shared/transport";
import type { Instance } from "../../types/ipc.generated";
import { isMirrored, isSubchat } from "./sessions-helpers";

export interface PromoteMoved {
  subs: number;
  remote_subs: number;
  cards: number;
}

export interface PromotePreview {
  moved: PromoteMoved;
  stays_behind: string[];
}

export interface Promoted {
  project_id: string;
  project_path: string;
  successor_id: string;
  forked: boolean;
  moved: PromoteMoved;
  stays_behind: string[];
}

/** Whether the chat menu offers the action: an open, ordinary chat of this machine whose folder is
 *  the No project one. A project chat is already in a project; a sub is moved to the sidebar first. */
export function canTurnIntoProject(chat: Instance | undefined, cwd: string | null | undefined): boolean {
  if (!chat || isRemote() || !isNoProjectPath(cwd ?? chat.cwd)) return false;
  return !chat.ended_at && !chat.end_reason && !isSubchat(chat) && !isMirrored(chat);
}

/** The "Moves with it" rows, as real counts the user can weigh. An empty family still says the
 *  conversation goes, since that is the point of the action. */
export function movedRows(moved: PromoteMoved): string[] {
  const subs = moved.subs + moved.remote_subs;
  const rows = ["The conversation, copied into the new main chat"];
  if (subs > 0) rows.push(`${subs} sub${subs === 1 ? "" : "s"}, still running or finished`);
  if (moved.cards > 0) rows.push(`${moved.cards} sub card${moved.cards === 1 ? "" : "s"}`);
  rows.push("The decisions log, Answers and previews");
  return rows;
}

/** The folder's own name, which is what the project is called. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? path;
}
