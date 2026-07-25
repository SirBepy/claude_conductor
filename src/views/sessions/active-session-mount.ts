// Mount helpers extracted from active-session.ts's `selectSession` (ai_todo 182):
// the statusbar, renderer, and composer each get their own focused mount
// function so `selectSession` stays a thin orchestrator. No behavior change -
// pure move, callbacks injected where the original code reached back into
// active-session.ts (e.g. change-account) to avoid an import cycle.

import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import { ScheduledChip } from "../../shared/chat/scheduled-chip";
import { formatFireAt } from "../../shared/chat/schedule-picker";
import { blocksToText } from "../../shared/chat/content-blocks";
import { showToast } from "../../shared/toast";
import { setFileEditsProvider } from "../../shared/chat/file-viewer";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import type { ChatEvent, ContentBlock, Instance, ScheduledItem, ScheduledKind } from "../../types/ipc.generated";
import { state } from "./state";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero } from "./session-statusbar";
import { readLastChoice, readPresets } from "../../shared/effort-presets";
import { renderSidebar } from "./sidebar";
import { api } from "../../shared/api";
import { ChangesPanel, dedupeByPath } from "./changes-panel";
import type { SessionHeader } from "./session-header";
import { setThinkingActivity, setThinkingProgress, isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import { isBlocked, formatClockLabel, capitalize, getCachedAccount } from "../../shared/chat/rate-limit-banner";
import { completeHandoff } from "./handoff";

/** Mount the statusbar for the session pane. Returns null if the host slot
 * isn't in the DOM (shouldn't happen given the pane skeleton, but mirrors the
 * original guard). Sets `state.statusbar` itself so renderer wiring (which
 * runs right after) can read it off state, same as before extraction. */
export async function mountStatusbar(
  pane: HTMLElement,
  sess: Instance,
  onAccountClick: () => void,
): Promise<SessionStatusbar | null> {
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (!sbHost) return null;
  const rows = await loadStatuslineRows();
  const hideZero = await loadStatuslineHideZero();
  let effortDisplay = sess.effort ?? "";
  if (!effortDisplay && sess.kind === "external" && sess.cwd) {
    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      const last = readLastChoice(settings, String(sess.cwd));
      const normal = readPresets(settings).find((p) => p.name === "Normal");
      effortDisplay = last?.effort ?? normal?.effort ?? "";
    } catch { /* leave blank */ }
  }
  const sb = new SessionStatusbar(sbHost, sess.started_at, rows, {
    cwd: sess.cwd ? String(sess.cwd) : null,
    effort: effortDisplay,
    sessionId: sess.session_id,
    readOnly: sess.kind === "external",
    sessionModel: sess.model || null,
    hideZero,
    accountId: sess.account_id ?? null,
    onAccountClick,
  });
  state.statusbar = sb;
  // Git info is owned by the statusbar itself: it resolves the session's live
  // cwd (which may follow the AI into a worktree) via `session_live_cwd`, then
  // fetches against that. Fetching here too would race and clobber it with the
  // spawn-cwd branch.
  return sb;
}

/** Attach the ChatRenderer + all-changes panel, wire status/CTA callbacks,
 * load history, and reconcile against the live transcript. Owns the stall
 * guard (ai_todo 226: ring the loading overlay after 150ms, show a
 * "didn't respond" retry state after 8s if nothing settled - a wedged
 * backend used to leave the header floating over a blank pane forever with
 * no feedback). Returns `false` if a newer mount/selectSession superseded
 * this one mid-await (caller should stop and not proceed to mount the
 * composer), `true` otherwise. `onStalledRetry` is called if the user clicks
 * the stall banner's Retry button. */
export async function mountRenderer(
  pane: HTMLElement,
  sess: Instance,
  header: SessionHeader,
  sessionId: string,
  myMount: number,
  onStalledRetry: () => void,
): Promise<boolean> {
  if (state.renderer) state.renderer.detach();
  state.changesPanel?.unmount();
  state.changesPanel = null;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return true;

  let loadSettled = false;
  const ringTimer = window.setTimeout(() => {
    if (!loadSettled) showChatLoadingOverlay(messagesEl);
  }, 150);
  const stallTimer = window.setTimeout(() => {
    if (loadSettled || state.mountId !== myMount || state.selectedId !== sessionId) return;
    // ai_todo 228 diagnostics: this guard times a purely local chain
    // (in-memory settings read + local transcript file read) - it is NOT
    // waiting on the daemon pipe. If this fires, the stall is in that local
    // chain (or an unhandled exception before it), not a pipe EOF.
    console.error(`[sessions] chat load stalled >8s (local settings/history read), session=${sessionId}`);
    messagesEl.querySelector(".chat-loading-overlay")?.remove();
    messagesEl.innerHTML =
      `<div class="session-empty session-empty--stalled chat-load-stalled">` +
      `<i class="ph ph-warning"></i>` +
      `<div>This chat isn't loading - the backend didn't respond.</div>` +
      `<button type="button" class="chat-load-retry">Retry</button>` +
      `</div>`;
    messagesEl.querySelector<HTMLButtonElement>(".chat-load-retry")?.addEventListener("click", onStalledRetry);
  }, 8000);
  const settleLoad = () => {
    loadSettled = true;
    window.clearTimeout(ringTimer);
    window.clearTimeout(stallTimer);
    messagesEl.querySelector(".chat-loading-overlay")?.remove();
  };

  const renderer = new ChatRenderer(messagesEl);
  state.renderer = renderer;
  // Wire meta updates to statusbar (model, tokens, thinking, cost).
  const sbForRenderer = state.statusbar;
  if (sbForRenderer) {
    renderer.onMetaUpdate = (meta) => {
      if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
    };
    renderer.onToolTally = (t) => {
      if (state.statusbar === sbForRenderer) sbForRenderer.updateToolTally(t);
    };
    // Tool-chip popovers reuse the in-chat custom views (Read/File Changes/
    // Skills/Questions), built from this renderer's messages.
    sbForRenderer.setToolViewProvider((tool) => renderer.customToolView(tool));
    // Reopened chat: surface its already-accrued tool counts immediately.
    sbForRenderer.updateToolTally(renderer.toolTally);
  }
  // Mount the all-changes panel + wire renderer callbacks. Panel listens
  // for file mutations; activity feed routes to the thinking bar.
  const panel = new ChangesPanel();
  panel.mount(pane, messagesEl);
  state.changesPanel = panel;
  renderer.onFileEditsChanged = (edits) => {
    panel.onUpdate(edits);
    header.setChangesBadge(dedupeByPath(edits).length);
  };
  // Let the file viewer's Diff tab resolve this session's edits for any file.
  setFileEditsProvider(() => renderer.getFileEdits());
  // Let the PR-preview modal's git IPC calls (get_range_files/get_file_diff)
  // resolve this session's working directory.
  setPrReviewCwdProvider(() => (sess.cwd ? String(sess.cwd) : null));
  renderer.onActivityUpdate = (activity) => setThinkingActivity(activity);
  renderer.onProgressUpdate = (n, m) => setThinkingProgress(n, m);
  renderer.onNextAiPromptDone = () => {
    if (state.renderer !== renderer) return;
    renderer.injectCta("pickup");
  };
  renderer.onHandoffReady = () => {
    if (state.renderer !== renderer) return;
    if (state.selectedId !== sessionId) return;
    void completeHandoff(sessionId);
  };
  // NOTE: the sidebar/header question flag is NOT derived here anymore. The
  // renderer's marker detection only ever ran for the OPEN chat, so it went
  // stale the moment a session was backgrounded (a later turn's "done" never
  // cleared an old "question", and vice versa), and it fired on intermediate
  // markers mid-turn. The registry's `awaiting` (set by the daemon from the
  // result line, gen-guarded) is the single source of truth now - see
  // deriveQuestionSet in sessions-helpers.ts.
  header.onChangesClick = () => panel.toggle();
  // Expose the panel toggle through the state seam so view-more-menu and
  // sidebar-ctx-menu can offer "View changes" for the active session.
  state.activeChatActions = { viewChanges: () => panel.toggle() };
  await renderer.attach(sessionId);
  // Bail if a newer mount or selectSession superseded us during await.
  if (state.mountId !== myMount || state.selectedId !== sessionId) {
    settleLoad();
    renderer.detach();
    return false;
  }
  // Pull from the shared event store. Cache hit = instant render with no
  // IPC. Cache miss triggers load_history_page under the hood (last 20
  // messages). Either way the store keeps the live `chat:<id>` listener
  // attached so events accrue even when this session isn't selected.
  const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
  try {
    await renderer.loadFromStore(sess.cwd ? String(sess.cwd) : undefined);
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      settleLoad();
      renderer.detach();
      return false;
    }
  } catch {
    /* tolerate absence */
  } finally {
    // Also clears the stall watchdog + 150ms ring timer.
    settleLoad();
    overlay?.remove();
  }
  // Self-heal against the lossy daemon->app notifier: a turn that completed
  // while this session was backgrounded may be missing from the cache even
  // though the sidebar marked it "done". Re-read the transcript tail and paint
  // anything the live channel dropped. Fire-and-forget so reopen stays instant;
  // recovered events arrive via the live subscriber path.
  void sessionEvents.reconcileLatest(sessionId, sess.cwd ? String(sess.cwd) : undefined);
  // Sync sidebar once after replay (no per-event re-renders fired during it).
  const rootEl = document.querySelector<HTMLElement>(".view-sessions");
  const listAfterLoad = rootEl?.querySelector<HTMLElement>("#sessions-list");
  if (listAfterLoad) renderSidebar(listAfterLoad);
  return true;
}

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

  // The real send-to-daemon path. Shared by the composer (normal send) and
  // by the held-messages controller (flushing a bundled set as one message).
  const sendBundle = async (blocks: ContentBlock[]): Promise<void> => {
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
        await state.renderer.loadFromStore(cwd);
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
