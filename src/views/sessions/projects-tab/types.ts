// Narrowed copies of the Rust types in src-tauri/src/project_dashboard/. The
// generated ones carry `kind`/`status` as plain `string` (Rust stores them as
// String), so these keep the literal unions the renderers switch on; the
// checks at the bottom fail typecheck if a field is renamed, added or dropped
// on either side.
import type * as Gen from "../../../types/ipc.generated";
import type { CardView } from "../../../types/ipc.generated";

export type { CardView, CardResult, CardConfig, GroupDef, Scope } from "../../../types/ipc.generated";

export type DashboardTargetRef = { kind: "project" | "group", id: string }
export type RepoRef = { cwd: string, name: string, project_id: string | null }
export type DashboardTarget = { kind: "project" | "group", id: string, name: string, repos: RepoRef[] }
export type DashboardListRow = { target: DashboardTarget, last_active_ms: number, live_count: number, question_count: number, working_count: number }
export type NeedsYouItem = { kind: "question" | "draft", title: string, detail: string, session_id: string | null, draft_id: string | null, repo_cwd: string, at_ms: number }
export type DashTodo = { id: string, project_id: string, text: string, origin_session_id: string | null, repo_cwd: string, by_ai: boolean }
export type DashChatRow = { session_id: string, title: string, status: "question" | "working" | "your_turn" | "waiting" | "ended", repo_cwd: string, at_ms: number }
export type PlanItem = { id: string | null, text: string, section: string, priority: boolean, repo_cwd: string }
export type ScheduledRow = { id: string, label: string, fire_at_ms: number, repo_cwd: string }
export type CommitRow = { short_sha: string, message: string, timestamp_ms: number, pushed: boolean }
export type RepoShip = { cwd: string, name: string, branch: string, ahead: number, behind: number, has_upstream: boolean, dirty_count: number, recent_commits: CommitRow[] }
export type ServerRow = { name: string, port: number, repo_cwd: string }
export type ChannelNote = { author: string, text: string, at_ms: number }
export type DashboardSnapshot = { target: DashboardTarget, needs_you: NeedsYouItem[], your_todos: DashTodo[], chats_running: DashChatRow[], chats_recent: DashChatRow[], plan: PlanItem[], scheduled: ScheduledRow[], ship: RepoShip[], servers: ServerRow[], peers_active: number, last_channel_message: ChannelNote | null, cards: CardView[], hidden_builtins: string[] }
export type QuickAction = { command: string, count: number }
export type OutcomeRow = { session_id: string, title: string, text: string, at_ms: number, repo_cwd: string }
export type GalleryItem = { id: string, session_id: string, title: string, at_ms: number, repo_cwd: string }
export type FileRow = { path: string, session_id: string, chat_title: string, at_ms: number, exists: boolean, repo_cwd: string }
export type DashboardHistory = { quick_actions: QuickAction[], outcomes: OutcomeRow[], gallery: GalleryItem[], files: FileRow[] }

type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
type Assert<T extends true> = T;
// Each local type must also be assignable to its generated twin (narrowing a
// string is fine, a changed field type is not).
type Fits<L extends G, G> = SameKeys<L, G>;

export type _ContractChecks = [
  Assert<Fits<DashboardTargetRef, Gen.DashboardTargetRef>>,
  Assert<Fits<RepoRef, Gen.RepoRef>>,
  Assert<Fits<DashboardTarget, Gen.DashboardTarget>>,
  Assert<Fits<DashboardListRow, Gen.DashboardListRow>>,
  Assert<Fits<NeedsYouItem, Gen.NeedsYouItem>>,
  Assert<Fits<DashTodo, Gen.DashTodo>>,
  Assert<Fits<DashChatRow, Gen.DashChatRow>>,
  Assert<Fits<PlanItem, Gen.PlanItem>>,
  Assert<Fits<ScheduledRow, Gen.ScheduledRow>>,
  Assert<Fits<CommitRow, Gen.CommitRow>>,
  Assert<Fits<RepoShip, Gen.RepoShip>>,
  Assert<Fits<ServerRow, Gen.ServerRow>>,
  Assert<Fits<ChannelNote, Gen.ChannelNote>>,
  Assert<Fits<DashboardSnapshot, Gen.DashboardSnapshot>>,
  Assert<Fits<QuickAction, Gen.QuickAction>>,
  Assert<Fits<OutcomeRow, Gen.OutcomeRow>>,
  Assert<Fits<GalleryItem, Gen.GalleryItem>>,
  Assert<Fits<FileRow, Gen.FileRow>>,
  Assert<Fits<DashboardHistory, Gen.DashboardHistory>>,
];
