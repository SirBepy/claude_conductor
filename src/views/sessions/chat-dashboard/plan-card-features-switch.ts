// A main chat's Plan card lists its subs as feature lines and takes over the Subchats and
// Attachments cards (features-card.ts, dashboard-model.ts `mainChat`). Every line of those two
// cards stays, so they can come back; this one flag is what the dashboard asks before it treats
// a chat as a main chat.

const FEATURE_LINES_ON = true;

/** `window.__ccSubsCard = true` brings the Subchats and Attachments cards back on a main chat for
 *  a spec of their own UI (floating peeks, avatars, the quick views). Never set by the app,
 *  never persisted. */
export function featureLinesEnabled(): boolean {
  return FEATURE_LINES_ON && (globalThis as { __ccSubsCard?: boolean }).__ccSubsCard !== true;
}
