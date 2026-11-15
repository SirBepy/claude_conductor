// The Autopilot picks card's data (pc-1750): the choices a chat made by itself on
// an unattended run, as the daemon stores them (daemon/subchats/picks.rs), and
// the pure derive the dashboard draws. DOM-free so tests read it directly.

export type PickStatus = "unreviewed" | "agreed" | "overruled" | "corrected";

/** One pick, as `picks_state` returns it. */
export interface AutopilotPick {
  id: string;
  date: string;
  who: string;
  sub: string | null;
  question: string;
  options: string[];
  pick: string;
  reason: string;
  landed: string;
  status: PickStatus;
  instead: string | null;
  corrected_note: string | null;
}

/** What the daemon's `picks_state` answers: the main chat the list belongs to and its picks. */
export interface PicksSide {
  owner: string;
  picks: AutopilotPick[];
}

export interface PicksState {
  /** Waiting for Joe's review, newest first. */
  unreviewed: AutopilotPick[];
  /** Joe overruled them; the code change is still to do. */
  overruled: AutopilotPick[];
  /** Agreed or already corrected, folded away by default. */
  done: AutopilotPick[];
}

const STATUSES: ReadonlySet<string> = new Set(["unreviewed", "agreed", "overruled", "corrected"]);

/** The daemon answers with serde's shape; anything missing reads as empty, a
 *  status this build does not know reads as unreviewed so it is never hidden. */
export function normalisePicks(raw: unknown): PicksSide {
  const r = (raw && typeof raw === "object" ? raw : {}) as { owner?: unknown; picks?: unknown };
  const list = Array.isArray(r.picks) ? r.picks : [];
  const picks: AutopilotPick[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o["id"] !== "string" || typeof o["question"] !== "string") continue;
    const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
    const opt = (k: string): string | null => (typeof o[k] === "string" && o[k] ? (o[k] as string) : null);
    picks.push({
      id: o["id"],
      date: str("date"),
      who: str("who") || "a chat",
      sub: opt("sub"),
      question: o["question"],
      options: Array.isArray(o["options"]) ? (o["options"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
      pick: str("pick"),
      reason: str("reason"),
      landed: str("landed"),
      status: STATUSES.has(str("status")) ? (str("status") as PickStatus) : "unreviewed",
      instead: opt("instead"),
      corrected_note: opt("corrected_note"),
    });
  }
  return { owner: typeof r.owner === "string" ? r.owner : "", picks };
}

const newestFirst = (a: AutopilotPick, b: AutopilotPick): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/** The card has nothing to show until a chat recorded a pick, so an attended
 *  chat's dashboard gains no card. */
export function derivePicks(side: PicksSide | undefined, on = true): PicksState | null {
  if (!on || !side || side.picks.length === 0) return null;
  const by = (...s: PickStatus[]): AutopilotPick[] => side.picks.filter((p) => s.includes(p.status)).sort(newestFirst);
  return { unreviewed: by("unreviewed"), overruled: by("overruled"), done: by("agreed", "corrected") };
}

/** What Joe's overrule sends to the main chat: the pick, what he wants, and how
 *  to close it out. The chat changes the code, then reports it with the tool. */
export function overruleMessage(p: AutopilotPick, instead: string): string {
  const where = p.landed ? ` (it landed in ${p.landed})` : "";
  return [
    `I overruled your autopilot pick ${p.id}${where}.`,
    `Question: ${p.question}`,
    `You picked: ${p.pick}`,
    `I want: ${instead.trim()}`,
    `Change the code to match, then call autopilot_pick with action "corrected", id "${p.id}" and a note naming the commit.`,
  ].join("\n");
}
