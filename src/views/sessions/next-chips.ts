// Which quick-reply chips sit above a chat's message box. Pure (no DOM, no IPC)
// so every gate can be unit-tested; next-chip-strip.ts renders the result.
import type { Instance } from "../../types/ipc.generated";
import { MAX_NEXT_ACTIONS } from "../../shared/chat/chat-next-actions";

// The built-in /close plus the model's up to MAX_NEXT_ACTIONS replies (the tool
// schema promises it three), so a full set of replies is never cut to two.
export const MAX_NEXT_CHIPS = 1 + MAX_NEXT_ACTIONS;

const CLOSE = "/close";

export interface NextChipsCtx {
  /** Settings > Chat defaults > Quick reply chips. */
  enabled: boolean;
  /** The open chat's registry row; undefined for a draft or an unknown id. */
  inst: Pick<Instance, "awaiting" | "busy" | "closing" | "ended_at" | "frozen" | "kind"> | undefined;
  /** The "Waiting to send" bar is up: a held message is about to go out. */
  hasHeld: boolean;
  /** Replies Claude attached to its last message this turn (parseNextActions). */
  nextActions?: readonly string[];
  /** What the open chat is to the subchats mode. A main chat is told never to close
   *  by itself and a sub's job ends with its finish tool, so the built-in /close
   *  offer fits neither; an ordinary chat (absent) gets it. */
  role?: "main" | "sub";
}

/** A finished turn is `awaiting === "done"` in the registry. It is cleared on
 *  every send, so a chip never outlives the turn it was offered for. */
function turnFinished(inst: NonNullable<NextChipsCtx["inst"]>): boolean {
  if (inst.awaiting !== "done") return false;
  if (inst.busy || inst.closing || inst.frozen || inst.ended_at) return false;
  // A read-only chat has no composer to fill.
  return inst.kind !== "external" && inst.kind !== "automated";
}

/** A slash chip puts its command at the front of the box; a text chip is a reply. */
export function isSlashChip(chip: string): boolean {
  return chip.startsWith("/");
}

/** The draft after clicking a text-reply chip. A reply goes above what was
 *  typed, never over it, and a second click on the same chip must not stack it
 *  twice. A draft led by a slash command keeps the command first (the daemon
 *  only runs a prompt as a command when it starts with it), so the reply goes
 *  on a line below instead of above. */
export function withReply(draft: string, chip: string): string {
  if (draft.trim() === "") return chip;
  if (isSlashChip(draft.trimStart())) {
    return draft.split("\n").includes(chip) ? draft : `${draft.trimEnd()}\n${chip}`;
  }
  return draft.startsWith(chip) ? draft : `${chip}\n${draft}`;
}

export function nextChips(ctx: NextChipsCtx): string[] {
  if (!ctx.enabled || ctx.hasHeld || !ctx.inst || !turnFinished(ctx.inst)) return [];
  const chips: string[] = [];
  const isClose = (action: string): boolean => action.split(/\s/, 1)[0]!.toLowerCase() === CLOSE;
  // A main chat gets /close only when its own latest reply asks for it (its prompt
  // keeps it open until Joe says so); a sub never does, whatever it wrote.
  const askedClose = (ctx.nextActions ?? []).some(isClose);
  const offerClose = ctx.role === "main" ? askedClose : ctx.role !== "sub";
  if (offerClose) chips.push(CLOSE);
  for (const action of ctx.nextActions ?? []) {
    // The strip already offers /close; a model-written one would duplicate it.
    if (isClose(action)) continue;
    if (!chips.some((c) => c.toLowerCase() === action.toLowerCase())) chips.push(action);
  }
  return chips.slice(0, MAX_NEXT_CHIPS);
}
