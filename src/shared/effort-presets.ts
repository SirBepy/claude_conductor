import { modelLabel } from "./model-name";

export interface Preset {
  name: string;
  model: string;
  effort: string;
}

export interface SessionConfig {
  model: string;
  effort: string;
  // Auto-allow tool permission prompts for this session. Defaults on for new
  // chats (the modal checkbox); undefined on legacy drafts is treated as on.
  autoAccept?: boolean;
  // Spawn `claude --remote-control` for this session. Defaults on for new chats
  // (the modal checkbox); undefined on legacy drafts is treated as on.
  remote?: boolean;
  /** Character chosen in the new-session pane; applied to the real session once it starts. */
  characterId?: string | null;
  /** When set, the pending pane auto-sends this text as the first message on mount. */
  initialMessage?: string;
  /** Registry account the modal resolved/picked (multi-account milestone 04).
   * `null`/undefined means no accounts are registered yet or the resolver
   * found none - the spawn falls back to daemon-side default resolution. */
  accountId?: string | null;
}

export const MODELS = ["haiku", "sonnet", "opus", "fable"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// Set by boot.ts after a successful fetch_available_models IPC call.
// null = fetch not yet complete or failed; readModels falls back to MODELS seed.
let _apiModels: string[] | null = null;

export function setApiModels(models: string[]): void {
  _apiModels = models.length > 0 ? models : null;
}

/**
 * Given the raw model ID list from /v1/models (newest-first per family),
 * return only the latest model per family. The API guarantees newest-first
 * within each family, so first-seen-per-family is the latest.
 */
export function curateLatestPerFamily(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const fam = modelFamilyFromId(m);
    if (!seen.has(fam)) {
      seen.add(fam);
      out.push(m);
    }
  }
  return out;
}

/** "claude-opus-5" -> "opus". Returns the id unchanged for unknown families. */
export function modelFamilyFromId(id: string): string {
  const s = id.toLowerCase();
  if (s.includes("fable")) return "fable";
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return id;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * The newest full model id for a family (e.g. "opus" -> "claude-opus-4-8"),
 * looked up in the API list. The API delivers newest-first per family, so the
 * first match is the latest. Returns null when the API hasn't loaded or the
 * family is a user-added exotic (e.g. "glm-4.6") with no API entry.
 */
export function latestIdForFamily(family: string): string | null {
  if (!_apiModels) return null;
  const fam = modelFamilyFromId(family);
  return _apiModels.find((id) => modelFamilyFromId(id) === fam) ?? null;
}

/**
 * Pretty, version-bearing label for a canonical (family) model value:
 * "opus" -> "Opus 4.8" when the API is loaded, "Opus" as a fallback. The app
 * persists families everywhere; this resolves the latest id only for display.
 */
export function modelDisplayLabel(model: string): string {
  return modelLabel(latestIdForFamily(model) ?? model);
}

/**
 * Sort model ids least-impressive-first (Haiku, Sonnet, Opus, Fable), the order
 * Joe wants in the picker. The /v1/models API delivers newest-first, which puts
 * Fable on the left; this flips it. Rank comes from the MODELS seed order;
 * unknown families (user-added exotic models) sort to the end, stably.
 */
export function sortByImpressiveness(models: string[]): string[] {
  const rank = (m: string): number => {
    const i = MODELS.indexOf(modelFamilyFromId(m) as typeof MODELS[number]);
    return i === -1 ? MODELS.length : i;
  };
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map((x) => x.m);
}

export const DEFAULT_PRESETS: Preset[] = [
  { name: "Light", model: "sonnet", effort: "low" },
  { name: "Normal", model: "opus", effort: "high" },
  { name: "Heavy", model: "opus", effort: "max" },
];

export function isEffort(v: unknown): v is typeof EFFORTS[number] {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * Models offered in the "New session" picker, as canonical FAMILY values
 * (haiku/sonnet/opus/fable) — never full ids. Families are what the app
 * persists and matches on (presets, lastChoice, spawn `--model`); full ids are
 * a display/availability detail resolved via latestIdForFamily.
 *
 * When the API fetch has completed (_apiModels is set), the list is the API
 * families, sorted least-to-most impressive. Any settings.models entry whose
 * family is not covered by the API set is appended as a user addition.
 *
 * Without API data yet, falls back to settings.models if non-empty, else the
 * built-in MODELS seed (which is already family-shaped and ordered).
 */
export function readModels(settings: Record<string, unknown>): string[] {
  const userModels = parseUserModels(settings);
  if (_apiModels && _apiModels.length > 0) {
    const apiFamilies = uniq(_apiModels.map(modelFamilyFromId));
    const apiSet = new Set(apiFamilies);
    const extras = uniq(userModels.map(modelFamilyFromId)).filter((f) => !apiSet.has(f));
    return sortByImpressiveness([...apiFamilies, ...extras]);
  }
  return userModels.length > 0 ? userModels : [...MODELS];
}

function parseUserModels(settings: Record<string, unknown>): string[] {
  const raw = settings["models"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m === "string") {
      const t = m.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Default checkbox states for the "New session" modal. Both default ON when the
 * setting is absent; only an explicit `false` flips them off.
 */
export function readDefaultFlags(
  settings: Record<string, unknown>,
): { autoAccept: boolean; remote: boolean } {
  return {
    autoAccept: settings["defaultAutoAllow"] !== false,
    remote: settings["defaultRemoteControl"] !== false,
  };
}

export function readPresets(
  settings: Record<string, unknown>,
  opts?: { padWithDefaults?: boolean },
): Preset[] {
  const raw = settings["effortPresets"];
  if (!Array.isArray(raw)) return opts?.padWithDefaults ? [...DEFAULT_PRESETS] : DEFAULT_PRESETS;
  const out: Preset[] = [];
  for (const p of raw) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      // Loosened: accept any non-empty model string so user-defined models in
      // settings.models survive. Effort stays strict (isEffort). Normalize to a
      // family so a full id stored during the picker window (e.g.
      // "claude-opus-4-8") collapses to its canonical family ("opus").
      const model = typeof o.model === "string" ? modelFamilyFromId(o.model.trim()) : "";
      const effort = isEffort(o.effort) ? o.effort : "";
      if (name && model && effort) out.push({ name, model, effort });
    }
  }
  if (opts?.padWithDefaults) {
    while (out.length < 3) {
      const d = DEFAULT_PRESETS[out.length]!;
      out.push({ ...d });
    }
    return out.slice(0, 3);
  }
  return out.length === 3 ? out : DEFAULT_PRESETS;
}

export function readLastChoice(
  settings: Record<string, unknown>,
  projectPath: string,
): SessionConfig | null {
  const map = settings["projectLastChoice"];
  if (!map || typeof map !== "object") return null;
  const entry = (map as Record<string, unknown>)[projectPath];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  // Normalize to a family so a full id saved during the picker window collapses
  // to its canonical family (matches the family-based picker + presets).
  const model = typeof e.model === "string" ? modelFamilyFromId(e.model.trim()) : "";
  const effort = typeof e.effort === "string" ? e.effort : "";
  // Loosened: any non-empty model string is accepted (user-defined models).
  // Effort stays strict.
  if (model && isEffort(effort)) return { model, effort };
  return null;
}
