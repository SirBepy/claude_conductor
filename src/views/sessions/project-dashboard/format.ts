// Pure wording and path helpers for the project dashboard (no DOM, no IPC), so
// target resolution and the dashboard rows can be unit-tested directly.
import { formatTimeAgo } from "../../../shared/formatters";
import type { CardView, DashboardListRow, DashboardTarget, DashboardTargetRef, Scope } from "./types";

export type ReportsTab = "outcomes" | "gallery" | "files";

/** Builtin card ids accepted by `dashboard_builtin_set_hidden`, in display order. */
export const BUILTIN_CARDS: ReadonlyArray<{ id: string, label: string }> = [
  { id: "your_todos", label: "Your todos" },
  { id: "chats", label: "Chats" },
  { id: "next_up", label: "Next up" },
  { id: "ship", label: "Ship state" },
  { id: "running", label: "Running" },
  { id: "usage", label: "Usage" },
  { id: "todo_chart", label: "Todo chart" },
  { id: "quick_actions", label: "Quick action row" },
  { id: "reports", label: "Reports" },
];

/** "now" under a minute, else the app-wide "4m ago" wording. */
export function agoLabel(ms: number, nowMs: number = Date.now()): string {
  if (!ms) return "";
  if (nowMs - ms < 60_000) return "now";
  return formatTimeAgo(new Date(ms));
}

/** Same as agoLabel without the trailing "ago", for a row's right-hand column. */
export function shortAgo(ms: number, nowMs: number = Date.now()): string {
  return agoLabel(ms, nowMs).replace(/ ago$/, "");
}

/** Which dashboard a repo opens: the group that lists it, so every repo of a
 *  group shows the same one, else its own project. A chat's project id is
 *  matched too, since a chat in a worktree has the worktree's folder as cwd. */
export function targetForRepo(rows: DashboardListRow[], cwd: string, projectId: string | null = null): DashboardTargetRef {
  const isRepo = (r: { cwd: string, project_id: string | null }): boolean =>
    sameCwd(r.cwd, cwd) || (!!projectId && r.project_id === projectId);
  const group = rows.find((r) => r.target.kind === "group" && r.target.repos.some(isRepo));
  if (group) return { kind: "group", id: group.target.id };
  const project = rows.find((r) => r.target.kind === "project" && r.target.repos.some(isRepo));
  return project ? { kind: "project", id: project.target.id } : { kind: "project", id: cwd };
}

/** Slash/case-insensitive path equality: a repo_cwd and a project path can differ only in separators. */
export function sameCwd(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The card/hidden-builtin scope a target maps to. */
export function scopeOf(target: DashboardTarget): Scope {
  if (target.kind === "group") return { kind: "group", id: target.id };
  return { kind: "project", cwd: target.repos[0]?.cwd ?? target.id };
}

/** "today 14:30" / "tomorrow 10:00" / "Fri 3 Nov 09:00" for a scheduled row. */
export function whenLabel(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dayStart = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(new Date(nowMs))) / 86_400_000);
  if (days === 0) return `today ${hm}`;
  if (days === 1) return `tomorrow ${hm}`;
  const date = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${date} ${hm}`;
}

const FILE_ICONS: Record<string, string> = {
  md: "file-text", txt: "file-text", html: "file-html", pdf: "file-pdf", pptx: "presentation-chart",
  docx: "file-doc", xlsx: "file-xls", csv: "file-csv", png: "file-image", svg: "file-svg",
};

export function fileIcon(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICONS[ext] ?? "file";
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A chat's markdown message as preview text: the outcome card clamps to a
 * few lines, so emphasis markers and link URLs would only eat them. */
export function plainPreview(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*(#{1,6}\s+|[-*]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "fetched 6m ago" for a custom card's header. */
export function fetchedLabel(fetchedAtMs: number, nowMs: number = Date.now()): string {
  const ago = agoLabel(fetchedAtMs, nowMs);
  return ago === "now" ? "fetched just now" : `fetched ${ago}`;
}

const SUMMARY_CUTS = [" - ", "; ", ". ", "("];
// A cut earlier than this would leave a bare label ("Fix"), not a summary.
const SUMMARY_MIN = 12;
const SUMMARY_MAX = 70;

/** A plan item cut down to its headline: the text before the first " - ", "; ",
 * ". " or "(" that leaves at least SUMMARY_MIN characters, ellipsized when
 * still long. */
export function summarize(text: string): string {
  const t = text.trim();
  const cuts = SUMMARY_CUTS.map((s) => t.indexOf(s, SUMMARY_MIN)).filter((i) => i >= 0);
  const head = (cuts.length ? t.slice(0, Math.min(...cuts)) : t).trim();
  return head.length > SUMMARY_MAX ? `${head.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : head;
}

export type ChatGroupId = "input" | "progress" | "done";

/** The Chats sidebar's three live segments, in the same words and order. */
export const CHAT_GROUPS: ReadonlyArray<{ id: ChatGroupId, label: string }> = [
  { id: "input", label: "Input needed" },
  { id: "progress", label: "In progress" },
  { id: "done", label: "Done" },
];

export function chatGroupOf(status: "question" | "working" | "your_turn" | "waiting" | "ended"): ChatGroupId | null {
  if (status === "question") return "input";
  if (status === "working" || status === "waiting") return "progress";
  if (status === "your_turn") return "done";
  return null;
}

/** Slash chips, minus the ones a dashboard must never offer: closing a chat is not a quick action. */
export function offerableCommands(cmds: string[]): string[] {
  return cmds.filter((c) => !/^\/close(\s|$)/i.test(c));
}

/** How long a custom card's result counts as fresh when its config names no refresh_secs. */
export const DEFAULT_CARD_REFRESH_SECS = 900;
/** A chat can write any refresh_secs, 0 included; each run is an HTTP call or a local
 *  command, so an open dashboard never re-runs one card more often than this. */
export const MIN_CARD_REFRESH_SECS = 60;

/** The interval a card is actually refreshed on. */
export function cardRefreshSecs(refreshSecs: number | null | undefined): number {
  return Math.max(refreshSecs ?? DEFAULT_CARD_REFRESH_SECS, MIN_CARD_REFRESH_SECS);
}

/** Enabled cards with no result yet, or one older than their refresh interval. */
export function staleCardIds(cards: CardView[], nowMs: number = Date.now()): string[] {
  return cards.filter((v) => {
    if (!v.config.enabled) return false;
    if (!v.result) return true;
    const secs = cardRefreshSecs(v.config.refresh_secs);
    return nowMs - v.result.fetched_at_ms >= secs * 1000;
  }).map((v) => v.config.id);
}
