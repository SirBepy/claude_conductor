// Quick replies Claude attaches to a send_message call (`next_actions`). The
// daemon route ignores the field; like `details` it is read straight off the
// tool_use input in the transcript, so live, reload and the phone all see it.
// Kept free of renderer imports so the event mappers can use it without a cycle
// through chat-transforms.
import type { RenderedMessage } from "./chat-classifiers";

/** Mirrors the tool schema (mcp/tool_schemas_coordination.rs); the model may not honour a schema, so it is enforced again here. */
export const MAX_NEXT_ACTIONS = 3;
export const MAX_NEXT_ACTION_LEN = 60;

/** Reads `next_actions` off a tool_use input. Malformed entries are dropped
 *  rather than failing the message, since its text still renders. */
export function parseNextActions(input: unknown): string[] | undefined {
  const raw = (input as { next_actions?: unknown } | null)?.next_actions;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (text === "" || text.length > MAX_NEXT_ACTION_LEN || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === MAX_NEXT_ACTIONS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** The newest message's chips, if it was sent after the last thing that starts
 *  a turn. Joe's own message starts one; so does a question card (its answer is
 *  folded into the card, with no user row) and a wake or peer turn (a system
 *  row with a metaKind). Only the NEWEST message counts, never the newest one
 *  that has chips: an older proposal must not outlive the message that
 *  replaced it. */
export function currentTurnNextActions(messages: readonly RenderedMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "message") {
      return m.retracted || m.dimmed || m.failed ? [] : (m.nextActions ?? []);
    }
    if (m.kind === "user" || m.kind === "question" || (m.kind === "system" && m.metaKind)) return [];
  }
  return [];
}
