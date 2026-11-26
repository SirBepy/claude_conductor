// The merged Plan card's rows (docs/architecture/chat-dashboard.md, "Plan card features"): a main
// chat's subs grouped into one line per feature, each drawn as a trail of one icon per chat. Pure,
// so it tests on plain arrays; dashboard-model.ts feeds it the subs and the facts it reads off the
// transcript (todo ids, finish verdicts), the view feeds it the kinds the daemon stored.

import { guessKind, type ChatKind } from "../chat-kinds";
import { ticketIdIn, type TrackerMark } from "../../tracker-icons";
import { subWhy, type SubCardItem, type SubCardKind } from "./subs-model";

/** What a chat's icon says. The colour tokens only know four states; a paused, usage-limited or
 *  stopped chat is `idle` (drawn grey like a queued one, its tooltip names the real state). */
export type ChatState = "queued" | "working" | "asking" | "done" | "idle";

const STATE_OF: Record<SubCardKind, ChatState> = {
  asking: "asking", working: "working", queued: "queued", finished: "done", paused: "idle", limited: "idle", stopped: "idle",
};

export interface FeatureChat {
  id: string;
  name: string;
  kind: ChatKind;
  state: ChatState;
  /** What the chat is doing, or what it waits on, in a line ("Waits for header, next in line"). */
  why: string;
  /** Its own plan, in order, or null when it has none. */
  steps: { text: string; status: string }[] | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** The sub item the row came from, for the hover card and the menu. */
  item: SubCardItem;
  /** Its latest finish verdict, the line a Done chat row ends with; null while it has none. */
  verdict: string | null;
}

export interface FeatureTicket {
  id: string;
  tracker: TrackerMark;
  /** The ticket's address when the chat's links name it, else null (the icon then copies the id). */
  url: string | null;
}

export interface FeatureRow {
  /** `todo:<id>`, `ticket:<id>`, `feature:<name>`, `task:<name>` or `chat:<id>`: stable across redraws. */
  key: string;
  title: string;
  todoId: string | null;
  ticket: FeatureTicket | null;
  /** Oldest first: the trail reads in the order the work happened. */
  chats: FeatureChat[];
  /** Every chat of the feature is still queued. */
  queued: boolean;
  /** When the feature started: its earliest chat's start, null while all are queued with no date. */
  startedAt: number | null;
  /** When the feature finished: its latest chat's finish once EVERY chat has finished (the Done card's
   *  line), else null. A feature whose finished chats all lack a date leaves it null, so the line sorts last. */
  doneAt: number | null;
}

export interface FeaturesState {
  /** Queued features first, then the rest, oldest start first. */
  rows: FeatureRow[];
}

/** What the builder needs to know about one sub besides its card item. */
export interface FeatureSource {
  item: SubCardItem;
  /** The todo id its name or finish verdict carries (dashboard-model.ts `todoIdOf`). */
  todoId: string | null;
  /** The feature's name: the sub's own name with ids and separators dropped. */
  title: string;
  /** The kind the daemon stored on the sub's brief, once read. */
  storedKind?: ChatKind | null;
  /** The feature the main chat named on the sub's brief (`spawn_chat`'s `feature`), once read: every sub
   *  with the same one is one line, titled with it, whatever the subs are called. */
  storedFeature?: string | null;
  /** The sub's latest finish verdict, a second place a ticket id is named. */
  verdict?: string | null;
}

const ms = (iso: string | null): number | null => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : t;
};

/** A feature's name without its ticket id: the id is an icon under the name, and taskTitle has already
 *  read the id's dash as a space ("Sc 56709 Invite modal"). The title stays whole when nothing else is left. */
function withoutTicket(title: string, id: string | null): string {
  if (!id) return title;
  const spelled = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-\\s]");
  const plain = title.replace(new RegExp(`(?<![A-Za-z0-9])${spelled}(?![0-9A-Za-z])`, "i"), " ").replace(/\s+/g, " ").replace(/^[\s:.,-]+|[\s:.,-]+$/g, "");
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : title;
}

type TicketUrl = (ticket: { id: string; tracker: TrackerMark }) => string | null;

/** The words a name shares with its siblings before a numbering marker: "bridge sub 3 detector" and
 *  "Bridge-sub-4" both lead with "bridge". The markers are "sub N", "step N", "part N", "round N" and
 *  "N of M"; a name that starts with its marker, or has none, has no leading phrase. */
const MARKERS = [/(?<![a-z0-9])(?:sub|step|part|round)\s*\d+(?![a-z0-9])/i, /(?<![a-z0-9])\d+\s*of\s*\d+(?![a-z0-9])/i];

/** A lone job-type word is no feature name: "review round 2" and "fix sub 3" of two jobs must not meet. */
const GENERIC = new Set(["review", "fix", "build", "test", "update", "plan", "research", "release", "gate", "triage", "errand", "talk", "check", "refactor", "docs"]);

export function leadingPhrase(name: string): string | null {
  const plain = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  let end = -1;
  for (const re of MARKERS) {
    const at = plain.search(re);
    if (at > 0 && (end < 0 || at < end)) end = at;
  }
  if (end < 0) return null;
  const phrase = plain.slice(0, end).replace(/^[\s:.,]+|[\s:.,]+$/g, "");
  // "Step 3 of 5 bridge" has a marker first: the "Step" before "3 of 5" is no feature.
  return phrase.length >= 2 && !/^(?:sub|step|part|round)$/i.test(phrase) && !GENERIC.has(phrase.toLowerCase()) ? phrase[0]!.toUpperCase() + phrase.slice(1) : null;
}

/** Where a sub's line comes from, strongest first: its todo or ticket id, the feature its brief names,
 *  the phrase its name shares with its siblings, its own title, else nothing (it stands alone). */
interface Placement {
  hard: string | null;
  soft: string;
  /** The line's title when this sub says what the feature is called; null leaves it to the first chat. */
  label: string | null;
  /** How strong `label` is: a named feature outranks a phrase read off a name. */
  named: boolean;
}

function placeOf(s: FeatureSource): Placement {
  const ticket = ticketIdIn(s.item.name) ?? ticketIdIn(s.verdict ?? "");
  const hard = s.todoId ? `todo:${s.todoId}` : ticket ? `ticket:${ticket.id.toLowerCase()}` : null;
  const feature = (s.storedFeature ?? "").replace(/\s+/g, " ").trim();
  if (feature) return { hard, soft: `feature:${feature.toLowerCase()}`, label: feature, named: true };
  const phrase = leadingPhrase(s.item.name);
  if (phrase) return { hard, soft: `task:${phrase.toLowerCase()}`, label: phrase, named: false };
  const named = s.title.toLowerCase();
  // An unnamed chat shows as "New chat": that is no feature name, so each stands alone.
  return { hard, soft: named && named !== "new chat" ? `task:${named}` : `chat:${s.item.id}`, label: null, named: false };
}

/** Every group of subs as a row, finished or not: the Plan card keeps the ones with a chat left to
 *  follow and the Done card the ones whose every chat finished, so a feature keeps its key, title and
 *  ids when it moves from one card to the other. */
function groupRows(sources: readonly FeatureSource[], ticketUrl: TicketUrl): FeatureRow[] {
  const startOf = (s: FeatureSource): number => ms(s.item.startedAt) ?? Number.MAX_SAFE_INTEGER;
  const places = new Map(sources.map((s) => [s, placeOf(s)] as const));
  // A todo or ticket id names the job for every sub that shares its feature or leading phrase, so a sub
  // whose finish verdict is the only place the id appears does not split off from its siblings.
  const idOfSoft = new Map<string, string>();
  for (const s of [...sources].sort((a, b) => startOf(a) - startOf(b))) {
    const p = places.get(s)!;
    if (p.hard && p.label !== null && !idOfSoft.has(p.soft)) idOfSoft.set(p.soft, p.hard);
  }
  // A main chat that names the feature on only some subs: a sub with no feature joins the feature line
  // of a sibling whose name leads with the same phrase.
  const featureOfPhrase = new Map<string, string>();
  for (const s of [...sources].sort((a, b) => startOf(a) - startOf(b))) {
    const p = places.get(s)!;
    const phrase = p.named ? leadingPhrase(s.item.name) : null;
    if (phrase && !featureOfPhrase.has(`task:${phrase.toLowerCase()}`)) featureOfPhrase.set(`task:${phrase.toLowerCase()}`, p.soft);
  }
  for (const p of places.values()) if (!p.named) p.soft = featureOfPhrase.get(p.soft) ?? p.soft;
  const groups = new Map<string, FeatureSource[]>();
  for (const s of sources) {
    const p = places.get(s)!;
    const key = p.hard ?? idOfSoft.get(p.soft) ?? p.soft;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const rows: FeatureRow[] = [];
  for (const [key, g] of groups) {
    const chats = g.map((s): FeatureChat => ({
      id: s.item.id,
      name: s.item.name,
      kind: s.storedKind ?? guessKind(s.item.name),
      state: STATE_OF[s.item.kind],
      why: subWhy(s.item),
      steps: s.item.steps && s.item.steps.length > 0 ? s.item.steps : null,
      startedAt: ms(s.item.startedAt),
      finishedAt: s.item.finishedAt,
      item: s.item,
      verdict: s.verdict?.trim() || null,
    })).sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    const byStart = [...g].sort((a, b) => startOf(a) - startOf(b));
    // The first chat to start names the feature: a later review or fix chat is the same job. A name the
    // main chat gave the feature outranks that, and a phrase read off the names outranks a lone title,
    // but only on a line whose key is that phrase: a todo's line with no named feature keeps the title it always had.
    const first = byStart[0]!;
    const labelled = byStart.find((s) => places.get(s)!.named) ?? (key.startsWith("task:") ? byStart.find((s) => places.get(s)!.label) : undefined);
    const label = labelled ? places.get(labelled)!.label : null;
    const named = g.map((s) => ticketIdIn(s.item.name) ?? ticketIdIn(s.verdict ?? "")).find((t) => t !== null) ?? null;
    const ticket = named ? { ...named, url: ticketUrl(named) } : null;
    const starts = chats.map((c) => c.startedAt).filter((t): t is number => t !== null);
    const finished = g.every((s) => s.item.kind === "finished");
    const ends = chats.map((c) => c.finishedAt).filter((t): t is number => t !== null);
    rows.push({
      key,
      title: withoutTicket(label || first.title || first.item.name, named?.id ?? null),
      todoId: g.find((s) => s.todoId)?.todoId ?? null,
      ticket,
      chats,
      queued: chats.every((c) => c.state === "queued"),
      startedAt: starts.length > 0 ? Math.min(...starts) : null,
      doneAt: finished && ends.length > 0 ? Math.max(...ends) : null,
    });
  }
  return rows;
}

const isFinishedRow = (r: FeatureRow): boolean => r.chats.every((c) => c.state === "done");

/** Features that still have a chat to follow: one whose every chat finished is the Done card's. */
export function buildFeatures(sources: readonly FeatureSource[], ticketUrl: TicketUrl = () => null): FeaturesState | null {
  const rows = groupRows(sources, ticketUrl).filter((r) => !isFinishedRow(r));
  if (rows.length === 0) return null;
  const place = (r: FeatureRow): number => Math.min(...r.chats.map((c) => c.item.hover?.queue?.place ?? Number.MAX_SAFE_INTEGER));
  const queued = rows.filter((r) => r.queued).sort((a, b) => place(a) - place(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const rest = rows.filter((r) => !r.queued).sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER));
  return { rows: [...queued, ...rest] };
}

/** The features whose every chat finished, newest first (a feature with no known finish time last):
 *  the Done card's lines, the same rows the Plan card drew while a chat of them was still going. */
export function buildDoneFeatures(sources: readonly FeatureSource[], ticketUrl: TicketUrl = () => null): FeatureRow[] {
  return groupRows(sources, ticketUrl).filter(isFinishedRow)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || a.title.localeCompare(b.title));
}

/** The chat a feature shows when Joe has not picked one: the one needing him, then a working one,
 *  then a queued one, else the newest. */
export function activeChatOf(row: FeatureRow): FeatureChat {
  const by = (st: ChatState): FeatureChat | undefined => row.chats.find((c) => c.state === st);
  return by("asking") ?? by("working") ?? by("idle") ?? by("queued") ?? row.chats[row.chats.length - 1]!;
}
