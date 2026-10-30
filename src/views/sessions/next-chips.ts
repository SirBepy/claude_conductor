// Which quick-reply chips sit above a chat's message box. Pure (no DOM, no IPC)
// so every gate can be unit-tested; next-chip-strip.ts renders the result.
import type { Instance } from "../../types/ipc.generated";

export const MAX_NEXT_CHIPS = 3;

const CLOSE = "/close";

export interface NextChipsCtx {
  /** Settings > Chat defaults > Quick reply chips. */
  enabled: boolean;
  /** The open chat's registry row; undefined for a draft or an unknown id. */
  inst: Pick<Instance, "awaiting" | "busy" | "closing" | "ended_at" | "frozen" | "kind"> | undefined;
  /** "Wrap up when done" runs /commit and /close by itself, so the chip would
   *  offer a close the chat is about to do on its own. */
  wrapUp: boolean;
  /** The "Waiting to send" bar is up: a held message is about to go out. */
  hasHeld: boolean;
  /** Replies Claude attached to its last message this turn (parseNextActions). */
  nextActions?: readonly string[];
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

export function nextChips(ctx: NextChipsCtx): string[] {
  if (!ctx.enabled || ctx.hasHeld || !ctx.inst || !turnFinished(ctx.inst)) return [];
  const chips: string[] = [];
  if (!ctx.wrapUp) chips.push(CLOSE);
  for (const action of ctx.nextActions ?? []) {
    // The strip already offers /close; a model-written one would duplicate it,
    // or offer a close the chat's wrap-up is about to do itself.
    if (action.split(/\s/, 1)[0]!.toLowerCase() === CLOSE) continue;
    if (!chips.some((c) => c.toLowerCase() === action.toLowerCase())) chips.push(action);
  }
  return chips.slice(0, MAX_NEXT_CHIPS);
}
