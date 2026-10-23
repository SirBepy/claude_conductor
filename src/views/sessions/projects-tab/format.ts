// Pure wording and path helpers for the Projects tab (no DOM, no IPC), so the
// list line and the dashboard rows can be unit-tested directly.
import { formatTimeAgo } from "../../../shared/formatters";
import type { DashboardListRow, DashboardTarget, DashboardTargetRef, Scope } from "./types";

export type ReportsTab = "outcomes" | "gallery" | "files";

/** Builtin card ids accepted by `dashboard_builtin_set_hidden`, in display order. */
export const BUILTIN_CARDS: ReadonlyArray<{ id: string, label: string }> = [
  { id: "needs_you", label: "Needs you" },
  { id: "your_todos", label: "Your todos" },
  { id: "chats", label: "Chats" },
  { id: "next_up", label: "Next up" },
  { id: "ship", label: "Ship state" },
  { id: "running", label: "Running" },
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

/** Second line of a Projects-list row: "4 repos · 4m ago · 1 waiting on you". */
export function listSubline(row: DashboardListRow, nowMs: number = Date.now()): string {
  const parts: string[] = [];
  if (row.target.kind === "group") parts.push(`${row.target.repos.length} repos`);
  const ago = row.last_active_ms ? agoLabel(row.last_active_ms, nowMs) : "no chats yet";
  parts.push(ago);
  if (row.live_count > 0) parts.push(`${row.live_count} running`);
  if (row.question_count > 0) parts.push(`${row.question_count} waiting on you`);
  return parts.join(" · ");
}

/** Status-dot class for a list row: a question beats working, nothing otherwise. */
export function listDotClass(row: DashboardListRow): string {
  if (row.question_count > 0) return "st-question";
  if (row.working_count > 0) return "st-working";
  return "";
}

export function sameRef(a: DashboardTargetRef | null, b: DashboardTargetRef | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
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

// Real outcomes often open with a greeting or a label ("Hi.", "Retrospective.",
// "...things up: 1."), so a lone first sentence that short says nothing.
const SENTENCE_MIN = 40;

/** The opening of an outcome's text for a one-line report row: whole
 * sentences until there is enough to read, the row's CSS ellipsizes the rest. */
export function firstSentence(text: string): string {
  const plain = plainPreview(text);
  const re = /.+?(?:[.!?](?=\s|$)|$)/g;
  let out = "";
  for (let m = re.exec(plain); m && m[0]; m = re.exec(plain)) {
    out = `${out} ${m[0].trim()}`.trim();
    if (out.length >= SENTENCE_MIN) break;
  }
  return out || plain;
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
  return cmds.filter((c) => !/^\/close(\s|$)/.test(c));
}
