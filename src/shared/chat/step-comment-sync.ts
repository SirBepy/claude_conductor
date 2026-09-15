// Thin typed wrapper around the `add_step_comment` daemon RPC (todo 898),
// same pattern as session-draft-sync.ts's wrappers around drafts.rs.
//
// Desktop only today: ipc/step_comments.rs wraps this for desktop invoke;
// there is no http-transport.ts case, so a phone/browser session that calls
// it gets an explicit RemoteUnavailableError (see that file's `default` arm),
// not a silent no-op - not asked for by todo 898.

import { invoke } from "../ipc";

export function addStepComment(sessionId: string, stepText: string, comment: string): Promise<{ ok: boolean }> {
  return invoke("add_step_comment", { sessionId, stepText, comment });
}
