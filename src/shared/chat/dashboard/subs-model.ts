// The Subchats card's rules (docs/chat-dashboard-design.md, "Subchats card"),
// pure so they test on plain arrays: which subs the card lists and which fold
// under "+N earlier", and the one palette every model battery in the app uses
// for effort.

/** Working, queued and asking subs are always listed; a finished one stays for
 *  an hour after it finished. A DISPLAY rule only: nothing here closes a sub,
 *  so a folded sub stays resumable and keeps its context. */
export const FINISHED_KEEP_MS = 60 * 60 * 1000;

/** What a sub is doing, honestly: `working` means a turn is running. Queued (no
 *  process yet), paused, at its usage limit and stopped-without-finishing are the
 *  four ways a sub is NOT making progress (docs/chat-dashboard-design.md, "Seeing
 *  what subs are doing"); each draws a dim ring and a corner glyph. */
export type SubCardKind = "asking" | "working" | "queued" | "paused" | "limited" | "stopped" | "finished";

/** The kinds that are not progressing and not asking: the dim ring plus glyph. */
export const IDLE_KINDS: ReadonlySet<SubCardKind> = new Set<SubCardKind>(["queued", "paused", "limited", "stopped"]);

/** What the avatar's hover card says about a sub. Plain data so the card is a
 *  pure string function (views/sessions/sidebar-hover-card-html.ts). */
export interface SubHover {
  /** The state in words: "Working", "Queued", "Paused", "Usage limit", "Stopped without finishing". */
  stateWord: string;
  /** The plan step it is on: `{ n: 3, total: 6, text: "Wire the footer" }`. */
  step: { n: number; total: number; text: string } | null;
  /** Its latest tool call in words and when (epoch ms): "Editing footer.css". */
  action: { text: string; at: number } | null;
  /** A queued sub: what it waits for, its place in the writer line (1 = next) and who holds the slot. */
  queue: { waitingFor: string | null; place: number | null; behind: string | null } | null;
  /** Epoch ms a usage-limited sub resumes, or null when unknown. */
  resetsAt: number | null;
  /** Gaming mode parked it rather than Joe pausing it. */
  gaming: boolean;
}

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
  /** The hover card's lines. Absent on an item built by a caller that only needs the state. */
  hover?: SubHover;
}

export interface SubsState {
  /** Working, queued and asking first, then finished ones still inside the hour, newest first. */
  shown: SubCardItem[];
  /** Finished subs past the hour, newest first: the "+N earlier" list. */
  earlier: SubCardItem[];
  /** When the next shown finished sub folds, so the view can redraw on time. */
  foldsAt: number | null;
}

const KIND_ORDER: Record<SubCardKind, number> = { asking: 0, working: 1, queued: 2, paused: 3, limited: 4, stopped: 5, finished: 6 };

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

// ---- Counts ------------------------------------------------------------------------

/** How many subs are in each unfinished state. */
export type SubCounts = Record<Exclude<SubCardKind, "finished">, number>;

/** The counts of a chat's unfinished subs, or null when it has none (every sub finished, or no
 *  subs), which is when the Plan card's foot keeps its plain idle line. */
export function countSubs(items: ReadonlyArray<Pick<SubCardItem, "kind">>): SubCounts | null {
  const c: SubCounts = { working: 0, asking: 0, queued: 0, paused: 0, limited: 0, stopped: 0 };
  let any = false;
  for (const i of items) {
    if (i.kind === "finished") continue;
    c[i.kind] += 1;
    any = true;
  }
  return any ? c : null;
}

const COUNT_WORDS: ReadonlyArray<readonly [keyof SubCounts, string]> = [
  ["working", "working"], ["asking", "asking"], ["queued", "queued"], ["paused", "paused"], ["limited", "at usage limit"], ["stopped", "stopped"],
];

/** "2 working · 2 asking · 2 queued · 3 stopped": the states with nobody in them are left out. */
export function subCountsText(c: SubCounts): string {
  return COUNT_WORDS.filter(([k]) => c[k] > 0).map(([k, word]) => `${c[k]} ${word}`).join(" · ");
}

/** "18s ago", "4m ago", "2h ago": how long since a sub's last action. */
export function formatActionAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
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
