// The kinds of job a sub does, in ONE table: the Plan card draws each chat as the icon of its
// kind, and per-role model routing keys on the same ids. The daemon's own list is
// src-tauri/src/daemon/subchats/kind.rs (`KINDS`, stored on the sub's brief as `kind`);
// tests/chat-kinds.test.mjs reads that file and fails when the two lists differ.

export const CHAT_KINDS = ["talk", "plan", "build", "review", "release", "fix", "gate", "test", "triage", "research", "errand"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export interface ChatKindInfo {
  /** The Phosphor icon name, without the `ph-` prefix. */
  icon: string;
  /** The word the kind goes by on the card and in a tooltip. */
  label: string;
}

export const CHAT_KIND_INFO: Readonly<Record<ChatKind, ChatKindInfo>> = {
  talk: { icon: "chats-circle", label: "Talk" },
  plan: { icon: "lightbulb", label: "Plan" },
  build: { icon: "code", label: "Build" },
  review: { icon: "magnifying-glass", label: "Review" },
  release: { icon: "rocket", label: "Release" },
  fix: { icon: "bandaids", label: "Fix" },
  gate: { icon: "git-merge", label: "Gate" },
  test: { icon: "flask", label: "Test" },
  triage: { icon: "broom", label: "Triage" },
  research: { icon: "books", label: "Research" },
  errand: { icon: "briefcase", label: "Errand" },
};

/** A kind word in its canonical spelling, or null for a word that is no kind. */
export function normalizeKind(raw: unknown): ChatKind | null {
  const low = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (CHAT_KINDS as readonly string[]).includes(low) ? (low as ChatKind) : null;
}

/** Words of a sub's name that name a kind without being the kind's own word. Mirrors
 *  `ALIASES` in kind.rs, so a sub shown before its brief is read gets the kind the daemon stores. */
const ALIASES: Readonly<Record<string, ChatKind>> = {
  design: "plan", audit: "review", fixes: "fix", bug: "fix", verify: "test", e2e: "test", push: "gate", merge: "gate",
  version: "release", investigate: "research", explore: "research", question: "talk", implement: "build", sweep: "triage",
};

/** The kind a sub's name suggests: the earliest whole word that names one ("fix-pairing", "Build: x"). */
export function kindFromName(name: string): ChatKind | null {
  for (const word of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const own = normalizeKind(word) ?? ALIASES[word];
    if (own) return own;
  }
  return null;
}

/** The kind to draw before the daemon's stored one is known: the name, else an errand. A stored
 *  kind (`get_sub_brief`) always wins over this. */
export function guessKind(name: string): ChatKind {
  return kindFromName(name) ?? "errand";
}
