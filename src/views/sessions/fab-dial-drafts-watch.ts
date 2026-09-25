// The FAB's Drafts-auto-open rule, split out of fab-dial.ts (todo 953) so the
// "should this event open the card" predicate can be tested directly instead
// of only through a mounted FabDial.
//
// A draft Claude just wrote opens the card onto it, so a reply meant for
// somewhere else is visible without Joe going looking (his ask, 2026-09-24).
// Scoped like the preview panel: only the chat on screen, never a forced
// switch from a background one, and no badge at rest.

import { getTransport, type Unlisten } from "../../shared/transport";

/** `message-drafts-changed`. `added` rides only the `add` action
 *  (`methods::drafts_store::publish_added`); every other mutation omits it. */
export interface DraftsChanged {
  project_id?: string;
  added?: { id?: string; origin_session_id?: string };
}

/** The state the predicate needs from FabDial at the moment an event lands. */
export interface DraftsWatchScope {
  sessionId: string | null;
  /** true once the card surface is showing. */
  cardOpen: boolean;
}

/** The three rules `tests/fab-dial-drafts-autoopen.test.mjs` pins: only an
 *  `add`, only the chat on screen, never over a card he opened himself.
 *  Returns the draft id to open onto, or null to leave the FAB alone. */
export function draftIdToAutoOpen(
  payload: DraftsChanged | undefined,
  scope: DraftsWatchScope,
): string | null {
  const added = payload?.added;
  // Only an `add` carries `added` - a revise, a state flip or Joe's own edit
  // in the panel publishes the bare event and must not take over the pane.
  if (!added?.id || !scope.sessionId || added.origin_session_id !== scope.sessionId) {
    return null;
  }
  // He already has a card open: that is his choice of surface, and Drafts is
  // refreshing itself anyway. Never yank him off a field he is typing in.
  if (scope.cardOpen) return null;
  return added.id;
}

/** Subscribes to `message-drafts-changed`; calls `onOpen(draftId)` whenever
 *  `draftIdToAutoOpen` says the event should take over the card. */
export async function watchDrafts(
  getScope: () => DraftsWatchScope,
  onOpen: (draftId: string) => void,
): Promise<Unlisten | null> {
  try {
    return await getTransport().listen<DraftsChanged>("message-drafts-changed", (payload) => {
      const id = draftIdToAutoOpen(payload, getScope());
      if (id) onOpen(id);
    });
  } catch (err) {
    console.warn("[fab-dial] listen(message-drafts-changed) failed", err);
    return null;
  }
}
