// TODO: the token tracker UI is hidden because its numbers are inaccurate:
// tokens/drain.rs counts every transcript line without deduping by message.id
// (about a 2x overcount), `pricing_for` has stale Opus prices and no Fable row,
// and one cache-write price ignores the 1h tier. Come back later, improve the
// numbers and make the tracker configurable per provider (Claude, Codex,
// DeepSeek, Kimi). Every hidden surface keys off the flag below, or off the
// `data-feature="token-stats"` rule in styles/mvp-hidden.css; the tracker code
// itself is intact, flip the flag and drop the CSS rule to bring it back.
//
// Not the tracker, still shown: the claude.ai 5h / weekly utilization from the
// usage API (account cards, usage charts, taskbar bars, reset times).

export const TOKEN_TRACKER_HIDDEN = true;

/** Home dashboard widgets drawn from transcript token records. The usage-% charts
 *  (`session-chart`, `weekly-chart`) are not in here: they plot the claude.ai
 *  utilization, and only their token-derived "Worked on" list is dropped. */
export const TOKEN_TRACKER_WIDGET_IDS: ReadonlySet<string> = new Set([
  "today", "token-source", "session-bars", "weekly-bars",
]);
