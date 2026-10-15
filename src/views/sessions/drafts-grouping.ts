// How the Drafts panel sorts a project's drafts into "From this chat", one row
// per person, and one section per platform. Pure data, no DOM, so the rules
// are testable on their own; drafts-panel.ts only renders what this returns.

import type { DraftVariant, MessageDraft, Person } from "../../types/ipc.generated";

/** A draft nobody has touched for a week stops counting as open: before this,
 *  14 of one project's drafts sat in "Needs you" for weeks because only Copy
 *  ever retired one. */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function isOpen(d: MessageDraft, now: number): boolean {
  if (d.state === "copied" || d.state === "archived") return false;
  const touched = Date.parse(d.updated_at);
  return Number.isNaN(touched) || now - touched < STALE_MS;
}

export interface PersonGroup {
  key: string;
  /** Vault id, or null for a plain-name recipient the vault doesn't know. */
  personId: string | null;
  name: string;
  relationship: string;
  drafts: MessageDraft[];
  open: number;
  /** Most recent `updated_at`, ms. */
  latest: number;
}

export interface PlatformGroup {
  key: string;
  name: string;
  drafts: MessageDraft[];
}

export interface DraftGroups {
  mine: MessageDraft[];
  /** People with something open or touched this week, newest first. */
  people: PersonGroup[];
  /** Everyone else, folded behind one line. */
  quietPeople: PersonGroup[];
  /** Platforms with something open or touched this week. */
  platforms: PlatformGroup[];
  /** The rest, folded the same way as quiet people. */
  quietPlatforms: PlatformGroup[];
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Where one variant belongs. A vault person wins; a variant with no person
 *  goes to its platform; a bare name with neither still reads as a person. */
export function groupKeyOf(v: DraftVariant): string {
  if (v.person) return `p:${v.person}`;
  if (v.platform) return `x:${norm(v.platform)}`;
  return `n:${norm(v.recipient)}`;
}

function stamp(d: MessageDraft | undefined): number {
  if (!d) return 0;
  const t = Date.parse(d.updated_at);
  return Number.isNaN(t) ? 0 : t;
}

const newestFirst = (a: MessageDraft, b: MessageDraft): number => stamp(b) - stamp(a);

export function groupDrafts(
  drafts: MessageDraft[],
  people: Person[],
  sessionId: string | null,
  now: number,
): DraftGroups {
  const byId = new Map(people.map((p) => [p.id, p]));
  const persons = new Map<string, PersonGroup>();
  const platforms = new Map<string, PlatformGroup>();

  for (const d of drafts) {
    for (const v of d.variants) {
      const key = groupKeyOf(v);
      if (key.startsWith("x:")) {
        const g = platforms.get(key) ?? { key, name: v.platform!.trim(), drafts: [] };
        if (!g.drafts.includes(d)) g.drafts.push(d);
        platforms.set(key, g);
        continue;
      }
      const vault = v.person ? byId.get(v.person) : undefined;
      const g = persons.get(key) ?? {
        key,
        personId: v.person ?? null,
        name: vault?.name ?? v.person ?? v.recipient,
        relationship: vault?.relationship ?? "",
        drafts: [],
        open: 0,
        latest: 0,
      };
      if (!g.drafts.includes(d)) {
        g.drafts.push(d);
        if (isOpen(d, now)) g.open++;
        g.latest = Math.max(g.latest, stamp(d));
      }
      persons.set(key, g);
    }
  }

  const all = [...persons.values()];
  for (const g of all) g.drafts.sort(newestFirst);
  all.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || b.latest - a.latest);
  const active = (g: PersonGroup): boolean => g.open > 0 || now - g.latest < STALE_MS;

  const sections = [...platforms.values()];
  for (const g of sections) g.drafts.sort(newestFirst);
  sections.sort((a, b) => stamp(b.drafts[0]) - stamp(a.drafts[0]));
  const liveSection = (g: PlatformGroup): boolean => g.drafts.some((d) => isOpen(d, now)) || now - stamp(g.drafts[0]) < STALE_MS;

  return {
    mine: drafts.filter((d) => d.origin_session_id === sessionId && isOpen(d, now)).sort(newestFirst),
    people: all.filter(active),
    quietPeople: all.filter((g) => !active(g)),
    platforms: sections.filter(liveSection),
    quietPlatforms: sections.filter((g) => !liveSection(g)),
  };
}

/** The variant a person's view should show for this draft: theirs if the
 *  card has several recipients, else the only one. */
export function variantFor(d: MessageDraft, groupKey: string): DraftVariant | undefined {
  return d.variants.find((v) => groupKeyOf(v) === groupKey) ?? d.variants[0];
}
