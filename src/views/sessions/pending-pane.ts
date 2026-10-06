import { state } from "./state";
import { sessionSubtitle, projectName } from "./sessions-helpers";
import { characterForSession, characterIconUrl } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import type { SessionConfig } from "./model-effort-modal";
import { isAutoAccept } from "./permission-modal";
import { SessionHeader } from "./session-header";
import { wireRenderer } from "./active-session-mount";
import { retainChat } from "./chat-pane-cache";
import { mountPendingChrome, mountPendingHint, mountPendingStatusbar, attachPendingRenderer } from "./pending-pane-mount";
import { wirePendingComposer } from "./pending-pane-composer";

let _pendingHeader: SessionHeader | null = null;

/** Build and wire a draft (not-yet-started) chat pane: header/markup, the
 *  statusbar, the ChatRenderer + session-started watcher, and the composer.
 *  Each step is a short sequence of named helpers - the pane's
 *  own markup lives in pending-pane-mount.ts alongside the statusbar and
 *  renderer mount, and the composer's send/schedule/held-message routing
 *  lives in pending-pane-composer.ts. */
export async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  onDiscard?: (pane: HTMLElement) => void,
): Promise<void> {
  const myMount = state.mountId;

  _pendingHeader = mountPendingChrome(pane, placeholderId, project, config, onDiscard);
  await mountPendingStatusbar(pane, project, config, placeholderId, _pendingHeader);
  await attachPendingRenderer(pane, placeholderId, project, config, _pendingHeader, myMount);
  // Must come after attachPendingRenderer: ChatRenderer.attach() clears
  // .session-messages, which would wipe a hint seeded any earlier.
  mountPendingHint(pane, project, myMount);
  wirePendingComposer(pane, placeholderId, project, config, myMount, { rebindPaneHeader });

  const ta = pane.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (ta) ta.focus();

  if (config.initialMessage) {
    const msg = config.initialMessage;
    setTimeout(() => { void state.composer?.sendText(msg); }, 0);
  }
}

function rebindPaneHeader(pane: HTMLElement, sessionId: string): void {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (state.statusbar) {
    state.statusbar.setSessionId(sessionId);
    state.statusbar.setReadOnlyEffort(false);
    state.statusbar.disableModelEdit();
    // The picked-in-modal accountId already painted the chip; resync against
    // the now-real session record in case the daemon resolved a different one
    // (e.g. the picked account vanished mid-flow and it fell back to default).
    state.statusbar.setAccountId(sess?.account_id ?? null);
  }
  pane.querySelector(".session-pending-hint")?.remove();

  const h = _pendingHeader;
  if (!h) return;
  if (sess) {
    h.setTitle(sessionSubtitle(sess));
    h.setMeta(projectName(sess));
  }
  // Refresh the avatar from the now-assigned session character: covers the case
  // where the user didn't pick one in the modal and the backend rolled one on
  // start (the draft showed the muted placeholder until now). Only override when
  // we actually have an id, so a not-yet-loaded char map can't clobber the
  // portrait already shown for a user-picked character.
  const realCharId = sess ? characterForSession(sess) : null;
  h.bindSession({
    sessionId,
    readOnly: false,
    ...(realCharId
      ? { charId: realCharId, charUrl: characterIconUrl(realCharId), charStatus: "", cwd: sess?.cwd ? String(sess.cwd) : null }
      : {}),
    autoAcceptOn: isAutoAccept(sessionId),
  });
  if (realCharId) void hydrateCharacterAvatars(pane);
  void hydrateProjectTechIcons(pane);

  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  const renderer = state.renderer;
  if (messagesEl && renderer && sess) {
    // Full shared wiring (tool-view provider, activity/progress/todo/CTA
    // callbacks, activeChatActions, Code mode) - not a hand-rolled subset,
    // which is exactly why a promoted draft once looked like a chat but
    // wasn't wired like one (ai_todo: draft-promotion lookalike bug).
    wireRenderer(pane, sess, h, renderer);
    // Register with the pane cache so the next navigate-away-and-back is a
    // cache hit (element swap) instead of the cold rebuild that used to be
    // the only thing that fully re-wired a promoted chat.
    retainChat(sessionId, renderer, messagesEl);
  }
}
