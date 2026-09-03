// Character/account-change handlers extracted from active-session.ts's
// selectSession (ai_todo 870): changeCharacterForSession, carrySessionSettings,
// applyAccountMove and changeAccountForSession. Pure move, no behavior change.

import { showToast } from "../../shared/toast";
import type { Instance } from "../../types/ipc.generated";
import { state } from "./state";
import { renderSidebar, refreshSessions } from "./sidebar";
import {
  characterForSession,
  characterForSessionId,
  characterIconUrl,
  loadSessionCharacters,
  setSessionCharacterLocal,
} from "./session-characters";
import { api } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import { isAutoAccept, setAutoAccept } from "./permission-modal";
import { capitalize, getCachedAccount } from "../../shared/chat/rate-limit-banner";
import { loadDraft, moveComposerDraft } from "../../shared/chat/composer-persistence";
import { setComposerDraft, clearComposerDraft } from "../../shared/chat/session-draft-sync";

/** Opens the Change Character modal, persists the pick, and refreshes the
 *  header face + sidebar row. `headerStatusClass` is injected: it lives in
 *  active-session.ts, which imports this module. */
export async function changeCharacterForSession(
  sessionId: string,
  headerStatusClass: (sess: Instance) => string,
): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const current = characterForSession(sess);
  const picked = await openChangeCharacterModal({ projectId: sess.project_id, currentId: current });
  if (!picked || picked === current) return;
  try {
    await api.setSessionCharacter(sessionId, picked);
    await loadSessionCharacters();
  } catch (e) {
    console.error("[active-session] change character failed", e);
    return;
  }
  // Surgically swap the active pane's header face (avoid a full pane re-render
  // that would tear down the live renderer/composer mid-session).
  if (state.selectedId === sessionId) {
    const header = document.querySelector<HTMLElement>(".session-header");
    const old = header?.querySelector<HTMLElement>(".header-char-clickable");
    if (header && old) {
      const url = characterIconUrl(picked);
      const wrapper = document.createElement("span");
      wrapper.className = `session-header-avatar header-char-clickable ${headerStatusClass(sess)}`;
      wrapper.title = "Change character";
      wrapper.setAttribute("role", "button");
      wrapper.tabIndex = 0;
      const backdrop = document.createElement("img");
      backdrop.className = "char-avatar session-header-backdrop";
      backdrop.dataset.characterId = picked;
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
      if (url) { backdrop.src = url; backdrop.dataset.hydrated = picked; }
      const sharp = document.createElement("img");
      sharp.className = "char-avatar session-header-char";
      sharp.dataset.characterId = picked;
      sharp.alt = "";
      if (url) { sharp.src = url; sharp.dataset.hydrated = picked; }
      wrapper.appendChild(backdrop);
      wrapper.appendChild(sharp);
      old.replaceWith(wrapper);
    }
  }
  const root = document.querySelector<HTMLElement>(".view-sessions");
  const listEl = root?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

/** Carry per-chat client state onto a fresh session id - a `respawn`
 *  successor, or a fork from an older daemon. Only what the daemon does not
 *  mirror, plus the half-typed draft, which is the loss the user notices. */
export function carrySessionSettings(oldId: string, newId: string): void {
  if (isAutoAccept(oldId)) setAutoAccept(newId, true);
  state.heldMessages?.renameSession(oldId, newId);
  const charId = characterForSessionId(oldId);
  if (charId) setSessionCharacterLocal(newId, charId);
  const draft = loadDraft(oldId);
  moveComposerDraft(oldId, newId);
  if (draft) {
    void setComposerDraft(newId, draft).catch((e) => console.warn("[active-session] draft carry failed", e));
    void clearComposerDraft(oldId).catch(() => {});
  }
}

/** Repaint after `moveSessionToAccount`. In-place - same id, re-pointed - so
 *  only the account chip changes; the id-changed branch is the fork fallback.
 *  `selectSession` is injected since it lives in active-session.ts, which
 *  imports this module. */
export async function applyAccountMove(
  oldId: string,
  newId: string,
  selectSession: (sessionId: string, pane: HTMLElement) => Promise<void>,
): Promise<void> {
  await refreshSessions();
  const root = document.querySelector<HTMLElement>(".view-sessions");
  const listEl = root?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
  if (oldId === newId) {
    const moved = state.sessions.find((s) => s.session_id === newId);
    if (state.selectedId === newId) state.statusbar?.setAccountId(moved?.account_id ?? null);
    return;
  }
  carrySessionSettings(oldId, newId);
  if (state.selectedId !== oldId) return;
  const pane = root?.querySelector<HTMLElement>("#session-pane");
  if (pane) await selectSession(newId, pane);
}

/** Move a session to a different Claude account: opens the account picker,
 *  then hands off to `moveSessionToAccount`, the same call the rate-limit
 *  banner's continue-on-the-other-account button makes. */
export async function changeAccountForSession(
  sessionId: string,
  selectSession: (sessionId: string, pane: HTMLElement) => Promise<void>,
): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const picked = await openChangeAccountModal({ currentId: sess.account_id ?? null, title: "Change account" });
  if (!picked || picked === sess.account_id) return;
  try {
    const newId = await api.moveSessionToAccount(sessionId, picked);
    const label = capitalize(getCachedAccount(picked)?.label ?? "the other account");
    showToast(`Now on ${label}.`);
    await applyAccountMove(sessionId, newId, selectSession);
  } catch (e) {
    console.error("[active-session] change account failed", e);
    showToast("Failed to move chat to that account.");
  }
}
