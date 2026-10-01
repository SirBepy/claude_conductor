// Todo 893: fetches the repo-channel's real retained backlog so the
// peer-message chip's inline panel can show actual posted text instead of
// the zero-peer-bytes wake placeholder `wake_notice` is limited to on the
// wire (todo 743's injection boundary - see repo_channel_wake.rs). A
// non-consuming read: never advances any session's `read_messages` cursor.

import type { ChannelMessage } from "../../types/ipc.generated";
import { invoke } from "../ipc";

/** Best-effort, same tolerance as chat-renderer.ts's fetchSkipMarks: a fetch
 *  failure just means the panel falls back to the wake placeholder for this
 *  load, not a broken history load. Returns `undefined` (not `[]`) on
 *  failure specifically so author-message-group.ts can tell "never fetched /
 *  fetch failed" apart from "fetched, genuinely nothing retained" - only the
 *  latter is a confirmed aged-out state worth a distinct message. */
export async function fetchChannelMessages(sessionId: string): Promise<ChannelMessage[] | undefined> {
  try {
    const view = await invoke<{ messages: ChannelMessage[] }>("list_channel_messages", { sessionId });
    return view.messages ?? [];
  } catch (err) {
    console.error("[peer-channel] list_channel_messages failed", err);
    return undefined;
  }
}

/** Real texts posted by `authorSessionId`, in channel (posting) order. */
export function textsFor(messages: ChannelMessage[], authorSessionId: string): string[] {
  return messages.filter((m) => m.session_id === authorSessionId).map((m) => m.text);
}
