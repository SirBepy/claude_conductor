import { basename } from "../path-utils";
import { asObj, strField } from "../obj-utils";

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

// The app's real ask channel is the MCP tool (see CLAUDE.md "One ask channel");
// the builtin name is kept recognized too since history/tests may still carry
// it. One predicate so live/scrollback/pagination never drift on which wire
// name means "this is a question".
export const BUILTIN_ASK_QUESTION_TOOL = "AskUserQuestion";
export const MCP_ASK_QUESTION_TOOL = "mcp__cc_conductor__ask_user_question";

export function isAskQuestionTool(tool: string): boolean {
  return tool === BUILTIN_ASK_QUESTION_TOOL || tool === MCP_ASK_QUESTION_TOOL;
}

/** Lowercased file extension (including the dot), or "" if none. */
function extOf(path: string): string {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

/**
 * One-line summary for a tool_use: a Phosphor icon class, the display tool name,
 * and the primary target string. Defensive: `input` may be null/non-object.
 */
/** Max length for a tool summary target before it gets ellipsized. */
const TARGET_MAX = 100;

/** Cap a target at TARGET_MAX chars, appending a single ellipsis when truncated. */
function capTarget(target: string): string {
  return target.length > TARGET_MAX ? target.slice(0, TARGET_MAX) + "…" : target;
}

// MCP tools arrive as `mcp__<server>__<tool>` (raw) and we canonicalize them to
// `mcp:<server>` so every tool from one server folds into a single bucket/chip
// named after the server (e.g. all `mcp__playwright__*` -> "Playwright"). Both
// forms are recognised since toolSummary/toolLabel get called with either.
function parseMcp(tool: string): { server: string } | null {
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    return parts.length >= 3 && parts[1] ? { server: parts[1] } : null;
  }
  if (tool.startsWith("mcp:")) {
    const server = tool.slice(4);
    return server ? { server } : null;
  }
  return null;
}

/** "playwright" -> "Playwright", "cc_conductor" -> "Cc Conductor". */
function prettyMcpServer(server: string): string {
  return server
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The sub-tool of a raw `mcp__server__some_action` -> "some action". */
function prettyMcpAction(tool: string): string {
  if (!tool.startsWith("mcp__")) return "";
  return tool.split("__").slice(2).join("__").replace(/_/g, " ");
}

export function toolSummary(tool: string, input: unknown): { icon: string; tool: string; target: string } {
  const mcp = parseMcp(tool);
  if (mcp) {
    return { icon: "ph-plugs-connected", tool: prettyMcpServer(mcp.server), target: capTarget(prettyMcpAction(tool)) };
  }
  const obj = asObj(input);
  const { icon, target } = ((): { icon: string; target: string } => {
    switch (tool) {
      case "Read":
        return { icon: "ph-file", target: basename(strField(obj, "file_path")) };
      case "Edit":
      case "MultiEdit":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "file_path")) };
      case "Write":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "file_path")) };
      case "NotebookEdit":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "notebook_path")) };
      case "Grep":
        return { icon: "ph-magnifying-glass", target: strField(obj, "pattern") };
      case "Glob":
        return { icon: "ph-folder", target: strField(obj, "pattern") };
      case "Bash":
      case "PowerShell": {
        const desc = strField(obj, "description");
        return { icon: "ph-terminal-window", target: desc || strField(obj, "command").slice(0, 48) };
      }
      case "Agent":
      case "Task":
        return { icon: "ph-robot", target: "starting subagent" };
      case "AskUserQuestion":
        return { icon: "ph-chats-circle", target: "" };
      case "Skill":
        return { icon: "ph-sparkle", target: typeof obj.skill === "string" ? obj.skill : "" };
      case "WebFetch":
        return { icon: "ph-globe", target: strField(obj, "url") };
      case "WebSearch":
        return { icon: "ph-magnifying-glass", target: strField(obj, "query") };
      case "Search":
        return { icon: "ph-globe", target: "" };
      default:
        return { icon: "ph-wrench", target: "" };
    }
  })();
  return { icon, tool, target: capTarget(target) };
}

// Tools that fold into another tool's chip/tally so the user sees one bucket
// per concept, not per CLI variant: PowerShell and Bash are both "Ran"; the
// edit family (MultiEdit/NotebookEdit) AND Write fold into "Edit" - one
// "File Changes" bucket covers every file the turn created or modified.
// Glob folds into Grep (both are "find things" tools).
// WebFetch + WebSearch fold into "Search".
const CANONICAL_TOOL: Record<string, string> = {
  PowerShell: "Bash",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Write: "Edit",
  Glob: "Grep",
  WebFetch: "Search",
  WebSearch: "Search",
};

/** The bucket a tool groups under (Bash/PowerShell -> Bash, edit family -> Edit,
 *  every mcp__server__* -> mcp:server). */
export function canonicalTool(tool: string): string {
  const mcp = parseMcp(tool);
  if (mcp) return "mcp:" + mcp.server;
  return CANONICAL_TOOL[tool] ?? tool;
}

// Friendly verbs for a (canonical) tool, shown on tally + transcript chips.
const TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Edit: "File Changes",
  Grep: "Grep",
  Bash: "Ran",
  Task: "Subagent",
  Agent: "Subagent",
  AskUserQuestion: "Questions",
  Skill: "Skills",
  Search: "Search",
};

/** Friendly chip label for a tool, after canonicalizing (e.g. PowerShell -> "Ran"). */
export function toolLabel(tool: string): string {
  const c = canonicalTool(tool);
  const mcp = parseMcp(c);
  if (mcp) return prettyMcpServer(mcp.server);
  return TOOL_LABELS[c] ?? c;
}

/** Classify a tool_use's target for the open-on-click popover. */
export function classifyTarget(
  tool: string,
  input: unknown,
): { kind: "file" | "image" | "none"; path?: string } {
  const obj = asObj(input);
  switch (tool) {
    case "Read": {
      const path = strField(obj, "file_path");
      if (!path) return { kind: "none" };
      if (IMAGE_EXTS.includes(extOf(path))) return { kind: "image", path };
      return { kind: "file", path };
    }
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const path = strField(obj, "file_path");
      if (!path) return { kind: "none" };
      return { kind: "file", path };
    }
    case "NotebookEdit": {
      const path = strField(obj, "notebook_path");
      if (!path) return { kind: "none" };
      return { kind: "file", path };
    }
    default:
      return { kind: "none" };
  }
}

/** One distinct target behind a tool chip's drill-down popover. */
export interface TallyItem {
  /** display text: basename for files, pattern for Grep/Glob, desc/command for Bash */
  label: string;
  kind: "file" | "image" | "text";
  /** absolute path for openable file/image targets */
  path?: string;
  /** filename when kind === "image" */
  filename?: string;
  /** repeat count for identical targets */
  count: number;
}

export interface ToolTally {
  /** insertion order = first-seen order; each type carries its distinct targets */
  byType: { tool: string; count: number; items: TallyItem[] }[];
}

/**
 * Per-call detail for a tool chip's drill-down: what to show in the popover and,
 * for files/images, how to open it. `key` dedups identical targets. Returns null
 * for tools with nothing worth listing (e.g. unknown tools, Agent/Task).
 */
export function tallyDetail(
  tool: string,
  input: unknown,
): (Omit<TallyItem, "count"> & { key: string }) | null {
  const cls = classifyTarget(tool, input);
  if (cls.kind === "image" && cls.path) {
    return { key: cls.path, kind: "image", path: cls.path, filename: basename(cls.path), label: basename(cls.path) };
  }
  if (cls.kind === "file" && cls.path) {
    return { key: cls.path, kind: "file", path: cls.path, label: basename(cls.path) };
  }
  const obj = asObj(input);
  switch (tool) {
    case "Grep": {
      const p = strField(obj, "pattern");
      return p ? { key: "grep:" + p, kind: "text", label: capTarget(p) } : null;
    }
    case "Glob": {
      const p = strField(obj, "pattern");
      return p ? { key: "glob:" + p, kind: "text", label: capTarget(p) } : null;
    }
    case "Bash":
    case "PowerShell": {
      const label = strField(obj, "description") || strField(obj, "command");
      return label ? { key: "cmd:" + label, kind: "text", label: capTarget(label) } : null;
    }
    case "WebFetch": {
      const url = strField(obj, "url");
      return url ? { key: "fetch:" + url, kind: "text", label: capTarget(url) } : null;
    }
    case "WebSearch": {
      const query = strField(obj, "query");
      return query ? { key: "search:" + query, kind: "text", label: capTarget(query) } : null;
    }
    default:
      return null;
  }
}
