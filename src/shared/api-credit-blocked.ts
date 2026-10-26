// Classifier for the refusal a send gets when its chat runs on an API-credit
// account whose credit is used up or whose Console spend limit is reached
// (`LifecycleError::ApiCreditBlocked`, RPC code -32007; the phone's REST send
// answers HTTP 402 with the same text). A leaf module like session-busy.ts so a
// test that mocks `invoke` can't strip it.

const SENTINEL = "API_CREDIT_BLOCKED:";

/** The plain reason when `err` is an API-credit refusal, else null. The
 * sentinel rides inside the RPC error string on desktop
 * ("rpc error: code=-32007 message=API_CREDIT_BLOCKED: ...") and as the bare
 * body on the phone, so everything after it is the reason. */
export function apiCreditBlockedReason(err: unknown): string | null {
  const text = String(err instanceof Error ? err.message : err);
  const at = text.indexOf(SENTINEL);
  if (at < 0) return null;
  const reason = text.slice(at + SENTINEL.length).trim();
  return reason.length > 0 ? reason : "New turns on this account are paused.";
}

/** The text a failed send shows: the bare reason for an API-credit refusal
 * (the prefix is protocol, not prose), the raw error otherwise. */
export function sendFailureText(err: unknown): string {
  return apiCreditBlockedReason(err) ?? String(err);
}
