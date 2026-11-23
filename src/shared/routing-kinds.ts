// Role meta for Settings > Models & providers: label, blurb and icon per kind of
// work, keyed by the same plain kind string the daemon's routing rules use
// (`routing::KNOWN_KINDS`). main_chat and new_chat are the chats Joe talks to;
// the other eleven are the chat kinds a sub can be.
//
// TEMPORARY: the shared Plan card kinds table (`src/shared/chat/chat-kinds.ts`,
// landing from another branch) replaces the eleven job entries when it merges;
// until then they mirror its labels and icons by hand. Keep the keys equal to
// the daemon's list, since a kind it does not know has no rule.

export type RoutingGroupId = "chats" | "jobs";

export interface RoutingKindMeta {
  id: string;
  group: RoutingGroupId;
  label: string;
  blurb: string;
  /** Phosphor classes, weight included. */
  icon: string;
}

export const ROUTING_KINDS: readonly RoutingKindMeta[] = [
  { id: "main_chat", group: "chats", label: "Main chat", blurb: "The chat you talk to", icon: "ph ph-chat-circle-dots" },
  { id: "new_chat", group: "chats", label: "New chat", blurb: "A chat you start yourself", icon: "ph ph-chat-circle-text" },
  { id: "talk", group: "jobs", label: "Talk", blurb: "Answers, changes nothing", icon: "ph ph-chats-circle" },
  { id: "plan", group: "jobs", label: "Plan", blurb: "Reads the code, drafts the steps", icon: "ph ph-lightbulb" },
  { id: "build", group: "jobs", label: "Build", blurb: "Test first, then code, commit", icon: "ph ph-code" },
  { id: "review", group: "jobs", label: "Review", blurb: "Reads the diff, writes findings", icon: "ph ph-magnifying-glass" },
  { id: "release", group: "jobs", label: "Release", blurb: "Bump, gate, tag, publish", icon: "ph ph-rocket" },
  { id: "fix", group: "jobs", label: "Fix", blurb: "Reproduce, find the cause, fix", icon: "ph ph-bandaids" },
  { id: "gate", group: "jobs", label: "Gate", blurb: "Rebase, run the pipeline, merge", icon: "ph ph-git-merge" },
  { id: "test", group: "jobs", label: "Test", blurb: "Writes the cases, runs them", icon: "ph ph-flask" },
  { id: "triage", group: "jobs", label: "Triage", blurb: "Sorts what is open by cost", icon: "ph ph-broom" },
  { id: "research", group: "jobs", label: "Research", blurb: "Collects and cross-checks sources", icon: "ph ph-books" },
  { id: "errand", group: "jobs", label: "Errand", blurb: "Does one thing, reports", icon: "ph ph-briefcase" },
];

export const ROUTING_KIND_GROUPS: ReadonlyArray<{ id: RoutingGroupId; title: string }> = [
  { id: "chats", title: "Chats you talk to" },
  { id: "jobs", title: "Jobs subs do" },
];

export function routingKind(id: string): RoutingKindMeta | undefined {
  return ROUTING_KINDS.find((k) => k.id === id);
}

/** Only a job a sub does can be raised or lowered by the main chat, so only these get the range controls. */
export function isJobKind(id: string): boolean {
  return routingKind(id)?.group === "jobs";
}
