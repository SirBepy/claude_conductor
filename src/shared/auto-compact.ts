// The "compact a main chat in place" setting, stored in settings.json's
// passthrough map under `autoCompact` and read by the daemon's
// `subchats::compaction::threshold_for`. Both sides must agree on the shape and
// on the fallbacks, so a change here goes with a change there:
//   { on, tokens, projects: { "<project id>": { on?, tokens? } } }
// A project entry overrides the global one field by field.

export const AUTO_COMPACT_KEY = "autoCompact";
/** Joe's pick, 2026-11-12: on for main chats, at 300K. */
export const AUTO_COMPACT_DEFAULT_ON = true;
export const AUTO_COMPACT_DEFAULT_TOKENS = 300_000;

export interface AutoCompact {
  on: boolean;
  tokens: number;
}

type Bag = Record<string, unknown>;

const asBag = (v: unknown): Bag | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : undefined;
const onOf = (b: Bag | undefined): boolean | undefined => (typeof b?.on === "boolean" ? b.on : undefined);
// The daemon takes a positive integer (`as_u64`, > 0); anything else falls back.
const tokensOf = (b: Bag | undefined): number | undefined =>
  typeof b?.tokens === "number" && Number.isSafeInteger(b.tokens) && b.tokens > 0 ? b.tokens : undefined;

/** No window is near this; it keeps a typed "1e20" from becoming a float the daemon ignores. */
const MAX_K = 10_000;

/** The threshold the daemon applies to a chat in `projectId` (null: the global one). */
export function readAutoCompact(settings: Bag, projectId: string | null): AutoCompact {
  const root = asBag(settings[AUTO_COMPACT_KEY]);
  const project = projectId ? asBag(asBag(root?.projects)?.[projectId]) : undefined;
  return {
    on: onOf(project) ?? onOf(root) ?? AUTO_COMPACT_DEFAULT_ON,
    tokens: tokensOf(project) ?? tokensOf(root) ?? AUTO_COMPACT_DEFAULT_TOKENS,
  };
}

/** The settings with `patch` written to the global entry (`projectId` null) or
 *  to one project's entry. Every other key, and the other scope, is kept. */
export function withAutoCompact(settings: Bag, projectId: string | null, patch: Partial<AutoCompact>): Bag {
  const root = { ...(asBag(settings[AUTO_COMPACT_KEY]) ?? {}) };
  if (projectId === null) {
    Object.assign(root, patch);
  } else {
    const projects = { ...(asBag(root.projects) ?? {}) };
    projects[projectId] = { ...(asBag(projects[projectId]) ?? {}), ...patch };
    root.projects = projects;
  }
  return { ...settings, [AUTO_COMPACT_KEY]: root };
}

/** 300000 -> 300; the field is in thousands of tokens. */
export const tokensToK = (tokens: number): number => Math.round(tokens / 1000);

/** The field's text as tokens, or null for anything but a whole number of K from 1 to 10,000. */
export function kToTokens(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_K ? n * 1000 : null;
}
