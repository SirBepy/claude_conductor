// The dashboard's Drafts card (docs/chat-dashboard-design.md, "Drafts"). Pure:
// it reads the chat's write_draft rows (ChatRenderer's `kind:"draft"` rows)
// and, once loaded, the drafts store (`list_message_drafts`), and says which
// drafts are still to send and which are copied.
//
// The transcript draws one card per write_draft CALL, so a draft revised twice
// shows three times there. Here it is one card per draft (one per wording when
// a draft has wordings for several people), always showing the store's current
// text, newest first.

import type { RenderedMessage } from "../chat-classifiers";
import type { DraftVariant, MessageDraft } from "../../../types/ipc.generated";
import { currentVersion, handleOf } from "../../message-draft-utils";

/** The drafts store as the dashboard last read it. `ids` are the draft ids the
 *  chat's rows named when that read was made: an id among them that the store
 *  no longer holds was deleted, while an id the chat wrote after the read is
 *  simply not loaded yet and falls back to its own row. `sessionId` is the
 *  chat's: its drafts whose rows are past the loaded history page still list. */
export interface DraftStoreSide {
  drafts: readonly MessageDraft[];
  ids: readonly string[];
  sessionId?: string | null;
}

export interface DraftItem {
  /** Unique per card: the draft id plus the wording's recipient. */
  key: string;
  /** Null while the write_draft call has not answered yet. */
  id: string | null;
  /** Who it goes to, as the Drafts panel names them ("Bruno #2"). */
  recipient: string;
  topic: string;
  /** Markdown of the current version. */
  body: string;
  /** "v3", "v3 · your edit", or "" when not known yet. */
  version: string;
  /** Claude posted this wording itself (write_draft `sent`). */
  sent: boolean;
  copied: boolean;
}

export interface DraftsState {
  /** Still to send, newest first. */
  toSend: DraftItem[];
  /** Copied or posted, newest first: folded under "N copied". */
  copied: DraftItem[];
}

/** Every draft id the chat's write_draft rows name, in first-seen order. */
export function draftIdsOf(messages: readonly RenderedMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) if (m.kind === "draft" && m.draftId && !out.includes(m.draftId)) out.push(m.draftId);
  return out;
}

function versionLabel(variant: DraftVariant): string {
  const v = currentVersion(variant);
  if (!v) return "";
  return v.author === "user" ? `v${v.n} · your edit` : `v${v.n}`;
}

/** One card per wording of a draft the store holds. */
function fromStore(draft: MessageDraft): DraftItem[] {
  if (draft.state === "archived") return [];
  return draft.variants.map((variant) => ({
    key: `${draft.id}|${variant.recipient}`,
    id: draft.id,
    recipient: handleOf(variant),
    topic: draft.topic,
    body: currentVersion(variant)?.body ?? "",
    version: versionLabel(variant),
    sent: variant.sent,
    copied: draft.state === "copied" || variant.sent,
  }));
}

/** The card a draft's own rows can draw before the store is read: its latest
 *  body, and the topic and recipient the first call gave (a `revise` sends
 *  only the body). */
function fromRows(key: string, rows: readonly RenderedMessage[]): DraftItem {
  const last = rows[rows.length - 1]!;
  const withBody = [...rows].reverse().find((r) => (r.draftBody ?? "").trim() !== "");
  const topic = rows.find((r) => r.draftTopic)?.draftTopic ?? "";
  const recipient = [...rows].reverse().find((r) => r.draftRecipient)?.draftRecipient ?? "";
  const sent = last.draftAction === "sent";
  return {
    // The same key the store read gives this wording, so a fold Joe set before
    // the read survives it (one set before the call answered does not: the
    // card had no id yet).
    key: last.draftId ? `${last.draftId}|${recipient}` : key,
    id: last.draftId ?? null,
    recipient,
    topic,
    body: withBody?.draftBody ?? "",
    version: last.draftVersion !== undefined ? `v${last.draftVersion}` : "",
    sent,
    copied: sent,
  };
}

export function buildDraftsState(messages: readonly RenderedMessage[], store?: DraftStoreSide): DraftsState | null {
  // Rows per draft, and the index of each draft's latest row (its place in the
  // newest-first order). A call that has not answered yet has no id, so it is
  // its own draft until it does.
  const rowsOf = new Map<string, RenderedMessage[]>();
  const lastAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.kind !== "draft" || m.draftFailed) return;
    // A revise, variant or sent call learns its draft id only from its answer;
    // until then it would read as a second, topic-less draft.
    if (!m.draftId && m.draftAction !== "add") return;
    const key = m.draftId ?? `row:${m.id ?? i}`;
    const list = rowsOf.get(key) ?? [];
    list.push(m);
    rowsOf.set(key, list);
    lastAt.set(key, i);
  });
  const order = [...rowsOf.keys()].sort((a, b) => lastAt.get(b)! - lastAt.get(a)!);
  const byId = new Map((store?.drafts ?? []).map((d) => [d.id, d]));
  const items: DraftItem[] = [];
  for (const key of order) {
    const rows = rowsOf.get(key)!;
    if (rows[rows.length - 1]!.draftAction === "drop") continue;
    const id = rows[0]!.draftId;
    const stored = id ? byId.get(id) : undefined;
    if (stored) items.push(...fromStore(stored));
    else if (id && store?.ids.includes(id)) continue; // deleted from the Drafts panel
    else items.push(fromRows(key, rows));
  }
  // The chat's own drafts whose rows are not loaded (an older history page).
  const older = (store?.drafts ?? [])
    .filter((d) => !!store?.sessionId && d.origin_session_id === store.sessionId && !rowsOf.has(d.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const d of older) items.push(...fromStore(d));
  if (items.length === 0) return null;
  return { toSend: items.filter((d) => !d.copied), copied: items.filter((d) => d.copied) };
}
