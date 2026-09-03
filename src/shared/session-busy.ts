// Classifier for the one daemon refusal callers must not treat as a failure:
// a send into a session that is still mid-turn (todo 873, `LifecycleError::Busy`).
// A leaf module, not part of ipc.ts, so a test that mocks `invoke` can't strip it.

/** True for a send the daemon refused because the session is mid-turn. The
 *  sentinel rides both transports - the RPC error string on desktop, the 409
 *  body on the phone - so callers re-stage into the held queue instead of
 *  surfacing a failed send. */
export function isSessionBusyError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err).includes("SESSION_BUSY:");
}
