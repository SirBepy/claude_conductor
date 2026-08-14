// Composer half of active-session-mount.ts (ai_todo 485): mountComposer plus
// its sendBundle closure, held-messages, and scheduled-chip wiring. Pure
// move, no behavior change.

import { invoke } from "../../shared/ipc";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import { ScheduledChip } from "../../shared/chat/scheduled-chip";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { blocksToText } from "../../shared/chat/content-blocks";
import { showToast } from "../../shared/toast";
import { setLightboxComposerBridge } from "../../shared/chat/lightbox";
import type { ChatEvent, ContentBlock, Instance, ScheduledItem, ScheduledKind } from "../../types/ipc.generated";
import { state } from "./state";
import { api } from "../../shared/api";
import { isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import { isBlocked, formatClockLabel, capitalize, getCachedAccount } from "../../shared/chat/rate-limit-banner";

/** Attach the composer + held-messages controller, including the `sendBundle`
 * closure both use to actually send to the daemon. */
export function mountComposer(
  pane: HTMLElement,
  sess: Instance,
  sessionId: string,
  readOnly: boolean,
): void {
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (!composerEl) return;

  // The real send-to-daemon path. Shared by the composer and the held-messages
  // controller. Unfreezes first if still frozen at call time - background
  // auto-flush (sidebar.ts) only reaches here once already unfrozen, so this
  // only fires for an explicit "send now" click.
  const sendBundle = async (blocks: ContentBlock[]): Promise<void> => {
    const inst = state.sessions.find((s) => s.session_id === sessionId);
    if (inst?.frozen) {
      try {
        await invoke<void>("unfreeze_session", { sessionId });
      } catch (err) {
        console.error("[sessions] unfreeze_session failed", err);
        showToast(`Failed to unfreeze: ${err}`);
        throw err;
      }
    }

    // Optimistically push the user's message via the store; claude -p
    // doesn't echo it back via stream-json. Cache stays consistent.
    const optimisticEvent = {
      type: "user_message",
      content: blocks,
      timestamp: BigInt(Date.now()),
    } as ChatEvent;
    sessionEvents.pushSynthetic(sessionId, optimisticEvent);

    // The daemon owns the close lifecycle: it sets Instance.closing itself the
    // moment a /close turn starts (broadcast via instances_changed, read by
    // the sidebar) and tears the session down (mark_ended + kill process) on
    // an explicit signal. The frontend no longer watches this turn for it.
    const cwd = String(sess.cwd ?? ".");

    try {
      await invoke<void>("send_message", { sessionId, cwd, blocks });
    } catch (err) {
      console.error("[sessions] send_message failed", err);
      // The optimistic bubble above claimed the send succeeded; roll it back
      // so a genuinely failed send doesn't keep looking like it went through.
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
      if (state.renderer && state.renderer.currentSessionId() === sessionId) {
        // The failed send never started a turn, so this session is not busy
        // from it - but check live rather than assume, in case another turn
        // is genuinely still in flight.
        await state.renderer.loadFromStore(cwd, { resumeLiveTicking: isCurrentSessionBusy() });
      }
      showToast(`Send failed: ${err}`);
    }
  };

  state.composer?.destroy();
  const composer = new Composer(composerEl, {
    projectDir: sess.cwd ?? null,
    getRenderer: () => state.renderer,
    onSend: sendBundle,
    // While busy, Enter stages instead of sends; when not busy but a held set
    // exists, a normal send bundles it with the draft as one message.
    isBusy: () => isCurrentSessionBusy(),
    isBlocked: () => {
      const inst = state.sessions.find((s) => s.session_id === sessionId);
      if (!inst || !isBlocked(inst)) return null;
      const resetsAtMs = Number(inst.rate_limited_resets_at) * 1000;
      const delayedMs = resetsAtMs + 60_000;
      const accLabel = capitalize(getCachedAccount(inst.account_id)?.label ?? "This account");
      return {
        resetsAtIso: new Date(delayedMs).toISOString(),
        resetsAtLabel: formatClockLabel(delayedMs),
        placeholder: `${accLabel} is out of usage until ${formatClockLabel(resetsAtMs)}. Your message will be sent when it resets.`,
      };
    },
    isFrozen: () => {
      const inst = state.sessions.find((s) => s.session_id === sessionId);
      return !!inst?.frozen;
    },
    onStage: (blocks) => state.heldMessages?.stage(blocks),
    hasHeld: () => !!state.heldMessages?.hasItemsForActive(),
    flushHeldWithDraft: (draftBlocks) => { void state.heldMessages?.flushHeldWithDraft(draftBlocks); },
    onDraftActivity: () => state.heldMessages?.notifyDraftActivity(),
    getNextTokenReset: async () => {
      if (!sess.account_id) return null;
      const map = await api.getUsageMap();
      const resetsAt = map[sess.account_id]?.session_resets_at;
      return resetsAt ? new Date(new Date(resetsAt).getTime() + 60_000) : null;
    },
    onSchedule: (blocks, fireAtUtcIso, recurrence) => {
      const prompt = blocksToText(blocks);
      if (!prompt.trim()) return;
      const kind: ScheduledKind = { type: "message", session_id: sess.session_id, cwd: String(sess.cwd ?? ".") };
      void invoke<ScheduledItem>("schedule_create", { kind, prompt, fireAt: fireAtUtcIso, recurrence })
        .then((item) => {
          showToast(`Scheduled for ${formatFireAt(item.fire_at)}`);
          void state.scheduledChip?.refresh();
        })
        .catch((err) => {
          console.error("[sessions] schedule_create failed", err);
          showToast(`Failed to schedule: ${err}`);
        });
    },
  });
  state.composer = composer;
  composer.setSessionId(sessionId, { readOnly });
  setLightboxComposerBridge({
    getDraftText: () => composer.getDraftText(),
    setDraftText: (text, clearAttachments) => composer.setDraftText(text, clearAttachments),
    getCwd: () => sess.cwd ?? null,
  });

  state.scheduledChip?.destroy();
  const scheduledChipSlot = pane.querySelector<HTMLElement>(".scheduled-chip-slot");
  state.scheduledChip = scheduledChipSlot
    ? new ScheduledChip({
        root: scheduledChipSlot,
        sessionId,
        // Pencil-edit: bring the scheduled prompt back into this pane's
        // composer as a fresh draft; the chip cancels the item itself.
        onEdit: (item) => composer.setDraftText(item.prompt),
      })
    : null;
  if (state.renderer) {
    state.renderer.onSendText = (text) => { void sendBundle([{ type: "text", text }]); };
  }

  // Held-messages controller is a singleton (its per-session set survives
  // session switches); re-attach it to this freshly-mounted pane + session.
  if (!state.heldMessages) state.heldMessages = new HeldMessages();
  const thinkingBar = pane.querySelector<HTMLElement>(".session-thinking");
  const chipSlot = pane.querySelector<HTMLElement>(".held-chip-slot");
  if (thinkingBar && chipSlot) {
    state.heldMessages.attach({
      sessionId,
      chipSlot,
      anchor: thinkingBar,
      send: sendBundle,
      interrupt: () => invoke<void>("cancel_turn", { sessionId }),
      getDraftBlocks: () => composer.getDraftBlocks(),
      isDraftEmpty: () => composer.isDraftEmpty(),
      isComposing: () => composer.isComposing(),
      clearComposer: () => composer.clearComposer(),
      getIsBusy: () => isCurrentSessionBusy(),
      onChange: () => updateThinkingBar(),
    });
    // Switching back to a chat that already finished while it wasn't
    // selected shouldn't require an unrelated instances-changed event to
    // notice the held set is flushable — check right away.
    if (!isCurrentSessionBusy() && state.heldMessages.hasItemsForActive()) {
      const freshSess = state.sessions.find((s) => s.session_id === sessionId);
      const isQuestion = freshSess?.awaiting === "question";
      state.heldMessages.onCompletion(sessionId, isQuestion);
    }
  }
  updateThinkingBar();
}
