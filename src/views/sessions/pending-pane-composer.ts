// The draft pane's Composer, its send/schedule/held-message routing, and the
// held-messages controller attach (renderPendingPane's composer step, same
// split as active-session-composer.ts).

import { invoke } from "../../shared/ipc";
import type { ChatEvent, ContentBlock, ScheduledItem, ScheduledKind } from "../../types/ipc.generated";
import { blocksToText } from "../../shared/chat/content-blocks";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { state, setActiveSession } from "./state";
import { isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import type { SessionConfig } from "./model-effort-modal";
import { setAutoAccept } from "./permission-modal";
import { savePendingSession, clearPendingSession } from "./pending-draft-storage";
import { showToast } from "../../shared/toast";
import { sendWithFailureRecovery } from "./send-with-failure-recovery";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import { sessionEvents } from "../../shared/chat/event-store";
import { refreshSessions } from "./sidebar";
import { rebuildSidebar } from "./pending-pane-mount";

export interface PendingComposerDeps {
  /** Promote the pane's chrome from draft to real-session once start_session
   *  resolves. Passed in (rather than imported) so this module doesn't need
   *  to import back into pending-pane.ts, which owns `_pendingHeader`. */
  rebindPaneHeader: (pane: HTMLElement, sessionId: string) => void;
}

/** Mount the composer, wire send/schedule/held-message routing, and attach
 *  the held-messages controller. `myMount` is the mount generation captured
 *  by the caller at the top of renderPendingPane. */
export function wirePendingComposer(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  myMount: number,
  deps: PendingComposerDeps,
): void {
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (!composerEl) return;

  state.composer?.destroy();
  let started = false;

  // Flush a held bundle to the (by-now-started) session. Resolves the real id
  // dynamically: a flush only happens after the first message started the
  // turn, so the placeholder has already been upgraded to a real session id.
  const heldSend = async (blocks: ContentBlock[]): Promise<void> => {
    const target = state.pendingNewSession?.realId ?? state.selectedId;
    // The stated assumption (a flush only happens once the placeholder has
    // upgraded to a real id) can be wrong; fail loudly instead of resolving
    // as though the bundle was delivered, so HeldMessages.flush()'s catch
    // restages it rather than losing it silently.
    if (!target || target === placeholderId) {
      throw new Error("heldSend: no real session id yet, cannot deliver held bundle");
    }
    const optimisticEvent = {
      type: "user_message",
      content: blocks,
      timestamp: BigInt(Date.now()),
    } as ChatEvent;
    sessionEvents.pushSynthetic(target, optimisticEvent);
    await sendWithFailureRecovery(target, project.path, blocks, optimisticEvent);
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
    onStage: (blocks) => state.heldMessages?.stage(blocks) ?? false,
    hasHeld: () => !!state.heldMessages?.hasItemsForActive(),
    popLastHeld: () => state.heldMessages?.popLastForActive() ?? null,
    flushHeldWithDraft: (draftBlocks) => state.heldMessages?.flushHeldWithDraft(draftBlocks) ?? false,
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
      const optimisticEvent = {
        type: "user_message",
        content: blocks,
        timestamp: BigInt(Date.now()),
      } as ChatEvent;
      sessionEvents.pushSynthetic(targetSid, optimisticEvent);

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
            placeholderId,
            accountId: config.accountId ?? null,
            // Machine federation (H4): spawns on a peer instead of this
            // machine when the new-chat picker's machine chip picked one.
            machineId: config.machineId ?? null,
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
            if (isStillActive) deps.rebindPaneHeader(pane, sessionId);
          } else {
            // A resolve with no id runs none of the branch above and never
            // reaches the catch, so nothing clears the pending row and it
            // holds "starting..." indefinitely. Throwing routes it through
            // the same rollback a rejected spawn already gets.
            throw new Error("start_session resolved without a session id");
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
          // The row is back to a draft, so put the text back in the composer
          // to match: rethrowing is what triggers its restoreDraft.
          sessionEvents.removeSynthetic(targetSid, optimisticEvent);
          throw err;
        }
        return;
      }

      const realId = state.pendingNewSession?.realId ?? state.selectedId;
      if (!realId || realId === placeholderId) {
        showToast("Session is still starting; please wait for the first response.");
        // Throw, don't return: the composer restores the draft only on a
        // rejection. Drop the bubble too, or the restore reads as a dupe.
        sessionEvents.removeSynthetic(targetSid, optimisticEvent);
        throw new Error("session not started yet");
      }
      await sendWithFailureRecovery(realId, project.path, blocks, optimisticEvent);
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
      focusComposer: () => composer.focus(),
      getIsBusy: () => isCurrentSessionBusy(),
      onChange: () => updateThinkingBar(),
    });
  }
  updateThinkingBar();
}
