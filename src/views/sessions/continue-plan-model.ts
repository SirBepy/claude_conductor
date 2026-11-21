// The pure side of "Continue the plan?" (pc-1806 step 6): what a reopened main chat asks
// when something is still paused, and the checklist the "No" answer draws. The daemon's
// `put_away_paused` lists each paused sub with the subs it waits for (`after`); this file
// turns that into the tree the checklist shows and applies the tick rules, so the DOM file
// stays a thin renderer.

/** One paused sub, as `put_away_paused` returns it. */
export interface PausedSubView {
  sub_id: string;
  name: string | null;
  /** What it was doing when the pause froze it: idle, working, held (never started), finished or unknown. */
  prior: string;
  needs_continue: boolean;
  /** The paired machine that runs it, when it does not run here. */
  machine_id: string | null;
  /** The subs it waits for (`after`), whether or not they are in this list. */
  after: string[];
}

/** The daemon's answer to `put_away_paused` and, under `state`, to `reopen_main_chat`. */
export interface PausedFamily {
  hidden: boolean;
  paused: PausedSubView[];
  unreadable?: boolean;
}

/** A row of the checklist: a sub, drawn under the first sub it waits for that is in the list. */
export interface ChecklistRow {
  sub: PausedSubView;
  depth: number;
}

/** How a sub is named in the lines. */
export function subLabel(sub: PausedSubView): string {
  const name = (sub.name ?? "").trim();
  return name || sub.sub_id.slice(0, 8);
}

/** "Was working", "never started": what the pause froze, in words. */
export function priorWords(sub: PausedSubView): string {
  if (sub.prior === "held") return "has not started";
  if (sub.prior === "working" || sub.needs_continue) return "was working";
  if (sub.prior === "idle") return "was between turns";
  return "paused";
}

/** The question's one line: how many subs are paused and what they are. */
export function questionLine(paused: readonly PausedSubView[]): string {
  const n = paused.length;
  if (n === 0) return "";
  const names = paused.slice(0, 3).map(subLabel);
  const more = n > 3 ? `, and ${n - 3} more` : "";
  return `${n} ${n === 1 ? "sub was" : "subs were"} paused when this chat was put away: ${names.join(", ")}${more}.`;
}

/** The subs in checklist order: a sub sits under the first target it waits for that is
 *  itself in the list, so a chain reads as a tree. Subs that wait for nothing listed are roots.
 *  A cycle cannot happen (`after` only points at earlier subs) but never loops here either. */
export function checklistRows(paused: readonly PausedSubView[]): ChecklistRow[] {
  const ids = new Set(paused.map((s) => s.sub_id));
  const parentOf = (s: PausedSubView): string | null => s.after.find((a) => ids.has(a) && a !== s.sub_id) ?? null;
  const rows: ChecklistRow[] = [];
  const seen = new Set<string>();
  const place = (s: PausedSubView, depth: number): void => {
    if (seen.has(s.sub_id)) return;
    seen.add(s.sub_id);
    rows.push({ sub: s, depth });
    for (const child of paused) if (parentOf(child) === s.sub_id) place(child, depth + 1);
  };
  for (const s of paused) if (parentOf(s) === null) place(s, 0);
  // Anything left (only a cycle leaves any) still gets a row.
  for (const s of paused) place(s, 0);
  return rows;
}

/** The subs that wait, directly or through others, for `id` (any depth). */
export function dependentsOf(paused: readonly PausedSubView[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    for (const s of paused) {
      if (seen.has(s.sub_id) || !s.after.includes(at)) continue;
      seen.add(s.sub_id);
      out.push(s.sub_id);
      queue.push(s.sub_id);
    }
  }
  return out;
}

/** The checklist's state: what is ticked, and which ticks the cascade made (so unticking the
 *  target takes its own cascade back, but never a tick the user made by hand). */
export interface Ticks {
  ticked: ReadonlySet<string>;
  auto: ReadonlySet<string>;
}

export const NO_TICKS: Ticks = { ticked: new Set(), auto: new Set() };

/** One click on a row. Ticking a sub ticks everything that waits for it (pre-ticked, and the
 *  user may untick any of them to let it run without that wait); unticking a sub also unticks
 *  the ticks its own cascade made. */
export function toggle(paused: readonly PausedSubView[], now: Ticks, id: string): Ticks {
  const ticked = new Set(now.ticked);
  const auto = new Set(now.auto);
  const deps = dependentsOf(paused, id);
  if (ticked.has(id)) {
    ticked.delete(id);
    auto.delete(id);
    for (const d of deps) {
      if (auto.has(d)) {
        ticked.delete(d);
        auto.delete(d);
      }
    }
  } else {
    ticked.add(id);
    // A tick of its own: the user chose this one, so a parent's untick leaves it.
    auto.delete(id);
    for (const d of deps) {
      if (!ticked.has(d)) {
        ticked.add(d);
        auto.add(d);
      }
    }
  }
  return { ticked, auto };
}

/** Subs that are not ticked but waited for a ticked one: they run without that wait. */
export function releasedSubs(paused: readonly PausedSubView[], ticked: ReadonlySet<string>): PausedSubView[] {
  return paused.filter((s) => !ticked.has(s.sub_id) && s.after.some((a) => ticked.has(a)));
}

/** What the checklist's confirm button says. */
export function confirmLabel(paused: readonly PausedSubView[], ticked: ReadonlySet<string>): string {
  const stop = paused.filter((s) => ticked.has(s.sub_id)).length;
  const keep = paused.length - stop;
  if (stop === 0) return "Resume all";
  if (keep === 0) return `Stop ${stop === 1 ? "it" : `all ${stop}`}`;
  return `Stop ${stop}, resume ${keep}`;
}

/** The toast after an answer. */
export function answeredToast(ended: number, resuming: number): string {
  if (ended === 0) return resuming === 1 ? "Resuming 1 sub" : `Resuming ${resuming} subs`;
  const stopped = `Stopped ${ended}`;
  if (resuming === 0) return stopped;
  return `${stopped}, resuming ${resuming}`;
}
