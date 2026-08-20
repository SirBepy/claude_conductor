import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import type { ChatEvent, ContentBlock, ScheduledItem, ScheduledKind } from "../../types/ipc.generated";
import { blocksToText } from "../../shared/chat/content-blocks";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { state, setActiveSession } from "./state";
import { isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import { projectName, sessionSubtitle } from "./sessions-helpers";
import { renderSidebar, refreshSessions } from "./sidebar";
import { characterForSession, characterIconUrl } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import type { SessionConfig } from "./model-effort-modal";
import { isAutoAccept, setAutoAccept } from "./permission-modal";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero, fetchGitInfo } from "./session-statusbar";
import { savePendingSession, clearPendingSession } from "./pending-draft-storage";
import { ChangesPanel, dedupeByPath } from "./changes-panel";
import { SessionHeader } from "./session-header";
import { showToast } from "../../shared/toast";
import { wireRenderer } from "./active-session-mount";
import { retainChat } from "./chat-pane-cache";

let _pendingHeader: SessionHeader | null = null;

function rebuildSidebar(): void {
  const listEl = document.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

export async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  onDiscard?: (pane: HTMLElement) => void,
): Promise<void> {
  const myMount = state.mountId;

  _pendingHeader = new SessionHeader({
    title: "New chat",
    meta: project.name,
    onDiscard: onDiscard ? () => onDiscard(pane) : undefined,
  });
  pane.innerHTML = [
    `<div class="session-statusbar-host"></div>`,
    `<div class="session-messages">`,
    `  <div class="session-pending-hint">`,
    `    <i class="ph ph-paper-plane-tilt"></i>`,
    `    <p>Type a message below to start a new session in <strong>${escapeHtml(project.name)}</strong>.</p>`,
    `  </div>`,
    `</div>`,
    `<div class="composer-shell">`,
    `  <div class="session-thinking" hidden><span class="thinking-text"></span><span class="held-chip-slot"></span><button class="thinking-pause-btn icon-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i></button></div>`,
    `  <div class="session-composer"></div>`,
    `</div>`,
  ].join("\n");
  pane.insertBefore(_pendingHeader.el, pane.firstChild);

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
    _pendingHeader.setAvatar(config.characterId, characterIconUrl(config.characterId), "", project.path);
    void hydrateCharacterAvatars(pane);
  } else {
    _pendingHeader.setAvatar(null, null, "", project.path);
  }
  void hydrateProjectTechIcons(pane);

  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const rows = await loadStatuslineRows();
    const hideZero = await loadStatuslineHideZero();
    const sb = new SessionStatusbar(sbHost, null, rows, {
      cwd: project.path,
      effort: config.effort,
      sessionId: placeholderId,
      sessionModel: config.model || null,
      hideZero,
      onEffortChange: (e) => { config.effort = e; },
      onModelChange: (m) => { config.model = m; },
    });
    state.statusbar = sb;
    fetchGitInfo(project.path)
      // Object identity alone isn't enough: sb.gitCwd may have moved (worktree
      // resolution) since this fetch started, and updateGitInfo caches under
      // the LIVE gitCwd - a stale write would poison the new cwd's entry.
      .then((info) => { if (state.statusbar === sb && sb.isCurrentCwd(project.path)) sb.updateGitInfo(info); })
      .catch(() => {});
  }

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    // Let the PR-preview modal's git IPC calls resolve this pending
    // session's working directory.
    setPrReviewCwdProvider(() => project.path || null);
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

  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer?.destroy();
    let started = false;

    // Flush a held bundle to the (by-now-started) session. Resolves the real id
    // dynamically: a flush only happens after the first message started the
    // turn, so the placeholder has already been upgraded to a real session id.
    const heldSend = async (blocks: ContentBlock[]): Promise<void> => {
      const target = state.pendingNewSession?.realId ?? state.selectedId;
      if (!target || target === placeholderId) return;
      sessionEvents.pushSynthetic(target, {
        type: "user_message",
        content: blocks,
        timestamp: BigInt(Date.now()),
      } as ChatEvent);
      try {
        await invoke<void>("send_message", { sessionId: target, cwd: project.path, blocks });
      } catch (err) {
        console.error("[sessions] held flush send failed", err);
        showToast(`Send failed: ${err}`);
      }
    };
    const heldInterrupt = (): Promise<void> => {
      const target = state.pendingNewSession?.realId ?? state.selectedId ?? placeholderId;
      return invoke<void>("cancel_turn", { sessionId: target });
    };

    const composer = new Composer(composerEl, {
      projectDir: project.path,
      getRenderer: () => state.renderer,
      // Staging routing (same as the established pane): while busy, Enter holds
      // the message; not-busy-with-held bundles it. The FIRST message never
      // stages (isBusy is false until firstMessageSent), so it still starts the
      // session via onSend below.
      isBusy: () => isCurrentSessionBusy(),
      onStage: (blocks) => state.heldMessages?.stage(blocks),
      hasHeld: () => !!state.heldMessages?.hasItemsForActive(),
      flushHeldWithDraft: (draftBlocks) => { void state.heldMessages?.flushHeldWithDraft(draftBlocks); },
      sendQueuedNow: () => { void state.heldMessages?.sendNow(); },
      onDraftActivity: () => state.heldMessages?.notifyDraftActivity(),
      // Phase 3: schedule a follow-up. The KIND is decided at scheduling time,
      // not pane-mount time: once this draft's first message has started a real
      // session, a scheduled message must target THAT session
      // (Message{session_id}) - otherwise it silently spawns a disconnected new
      // chat the user (staring at this conversation) never sees (ai_todo 322
      // item 5). A still-unstarted draft schedules a NewChat, tagged with this
      // pane's placeholderId so the sidebar can hide the draft row until it
      // fires (item 6).
      onSchedule: (blocks: ContentBlock[], fireAtUtcIso: string, recurrence) => {
        const prompt = blocksToText(blocks);
        if (!prompt.trim()) return;
        const realId =
          state.pendingNewSession?.placeholderId === placeholderId
            ? state.pendingNewSession.realId
            : null;
        const kind: ScheduledKind = realId
          ? { type: "message", session_id: realId, cwd: project.path }
          : {
              type: "new_chat",
              cwd: project.path,
              model: config.model,
              effort: config.effort,
              account_id: config.accountId ?? null,
              placeholder_id: placeholderId,
              character_id: config.characterId ?? null,
              auto_accept: config.autoAccept !== false,
            };
        void invoke<ScheduledItem>("schedule_create", { kind, prompt, fireAt: fireAtUtcIso, recurrence })
          .then((item) => {
            showToast(
              realId
                ? `Scheduled message for ${formatFireAt(item.fire_at)}`
                : `Scheduled new chat for ${formatFireAt(item.fire_at)}`,
            );
          })
          .catch((err) => {
            console.error("[sessions] schedule_create failed", err);
            showToast(`Failed to schedule: ${err}`);
          });
      },
      onSend: async (blocks: ContentBlock[]) => {
        if (state.mountId !== myMount) return;
        const promptText = blocksToText(blocks);
        if (!promptText.trim()) return;

        // Synthetic push: claude -p never echoes the prompt on stdout, so
        // without this the user wouldn't see their typed text in the chat.
        const targetSid = state.renderer?.currentSessionId() ?? placeholderId;
        sessionEvents.pushSynthetic(targetSid, {
          type: "user_message",
          content: blocks,
          timestamp: BigInt(Date.now()),
        } as ChatEvent);

        if (!started) {
          started = true;
          if (state.pendingNewSession) {
            state.pendingNewSession.firstMessageSent = true;
            state.pendingNewSession.firstMessageSentAt = Date.now();
            savePendingSession(state.pendingNewSession);
          }
          pane.querySelector(".session-pending-hint")?.remove();
          rebuildSidebar();
          try {
            const sessionId = await invoke<string>("start_session", {
              cwd: project.path,
              prompt: promptText,
              model: config.model,
              effort: config.effort,
              remote: config.remote !== false,
              placeholderId,
              accountId: config.accountId ?? null,
              // Persisted server-side in the SAME registration call the daemon
              // makes before this RPC returns (not just the setAutoAccept
              // follow-up below), so a remote/phone caller's first-turn tool
              // call can't race ahead of it under real network latency.
              autoAccept: config.autoAccept !== false,
            });
            if (state.mountId !== myMount) return;
            if (sessionId) {
              if (config.autoAccept !== false) setAutoAccept(sessionId, true);
              const isStillActive = state.selectedId === placeholderId || state.selectedId === sessionId;
              if (isStillActive && state.renderer && state.renderer.currentSessionId() !== sessionId) {
                await state.renderer.swapSubscription(sessionId);
              }
              if (isStillActive && state.composer) state.composer.setSessionId(sessionId, { readOnly: false });
              if (isStillActive) setActiveSession(sessionId);
              // Held set was keyed by the placeholder id; migrate it to the real
              // session id so the chip + completion auto-flush match.
              state.heldMessages?.renameSession(placeholderId, sessionId);
              // Guard: don't clobber a newer pending if the user started another chat.
              if (state.pendingNewSession?.placeholderId === placeholderId) {
                state.pendingNewSession = null;
                clearPendingSession();
              }
              await refreshSessions();
              if (state.mountId !== myMount) return;
              rebuildSidebar();
              if (isStillActive) rebindPaneHeader(pane, sessionId);
            }
          } catch (err) {
            console.error("[sessions] start_session failed", err);
            started = false;
            // Roll the pending row back to a draft so it doesn't hang on
            // "starting…" forever; the user can retry from the same composer
            // or discard it. (Native alert() routes through the dialog plugin,
            // which is blocked by the ACL here, so use the in-app toast.)
            if (state.pendingNewSession?.placeholderId === placeholderId) {
              state.pendingNewSession.firstMessageSent = false;
              state.pendingNewSession.firstMessageSentAt = null;
              savePendingSession(state.pendingNewSession);
            }
            rebuildSidebar();
            showToast(`Failed to start session: ${err}`);
          }
          return;
        }

        const realId = state.pendingNewSession?.realId ?? state.selectedId;
        if (!realId || realId === placeholderId) {
          showToast("Session is still starting; please wait for the first response.");
          return;
        }
        try {
          await invoke<void>("send_message", { sessionId: realId, cwd: project.path, blocks });
        } catch (err) {
          console.error("[sessions] send_message failed", err);
          showToast(`Send failed: ${err}`);
        }
      },
    });
    state.composer = composer;
    composer.setSessionId(placeholderId, { readOnly: false });

    // Attach the held-messages controller to the pending pane, keyed by the
    // placeholder id until start_session upgrades it (renameSession above). The
    // first message never stages (isBusy false until firstMessageSent), so it
    // still starts the session normally.
    if (!state.heldMessages) state.heldMessages = new HeldMessages();
    const thinkingBar = pane.querySelector<HTMLElement>(".session-thinking");
    const chipSlot = pane.querySelector<HTMLElement>(".held-chip-slot");
    if (thinkingBar && chipSlot) {
      state.heldMessages.attach({
        sessionId: placeholderId,
        chipSlot,
        anchor: thinkingBar,
        send: heldSend,
        interrupt: heldInterrupt,
        getDraftBlocks: () => composer.getDraftBlocks(),
        isDraftEmpty: () => composer.isDraftEmpty(),
        isComposing: () => composer.isComposing(),
        clearComposer: () => composer.clearComposer(),
        getIsBusy: () => isCurrentSessionBusy(),
        onChange: () => updateThinkingBar(),
      });
    }
    updateThinkingBar();
  }

  const ta = pane.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (ta) ta.focus();

  if (config.initialMessage) {
    const msg = config.initialMessage;
    setTimeout(() => { void state.composer?.sendText(msg); }, 0);
  }

}

function rebindPaneHeader(pane: HTMLElement, sessionId: string): void {
  if (state.statusbar) {
    state.statusbar.setSessionId(sessionId);
    state.statusbar.setReadOnlyEffort(false);
    state.statusbar.disableModelEdit();
  }
  pane.querySelector(".session-pending-hint")?.remove();

  const h = _pendingHeader;
  if (!h) return;

  const sess = state.sessions.find((s) => s.session_id === sessionId);
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
    state.changesPanel?.unmount();
    // Full shared wiring (tool-view provider, activity/progress/todo/CTA
    // callbacks, activeChatActions) - not just the changes-panel subset this used
    // to hand-roll, which is exactly why a promoted draft looked like a chat but
    // wasn't wired like one (ai_todo: draft-promotion lookalike bug).
    const panel = new ChangesPanel();
    wireRenderer(pane, sess, h, renderer, panel);
    // onFileEditsChanged above is a fresh listener; edits from before promotion
    // (nothing was listening yet) need seeding, same as a retained-pane remount.
    const seeded = renderer.getFileEdits();
    panel.onUpdate(seeded);
    h.setChangesBadge(dedupeByPath(seeded).length);
    // Register with the pane cache so the next navigate-away-and-back is a
    // cache hit (element swap) instead of the cold rebuild that used to be
    // the only thing that fully re-wired a promoted chat.
    retainChat(sessionId, renderer, messagesEl);
  }
}
