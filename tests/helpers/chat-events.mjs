// Shared ChatEvent factory helpers for the chat-renderer / event-store tests.
// Extracted from the per-file duplicates so new test files don't repeat them.

export function userEvent(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts };
}

export function assistantEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: ts };
}

export function streamingEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: true, timestamp: ts };
}

export function finalEvent(text, ts = 0) {
  return { type: "assistant_message", content: [{ type: "text", text }], streaming: false, timestamp: ts };
}

export function toolUseEvent(toolName, input, id, ts = 0) {
  return { type: "tool_use", tool_name: toolName, input, id, timestamp: ts };
}

/** A daemon-synthesised user_message echo (remote_echo: true). */
export function remoteEchoUserEvent(text, ts = 0) {
  return { type: "user_message", content: [{ type: "text", text }], timestamp: ts, remote_echo: true };
}

/** An O(delta) stream chunk (ai_todo 186). `snapshot: true` = full-text resync frame. */
export function deltaEvent(text, block, seq, snapshot = false, ts = 0) {
  return { type: "assistant_delta", text, block, seq, snapshot, timestamp: ts };
}

/** Broadcast-lag signal (see ChatEvent::EventsLagged in types/chat.rs): tells
 *  the store non-delta events were dropped and a forced re-read is needed. */
export function eventsLaggedEvent(ts = 0) {
  return { type: "events_lagged", timestamp: ts };
}
