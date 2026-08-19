// Single source of truth for what statusline chips exist. Display metadata only
// (icon/sample/tooltip/section) - the live render lives in SessionStatusbar.
// Tool chips are the dynamic `tool:<CanonicalName>` family and are NOT listed
// individually here; see TOOL_CHIP_TOOLS.

export type SectionKey = "model" | "git" | "session" | "tools" | "layout";

export const SECTION_LABELS: Record<SectionKey, string> = {
  model: "Model",
  git: "Git",
  session: "Session",
  tools: "Tools",
  layout: "Layout",
};

export interface ChipMeta {
  section: SectionKey;
  icon: string; // phosphor class, e.g. "ph-robot"
  sample: string; // preview value shown in the builder
  tooltip: string; // hover explanation
  /** true => affected by the global hide-at-zero setting */
  countLike?: boolean;
}

// Static (non-tool) chips. Key is the ChipType id.
export const STATIC_CHIPS = {
  model:          { section: "model",   icon: "ph-robot",            sample: "Sonnet 4.6", tooltip: "Active model for this session (locked once started)." },
  account:        { section: "model",   icon: "ph-user-circle",      sample: "Work",       tooltip: "Claude account this chat is running under. Click to move it to a different account." },
  effort:         { section: "model",   icon: "ph-gauge",            sample: "Normal",     tooltip: "Thinking effort. Click the chip in chat to change it." },
  context_pct:    { section: "model",   icon: "ph-stack",            sample: "45%",        tooltip: "Context window used, as a percentage." },
  context_tokens: { section: "model",   icon: "ph-stack",            sample: "90k / 200k", tooltip: "Context window used, raw tokens / window size." },
  thinking:       { section: "model",   icon: "ph-brain",            sample: "thinking",   tooltip: "Shows while extended thinking is active." },

  branch:         { section: "git",     icon: "ph-git-branch",       sample: "main",       tooltip: "Current git branch." },
  repo:           { section: "git",     icon: "ph-folder-simple",    sample: "my-project", tooltip: "Repository name (from origin)." },
  folder:         { section: "git",     icon: "ph-folder-open",      sample: "my-project", tooltip: "Working directory. Click to open in your file explorer." },
  commits:        { section: "git",     icon: "ph-arrows-down-up",   sample: "↑2 ↓1",      tooltip: "Commits ahead/behind the upstream branch." },
  commits_ahead:  { section: "git",     icon: "ph-arrow-up",         sample: "↑2",         tooltip: "Commits ahead of upstream (unpushed)." },
  commits_behind: { section: "git",     icon: "ph-arrow-down",       sample: "↓1",         tooltip: "Commits behind upstream (unpulled)." },
  dirty:          { section: "git",     icon: "ph-pencil-simple",    sample: "3 dirty",    tooltip: "Uncommitted changed files.", countLike: true },
  sha:            { section: "git",     icon: "ph-hash",             sample: "a1b2c3d",    tooltip: "Short SHA of HEAD." },
  diffstat:       { section: "git",     icon: "ph-plus-minus",       sample: "+42 -7",     tooltip: "Uncommitted insertions / deletions." },

  messages:       { section: "session", icon: "ph-chat-circle",      sample: "12 msgs",    tooltip: "User prompts sent this session.", countLike: true },
  turns:          { section: "session", icon: "ph-arrows-clockwise", sample: "8 turns",    tooltip: "Agent turns this session.", countLike: true },
  duration:       { section: "session", icon: "ph-timer",            sample: "2m 30s",     tooltip: "Time since the session started." },
  cost:           { section: "session", icon: "ph-currency-dollar",  sample: "~$0.42",     tooltip: "Estimated session cost (local estimate, not a charge)." },
  clock:          { section: "session", icon: "ph-clock",            sample: "14:32",      tooltip: "Current wall-clock time." },
  ai_todos:       { section: "session", icon: "ph-check-square",     sample: "3 todos",    tooltip: "AI todos in .claude/todos/. Click to view the list.", countLike: true },
  drain:          { section: "session", icon: "ph-drop",             sample: "50% · 12%w", tooltip: "Share of a 5h session this chat has drained (and weekly). Click for a per-message rundown." },
  servers:        { section: "session", icon: "ph-broadcast",        sample: "1 live",     tooltip: "Dev servers running for this project via server_supervisor. Click to list them and open each in the browser.", countLike: true },
  images:         { section: "session", icon: "ph-image",           sample: "12 imgs",    tooltip: "Every image in this chat (attachments + tool screenshots). Click to view the list.", countLike: true },

  separator:      { section: "layout",  icon: "ph-minus",            sample: "|",          tooltip: "Vertical divider line between chips." },
  flex_separator: { section: "layout",  icon: "ph-arrows-left-right", sample: "· · ·",    tooltip: "Flexible spacer: pushes chips after it to the right end." },
} satisfies Record<string, ChipMeta>;

// Canonical tool buckets that become individual `tool:<name>` chips. Mirrors
// TALLY_TOOL_OPTIONS in session-statusbar-helpers.
// Write folds into Edit ("File Changes"), Glob folds into Grep, WebFetch +
// WebSearch fold into Search - none of those get their own chip.
// Skill + AskUserQuestion render rich custom popovers (skills list / Q&A).
export const TOOL_CHIP_TOOLS = [
  "Read", "Edit", "Grep", "Bash",
  "Task", "TodoWrite", "AskUserQuestion", "Skill", "Search",
] as const;

export type StaticChipType = keyof typeof STATIC_CHIPS;
export type ToolChipType = `tool:${string}`;
export type ChipType = StaticChipType | ToolChipType;

export function isToolChip(t: string): t is ToolChipType {
  return t.startsWith("tool:");
}

export function chipToolName(t: ToolChipType): string {
  return t.slice("tool:".length);
}

/** Default 2-row layout for fresh users: row 1 = the classic field set, row 2 =
 *  the default-visible tool chips (AskUserQuestion + TodoWrite stay off). */
export const DEFAULT_ROWS: ChipType[][] = [
  ["model", "account", "effort", "branch", "repo", "context_pct", "thinking", "messages", "turns"],
  ["tool:Read", "tool:Edit", "tool:Grep", "tool:Bash", "tool:Task", "tool:Skill", "tool:Search"],
];

export const MAX_ROWS = 5;

/** Phone default (Joe, 2026-08-19: the desktop set wrapped to two rows AND
 *  still clipped). Drops account/repo/branch, which the chat header already
 *  shows, and keeps the two tool chips worth glancing at. */
export const DEFAULT_MOBILE_ROWS: ChipType[][] = [
  ["model", "context_pct", "effort", "servers", "commits", "tool:Read", "tool:Edit"],
];

/** One row on a phone, so the bar can never wrap and eat the conversation. */
export const MOBILE_MAX_ROWS = 1;

/** True if `t` is a known static chip or any tool chip. Unknown ids are dropped
 *  on load so a stale/garbage setting never crashes the bar. Retired chips
 *  (folded into another bucket) are dropped on load. */
export function isKnownChip(t: string): boolean {
  if (t === "tool:Write" || t === "tool:Glob" || t === "tool:WebFetch" || t === "tool:WebSearch") return false;
  return isToolChip(t) || Object.prototype.hasOwnProperty.call(STATIC_CHIPS, t);
}
