// renderPendingPane's mount steps (same split as active-session-mount.ts):
// pane chrome (header + markup), statusbar mount, and renderer attach +
// session-started watcher. Composer wiring lives in pending-pane-composer.ts.

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { setCodeModeChatProvider, enterCodeMode } from "./code-mode/entry";
import { sessionCodeModeChat } from "./code-mode/session-chat";
import { state } from "./state";
import { syncThinkingBar } from "./session-thinking-bar";
import { renderSidebar, refreshSessions } from "./sidebar";
import { characterIconUrl } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import type { SessionConfig } from "./model-effort-modal";
import { setAutoAccept } from "./permission-modal";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero, fetchGitInfo } from "./session-statusbar";
import { savePendingSession } from "./pending-draft-storage";
import { SessionHeader } from "./session-header";
import { applyHeaderMerge } from "./mobile-header-merge";

export function rebuildSidebar(): void {
  const listEl = document.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

/** Build the pane's markup, mount the SessionHeader, and wire the pieces that
 *  don't depend on the statusbar or the renderer (discard, cancel button,
 *  avatar). Returns the header so the caller can keep it (pending-pane.ts's
 *  module-level `_pendingHeader`, which rebindPaneHeader also reads). */
export function mountPendingChrome(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  onDiscard?: (pane: HTMLElement) => void,
): SessionHeader {
  const header = new SessionHeader({
    title: "New chat",
    meta: project.name,
    onDiscard: onDiscard ? () => onDiscard(pane) : undefined,
  });
  pane.innerHTML = [
    `<div class="session-statusbar-host"></div>`,
    // Empty on purpose: the hint mounts later, via mountPendingHint() AFTER
    // attachPendingRenderer() - ChatRenderer.attach() does `container.innerHTML
    // = ""` on the SAME `.session-messages` element (chat-renderer.ts), so a
    // hint seeded here would be wiped before it ever painted a frame.
    `<div class="session-messages"></div>`,
    `<div class="composer-shell">`,
    `  <div class="session-thinking" hidden><span class="thinking-text"></span><span class="held-chip-slot"></span><button class="thinking-pause-btn icon-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i></button></div>`,
    `  <div class="session-composer"></div>`,
    `</div>`,
  ].join("\n");
  pane.insertBefore(header.el, pane.firstChild);
  // Same re-home as active-session.ts: without it a draft keeps the phone's
  // back / ⋮ in a second header band above this one.
  applyHeaderMerge();
  // The wipe above ran after setSessionScope, so the FAB host is detached.
  state.fabDial?.reattach();

  pane.querySelector<HTMLButtonElement>(".thinking-pause-btn")?.addEventListener("click", async () => {
    // Same source of truth the established pane's button closes over: the
    // renderer's own tracked session id, which swapSubscription flips to the
    // real id on promotion (state.pendingNewSession goes null right after).
    const cancelTarget = state.renderer?.currentSessionId() ?? placeholderId;
    try { await invoke<void>("cancel_turn", { sessionId: cancelTarget }); }
    catch (err) { console.error("[sessions] cancel_turn failed", err); }
  });

  // Show the character the user picked in the new-session modal, mirroring the
  // sidebar draft row's data path. Without this the header keeps the bare "?"
  // placeholder while the sidebar already shows the portrait. No status glow on
  // a draft (nothing is in flight). Hydrate fills the icon if it isn't cached.
  if (config.characterId) {
    header.setAvatar(config.characterId, characterIconUrl(config.characterId), "", project.path);
    void hydrateCharacterAvatars(pane);
  } else {
    header.setAvatar(null, null, "", project.path);
  }
  void hydrateProjectTechIcons(pane);

  return header;
}

/** Paint the "type a message to start" hint into `.session-messages`. Must run
 *  AFTER attachPendingRenderer()'s `renderer.attach()` - see the comment on
 *  mountPendingChrome's template above for why this can't be seeded earlier.
 *  No-op if a newer mount superseded this one, or if the pane already moved
 *  past the draft stage (same bail-out shape as the rest of this module). */
export function mountPendingHint(
  pane: HTMLElement,
  project: { name: string },
  myMount: number,
): void {
  if (state.mountId !== myMount) return;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl || messagesEl.querySelector(".session-pending-hint")) return;
  // .v-empty (motion.css) is the shared empty-state idiom, the same one
  // sidebar-entries.ts's empty row uses.
  messagesEl.insertAdjacentHTML("afterbegin", [
    `<div class="session-pending-hint v-empty">`,
    `  <i class="ph ph-paper-plane-tilt v-empty-icon"></i>`,
    `  <div class="v-empty-title">New chat</div>`,
    `  <div class="v-empty-hint">Type a message below to start a session in <strong>${escapeHtml(project.name)}</strong>.</div>`,
    `</div>`,
  ].join("\n"));
}

/** Mount the statusbar for the pending pane. No-op if the host slot isn't in
 *  the DOM (same shape as active-session-mount.ts's mountStatusbar). */
export async function mountPendingStatusbar(
  pane: HTMLElement,
  project: { path: string; name: string },
  config: SessionConfig,
  placeholderId: string,
  header: SessionHeader | null,
): Promise<void> {
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (!sbHost) return;
  const rows = await loadStatuslineRows();
  const hideZero = await loadStatuslineHideZero();
  const sb = new SessionStatusbar(sbHost, null, rows, {
    cwd: project.path,
    effort: config.effort,
    sessionId: placeholderId,
    sessionModel: config.model || null,
    hideZero,
    accountId: config.accountId ?? null,
    onEffortChange: (e) => { config.effort = e; },
    onModelChange: (m) => { config.model = m; },
    onConfig: (model, effort, effortEditable) => header?.setConfig(model, effort, effortEditable),
  });
  state.statusbar = sb;
  if (header) {
    header.onConfigClick = (which, anchor) => {
      if (which === "model") sb.toggleModelPopover(anchor);
      else sb.toggleEffortPopover(anchor);
    };
  }
  fetchGitInfo(project.path)
    // Object identity alone isn't enough: sb.gitCwd may have moved (worktree
    // resolution) since this fetch started, and updateGitInfo caches under
    // the LIVE gitCwd - a stale write would poison the new cwd's entry.
    .then((info) => { if (state.statusbar === sb && sb.isCurrentCwd(project.path)) sb.updateGitInfo(info); })
    .catch(() => {});
}

/** Attach the ChatRenderer to the pending pane and watch for the placeholder's
 *  promotion to a real session id. `myMount` is the mount generation captured
 *  by the caller at the top of renderPendingPane - every bail-out below
 *  re-checks it, same as before extraction. */
export async function attachPendingRenderer(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  header: SessionHeader | null,
  myMount: number,
): Promise<void> {
  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return;

  const renderer = new ChatRenderer(messagesEl);
  state.renderer = renderer;
  // A fresh draft owns none of the previous chat's progress/activity.
  syncThinkingBar(renderer);
  // Code mode works on a draft too: its repo, no session or edits yet.
  const headerEl = header?.el ?? null;
  setCodeModeChatProvider(project.path && headerEl
    ? () => sessionCodeModeChat({ pane, sessionId: renderer.sessionId, cwd: project.path, headerEl, renderer })
    : null);
  if (header) header.onCodeModeClick = () => void enterCodeMode();
  const sbForRenderer = state.statusbar;
  if (sbForRenderer) {
    renderer.onMetaUpdate = (meta) => {
      if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
    };
    renderer.onToolTally = (t) => {
      if (state.statusbar === sbForRenderer) sbForRenderer.updateToolTally(t);
    };
    sbForRenderer.updateToolTally(renderer.toolTally);
  }
  // Must attach BEFORE the first invoke so the placeholder channel is
  // subscribed before Rust mirrors SessionStarted onto it.
  await renderer.attach(placeholderId);
  if (state.mountId !== myMount) { renderer.detach(); return; }

  let unsubPlaceholderWatch: (() => void) | null = null;
  unsubPlaceholderWatch = sessionEvents.subscribe(placeholderId, async (payload) => {
    if (payload.type !== "session_started") return;
    const realId = payload.session_id;
    if (!realId) return;
    // New-chat auto-accept (modal checkbox, default on): arm it the instant
    // the real session id is known so first-turn prompts auto-allow.
    if (config.autoAccept !== false) setAutoAccept(realId, true);
    // Apply the character chosen in the new-session pane to the real session.
    if (config.characterId) void api.setSessionCharacter(realId, config.characterId).catch(() => {});
    if (unsubPlaceholderWatch) {
      try { unsubPlaceholderWatch(); } catch { /* ignore */ }
      unsubPlaceholderWatch = null;
    }
    if (state.mountId !== myMount) return;
    // Guard: don't clobber a newer pending if the user started another chat.
    if (state.pendingNewSession?.placeholderId === placeholderId) {
      state.pendingNewSession.realId = realId;
      savePendingSession(state.pendingNewSession);
    }
    const isStillActive = state.selectedId === placeholderId;
    if (isStillActive && state.renderer && state.renderer.currentSessionId() === placeholderId) {
      await state.renderer.swapSubscription(realId);
    }
    // Refresh state.sessions now (the daemon-side reseed on the Rust side
    // runs before this event fires) so the sidebar can render the real,
    // segmented row immediately instead of the static "starting..."
    // placeholder, which never reflects live status.
    await refreshSessions();
    if (state.mountId !== myMount) return;
    rebuildSidebar();
  });
}
