// Classifier for the one daemon refusal callers must not treat as a failure:
// a send into a session that is still mid-turn (todo 873, `LifecycleError::Busy`).
// A leaf module, not part of ipc.ts, so a test that mocks `invoke` can't strip it.

/** True for a send the daemon refused because the session is mid-turn. The
 *  sentinel rides both transports - the RPC error string on desktop, the 409
 *  body on the phone - so callers re-stage into the held queue instead of
 *  surfacing a failed send. */
export function isSessionBusyError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  // The phone's send dedupe (remote_send_dedupe.rs) answers 409 with this text
  // while the first copy of the same message is still in flight; the held
  // queue's later send then finds the id delivered.
  return msg.includes("SESSION_BUSY:") || msg.includes("the first copy of this message is still being sent");
}
