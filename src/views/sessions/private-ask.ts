// The private read-only "ask" chat of the dashboard's Answers card (a thread that
// runs the read-only Ask sidecar, daemon/methods/answers.rs and ask/) is switched
// off: Joe found it too complicated and a read-only chat is not worth it. Every
// line of it stays, so it can come back as a regular subchat (todo
// pc-1831-bring-back-the-ask-chat-as-a-regular-subchat); this one flag is what
// every entry point asks before it opens one: the Answers card's Reply, + and
// New question buttons, and a question card's Ask button.

const PRIVATE_ASK_SWITCHED_OFF = true;

/** `window.__ccPrivateAsk = true` turns the private ask chat back on for a spec of
 *  its thread UI. It is never set by the app and never persisted. */
export function privateAskEnabled(): boolean {
  return !PRIVATE_ASK_SWITCHED_OFF || (globalThis as { __ccPrivateAsk?: boolean }).__ccPrivateAsk === true;
}
