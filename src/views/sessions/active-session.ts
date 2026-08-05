import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import type { Instance } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { getSettings } from "../../shared/state";
import {
  projectName,
  sessionSubtitle,
  loadUnreadSet,
  saveUnreadSet,
  paneEmptyStateHtml,
  statusDotClass,
  deriveQuestionSet,
} from "./sessions-helpers";
import { renderSidebar, refreshSessions } from "./sidebar";
import { characterForSession, characterIconUrl, loadSessionCharacters } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { api } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import { isAutoAccept, setAutoAccept, replayPendingPrompt, pendingPromptSessionIds, dismissQuestionCard } from "./permission-modal";
import { snapshotActiveCardDraft } from "./permission-modal/question-ui";
import { savePendingPromptDraft } from "./permission-modal/gating";
import { SessionHeader } from "./session-header";
import { setThinkingActivity } from "./session-thinking-bar";
import { isBlocked, capitalize, getCachedAccount } from "../../shared/chat/rate-limit-banner";
import { openModelEffortModal } from "./model-effort-modal";
import { registerCta } from "../../shared/chat/cta-registry";
import { mountStatusbar, mountRenderer } from "./active-session-mount";
import { mountComposer } from "./active-session-composer";
import { handleTakeoverClick } from "./active-session-takeover";
import { openJarvisKebabMenu } from "./jarvis-kebab-menu";
import {
  backgroundRetainedChat,
  dropRetainedChat,
  isRetainedRenderer,
} from "./chat-pane-cache";

const HEADER_STATUS_CLASSES = [
  "st-working", "st-question", "st-done", "st-your-turn", "st-external", "st-attention", "st-rate-limited",
];

/** Status class (st-working / st-question / …) for an open session, using the
 * same classifier the sidebar rows use so the header avatar's border colour
 * matches the sidebar strip. Exported for the live recolour on the
 * instances-changed event. */
export function headerStatusClass(sess: Instance): string {
  const unread = loadUnreadSet();
  // A prompt shown for the currently-viewed chat is parked so it survives a
  // switch-away, but its card is already on screen - don't also alarm its own
  // row. Backgrounded chats with parked prompts still badge.
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  // Registry-backed only (see deriveQuestionSet): the same single source the
  // sidebar rows read, so header ring and row can never disagree.
  const question = deriveQuestionSet(state.sessions);
  const rateLimited = new Set(state.sessions.filter(isBlocked).map((s) => s.session_id));
  return statusDotClass(sess, unread, attention, question, rateLimited);
}

/** Swap the header avatar's status ring class without re-rendering the whole
 * header. Called from instances-changed so the border stays in sync with the
 * sidebar. */
export function updateHeaderAvatarStatus(pane: HTMLElement, sess: Instance): void {
  const heroEl = pane.querySelector<HTMLElement>(".session-header-avatar");
  if (!heroEl) return;
  const st = headerStatusClass(sess);
  if (heroEl.classList.contains(st)) return;
  heroEl.classList.remove(...HEADER_STATUS_CLASSES);
  heroEl.classList.add(st);
}

/**
 * Open the Change Character modal for a session and apply the pick: persist the
 * session->character mapping, reload the session-character cache, play the new
 * character's `select` sound (best-effort), and refresh the header face + the
 * sidebar row. Shared by the header face click and the ⋮ "Change character"
 * menu (the latter imports this dynamically to avoid an import cycle).
 */
export async function changeCharacterForSession(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const current = characterForSession(sess);
  const picked = await openChangeCharacterModal({ projectId: sess.project_id, currentId: current });
  if (!picked || picked === current) return;
  try {
    await api.setSessionCharacter(sessionId, picked);
    await loadSessionCharacters();
    void api.playCharacterSlot(picked, "select").catch(() => { /* sound is best-effort */ });
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

/**
 * Carry client-side per-chat state onto the fresh session id a
 * `moveSessionToAccount` fork produces. The daemon already ports
 * model/effort/account_id (and, for auto-accept, the persisted chat-config
 * flag) onto the new id itself - see `move_session_to_account` in
 * `daemon/methods/lifecycle.rs`. What's left is state that only exists in
 * THIS running client and has no daemon-side mirror: the in-memory
 * auto-accept gate (the runtime source of truth for the permission modal,
 * only rehydrated from disk at app launch) and any staged-but-unsent held
 * messages. Shared by both `moveSessionToAccount` callers (this module's
 * "Change account" flow and the rate-limit banner's "Continue on <Other>").
 */
export function carrySessionSettings(oldId: string, newId: string): void {
  if (isAutoAccept(oldId)) setAutoAccept(newId, true);
  state.heldMessages?.renameSession(oldId, newId);
}

/**
 * Move a session to a different Claude account: opens the account picker,
 * forks the transcript onto a fresh session id under the picked account
 * (via `moveSessionToAccount`, the same mechanism the rate-limit banner's
 * "Continue on <Other>" button uses), then retires the old session.
 * Shared by the statusline account chip's click handler and the ⋮ "Change
 * account" menu item.
 */
export async function changeAccountForSession(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const picked = await openChangeAccountModal({ currentId: sess.account_id ?? null, title: "Change account" });
  if (!picked || picked === sess.account_id) return;
  try {
    const newId = await api.moveSessionToAccount(sessionId, picked);
    carrySessionSettings(sessionId, newId);
    const label = capitalize(getCachedAccount(picked)?.label ?? "the other account");
    showToast(`Moved to ${label}, continuing there.`);
    await refreshSessions();
    const root = document.querySelector<HTMLElement>(".view-sessions");
    const listEl = root?.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
    if (state.selectedId === sessionId) {
      const pane = root?.querySelector<HTMLElement>("#session-pane");
      if (pane) await selectSession(newId, pane);
    }
  } catch (e) {
    console.error("[active-session] change account failed", e);
    showToast("Failed to move chat to that account.");
  }
}

let _watchedId: string | null = null;

export function unwatchCurrentExternalSession(): void {
  if (_watchedId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
}

export function dismountActivePane(opts?: { rerenderSidebar?: boolean }): void {
  state.statusbar?.destroy();
  state.statusbar = null;
  if (state.selectedId) backgroundRetainedChat(state.selectedId);
  if (state.renderer && !isRetainedRenderer(state.renderer)) state.renderer.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;
  state.scheduledChip?.destroy();
  state.scheduledChip = null;
  state.changesPanel?.unmount();
  state.changesPanel = null;
  state.activeChatActions = null;
  setThinkingActivity(null);
  setActiveSession(null);
  const pane = document.querySelector<HTMLElement>(".session-pane #session-pane")
    ?? document.querySelector<HTMLElement>("#session-pane");
  if (pane) pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
  if (opts?.rerenderSidebar !== false) {
    const root = document.querySelector<HTMLElement>(".view-sessions");
    if (root) {
      const listEl = root.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
    }
  }
}

registerCta("pickup", {
  label: "Close & start new chat with /pickup",
  icon: "hand-fist",
  handler: async () => {
    const sess = state.sessions.find(s => s.session_id === state.selectedId);
    if (!sess) return;
    const project = { path: String(sess.cwd ?? ""), name: projectName(sess) };
    const config = await openModelEffortModal(project.path, project.name);
    if (!config) return;
    void state.composer?.sendText("/close");
    state.launchNewChatCallback?.(project, { ...config, initialMessage: "/pickup" });
  },
});

export async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
  // Mobile single-pane: opening a chat reveals the chat pane (CSS only acts on
  // this attribute inside the ≤768px media query, so desktop is unaffected).
  // Set before the same-session early return so re-tapping the open chat from
  // the list overlay still switches away from the list.
  document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
  if (state.selectedId === sessionId) return;
  // Snapshot any in-progress AUQ answer before the pane is replaced, so it
  // survives the session switch even if another session also gets an AUQ.
  if (state.selectedId) {
    const draft = snapshotActiveCardDraft(state.selectedId);
    if (draft) savePendingPromptDraft(state.selectedId, draft);
    // Scroll position must be read BEFORE the pane's DOM is replaced below - a
    // detached transcript reports scrollTop 0.
    backgroundRetainedChat(state.selectedId);
  }
  // Tear down before innerHTML replacement below: otherwise the registry
  // entry, its keydown listener, and ResizeObserver dangle past their DOM.
  // Display-only teardown - doesn't fire onSubmit/onCancel.
  dismissQuestionCard();
  // Unwatch any previously watched session if we're switching to a different one.
  if (_watchedId && _watchedId !== sessionId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
  const myMount = state.mountId;
  setActiveSession(sessionId);

  // Mark session as read
  const unread = loadUnreadSet();
  if (unread.has(sessionId)) {
    unread.delete(sessionId);
    saveUnreadSet(unread);
  }

  // Clean up prior statusbar timer before wiping the pane.
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }

  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) {
    pane.innerHTML = `<div class="session-empty">Session ${escapeHtml(sessionId)} not found</div>`;
    return;
  }
  const readOnly = sess.kind === "external" || sess.kind === "automated";
  pane.classList.toggle("is-rate-limited", isBlocked(sess));
  const headerCharId = characterForSession(sess);
  const headerIconUrl = headerCharId ? characterIconUrl(headerCharId) : null;
  const headerStatus = headerStatusClass(sess);

  // Opt-in cue (Settings > Sound, default off): play the character's "select"
  // sound when a session row is clicked. Per-slot toggle + mute enforced in Rust.
  if (headerCharId && getSettings().selectOnSessionClick === true) {
    void api.playCharacterSlot(headerCharId, "select").catch(() => { /* best-effort */ });
  }

  const header = new SessionHeader({ title: sessionSubtitle(sess), meta: projectName(sess) });
  header.onCharClick = () => { void changeCharacterForSession(sess.session_id); };
  header.setRemote(sess.is_remote);
  header.bindSession({
    sessionId: sess.session_id,
    readOnly,
    charId: headerCharId,
    charUrl: headerIconUrl,
    charStatus: headerStatus,
    cwd: sess.cwd ? String(sess.cwd) : null,
    autoAcceptOn: !readOnly && isAutoAccept(sess.session_id),
  });
  // Jarvis has no in-app view (it only lives at #detached?session=<id>), so
  // its window's pane header is the only place a menu can go. Gated on both
  // "this IS a detached window" and "this session IS jarvis" so a regular
  // popped-out session window never grows the button.
  if (document.body.classList.contains("detached-mode") && sess.jarvis) {
    header.addKebabButton((btn) => openJarvisKebabMenu(btn, sess.session_id));
  }

  pane.innerHTML = [
    `<div class="session-statusbar-host"></div>`,
    readOnly ? `<div class="readonly-banner"><i class="ph ph-eye"></i> <span class="readonly-banner-text">Read-only session</span><button type="button" class="refresh-btn" title="Reload messages"><i class="ph ph-arrows-clockwise"></i></button><button type="button" class="takeover-btn">Take Over</button></div>` : "",
    `<div class="session-messages"></div>`,
    `<div class="session-thinking" hidden><span class="thinking-text"></span><span class="held-chip-slot"></span><button class="thinking-pause-btn icon-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i></button></div>`,
    `<div class="scheduled-chip-slot"></div>`,
    `<div class="session-composer"></div>`,
  ].join("");
  pane.insertBefore(header.el, pane.firstChild);

  pane.querySelector<HTMLButtonElement>(".thinking-pause-btn")?.addEventListener("click", () => {
    void invoke<void>("cancel_turn", { sessionId: sess.session_id }).catch(err => console.error("[sessions] cancel_turn failed", err));
  });

  if (headerCharId) void hydrateCharacterAvatars(pane);
  void hydrateProjectTechIcons(pane);

  // Mount statusbar.
  await mountStatusbar(pane, sess, () => { void changeAccountForSession(sess.session_id); });

  // Attach renderer + changes panel; bail out if a newer mount/selectSession
  // superseded us mid-await (same bail-out the inline code used to do).
  const rendererMounted = await mountRenderer(pane, sess, header, sessionId, myMount, () => {
    setActiveSession(null);
    void selectSession(sessionId, pane);
  });
  if (!rendererMounted) return;

  // Attach composer + held-messages controller.
  mountComposer(pane, sess, sessionId, readOnly);

  // Start real-time file watcher for all sessions. External sessions get new
  // messages this way; Interactive sessions also need it so that turns
  // continued in a terminal appear in the UI. Watcher emits chat-watch:<id>
  // events; the store's ensureWatchListener deduplicates against runner events.
  _watchedId = sessionId;
  void invoke<void>("watch_session_transcript", { sessionId, cwd: sess.cwd ?? null })
    .then(() => sessionEvents.ensureWatchListener(sessionId))
    .catch((err) => console.warn("[sessions] watch_session_transcript failed:", err));

  if (readOnly) {
    pane.querySelector<HTMLButtonElement>(".refresh-btn")?.addEventListener("click", async () => {
      sessionEvents.bust(sessionId);
      // Busting the events alone would still re-show the retained transcript.
      dropRetainedChat(sessionId);
      // Clear selectedId so selectSession doesn't bail on the equality check.
      setActiveSession(null);
      await selectSession(sessionId, pane);
    });
    const takeoverBtn = pane.querySelector<HTMLButtonElement>(".takeover-btn");
    takeoverBtn?.addEventListener("click", () => {
      void handleTakeoverClick(pane, sess, takeoverBtn, {
        getWatchedId: () => _watchedId,
        setWatchedId: (id) => { _watchedId = id; },
        updateHeaderAvatarStatus,
      });
    });
  }

  // Re-render sidebar to mark active row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }

  // If this chat parked a permission/question prompt while it was in the
  // background, surface it now that the pane (and composer anchor) is mounted.
  replayPendingPrompt(sessionId);
}

