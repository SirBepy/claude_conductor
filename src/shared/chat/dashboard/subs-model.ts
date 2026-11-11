// The Subchats card's rules (docs/chat-dashboard-design.md, "Subchats card"),
// pure so they test on plain arrays: which subs the card lists and which fold
// under "+N earlier", and the one palette every model battery in the app uses
// for effort.

/** Working, queued and asking subs are always listed; a finished one stays for
 *  an hour after it finished. A DISPLAY rule only: nothing here closes a sub,
 *  so a folded sub stays resumable and keeps its context. */
export const FINISHED_KEEP_MS = 60 * 60 * 1000;

export type SubCardKind = "asking" | "working" | "queued" | "finished";

export interface SubCardItem {
  id: string;
  name: string;
  kind: SubCardKind;
  /** Being closed: it reads green like a finished one but is not finished yet. */
  closing: boolean;
  model: string;
  effort: string;
  /** "step 3 of 6", "needs your input": the state in words. */
  progress: string;
  /** ISO start of the sub's row, for the run time. */
  startedAt: string | null;
  /** Epoch ms of the sub's latest finish, or null when nothing dates it. */
  finishedAt: number | null;
  /** The ring the avatar draws (a RingSpec of views/sessions/sidebar-ring.ts;
   *  opaque here, the model never reads it). */
  ring: unknown;
}

export interface SubsState {
  /** Working, queued and asking first, then finished ones still inside the hour, newest first. */
  shown: SubCardItem[];
  /** Finished subs past the hour, newest first: the "+N earlier" list. */
  earlier: SubCardItem[];
  /** When the next shown finished sub folds, so the view can redraw on time. */
  foldsAt: number | null;
}

const KIND_ORDER: Record<SubCardKind, number> = { asking: 0, working: 1, queued: 2, finished: 3 };

/** A finished sub is past its hour only when its finish time is KNOWN to be old.
 *  One with no date is kept out of the way (older than anything we can prove),
 *  except while it is still closing. */
export function isFolded(it: Pick<SubCardItem, "kind" | "closing" | "finishedAt">, now: number): boolean {
  if (it.kind !== "finished" || it.closing) return false;
  if (it.finishedAt === null) return true;
  return now - it.finishedAt >= FINISHED_KEEP_MS;
}

/** The card's state, or null when there is nothing to list and nothing folded. */
export function buildSubsState(items: readonly SubCardItem[], now: number): SubsState | null {
  const byNewest = (a: SubCardItem, b: SubCardItem): number => (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
  const live = items.filter((i) => i.kind !== "finished" || !isFolded(i, now));
  const earlier = items.filter((i) => isFolded(i, now)).sort(byNewest);
  const shown = [
    ...live.filter((i) => i.kind !== "finished").sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
    ...live.filter((i) => i.kind === "finished").sort(byNewest),
  ];
  if (shown.length === 0 && earlier.length === 0) return null;
  const folds = shown.filter((i) => i.kind === "finished" && !i.closing && i.finishedAt !== null).map((i) => i.finishedAt! + FINISHED_KEEP_MS);
  return { shown, earlier, foldsAt: folds.length > 0 ? Math.min(...folds) : null };
}

// ---- Effort palette --------------------------------------------------------------

/** The efforts that tint a battery (Joe, 2026-11-10). `high` is the default and 99% of
 *  use, so it keeps the battery's own grey. The colours are the `--effort-*` vars in
 *  effort-battery.css, their one owner: this set only says which efforts have one.
 *  The colour sits on the battery and not on the ring, so a max-effort working sub
 *  never reads as asking. */
export const TINTED_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "xhigh", "max"]);

/** The `data-effort` value an effort tints its battery with, or null for the default grey. */
export function tintedEffort(effort: string | null | undefined): string | null {
  const e = String(effort ?? "").trim().toLowerCase();
  return TINTED_EFFORTS.has(e) ? e : null;
}

/** "mm:ss" under an hour, "h:mm:ss" past it. */
export function formatRunTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
