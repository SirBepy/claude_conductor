// Leaf module on purpose: importing nothing, it lets src/shared/ share this
// with src/views/sessions/pending-flow.ts, which mints the ids.

/** Rust validates a placeholder id as this prefix + alphanumeric/dash/underscore. */
export const PENDING_SESSION_ID_PREFIX = "pending-";

/** A placeholder id has no daemon-side session, so any RPC keyed on one
 *  comes back -32602 unknown session_id. Callers skip rather than warn. */
export function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_ID_PREFIX);
}
