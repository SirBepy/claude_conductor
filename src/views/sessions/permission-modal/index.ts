/**
 * Permission + question relay UI for the chat hub.
 *
 * Listens for `permission-requested` and `question-requested` Tauri events
 * (emitted by the hooks server when the MCP permission-prompt tool fires
 * during a `claude -p` turn). Renders a floating card anchored just above
 * the active session's composer.
 *
 * Special case: when the permission request is for an AskUserQuestion-style
 * tool (built-in `AskUserQuestion` or our MCP `ask_user_question`), the input
 * itself contains the questions. We render the question UI directly inside
 * the permission card, allow the tool on submit, AND cache the chosen answers
 * keyed by session_id so the follow-up `question-requested` event (for our
 * MCP tool) auto-resolves without prompting the user twice.
 *
 * Install once at app startup via `installPermissionModalListener()`.
 */

import { invoke } from "../../../shared/ipc";
import { getTransport } from "../../../shared/transport";
import { state } from "../state";
import { findPendingPromptsForSession, reconcilePendingPrompts } from "./remote-prompt-poll";
import { dismissQuestionCard, extractQuestions, formatAnswersAsMessage, isQuestionAnswered, renderQuestionUI, snapshotActiveCardDraft } from "./question-ui";
import { showPermissionCard } from "./permission-card";
import { AUQ_ANSWER_SENTINEL } from "../../../shared/chat/chat-transforms";
import type { ContentBlock } from "../../../types/ipc.generated";
import { clearQuestionDraft, loadQuestionDraft, saveQuestionDraft } from "./draft-persistence";
import {
  allowPermission,
  autoAllowIfRemembered,
  hydrateAutoAccept,
  isAutoAccept,
  isForSelectedSession,
  gateDiag,
  resolveCwdForSession,
  storePendingPrompt,
  takePendingPrompt,
  peekPendingPrompt,
  clearPendingPromptById,
} from "./gating";
import type { PendingPrompt } from "./gating";
import type { PermissionRequestedPayload, Question, QuestionDraft, QuestionRequestedPayload } from "./types";

export {
  isAutoAccept,
  setAutoAccept,
  setSelectedSessionId,
  getSelectedSessionId,
  clearPendingPrompt,
  pendingPromptSessionIds,
} from "./gating";
export { dismissQuestionCard } from "./question-ui";

// Sidebar re-render is injected rather than statically imported: a direct
// `import { renderSidebar } from "../sidebar"` would close a module cycle
// (sidebar -> state -> permission-modal -> sidebar) and pull sidebar.ts's
// top-level document listeners into this module's graph, breaking node-env
// unit tests. main.ts wires the hook at startup.
let _rerenderSidebar: (() => void) | null = null;

export function setSidebarRerenderHook(fn: () => void): void {
  _rerenderSidebar = fn;
}

/** Re-render the sessions sidebar so a newly-parked prompt's attention marker
 *  appears (or clears) on the row. No-op until the hook is wired. */
function rerenderSidebar(): void {
  _rerenderSidebar?.();
}

/** Mirror per-question answered/unanswered progress into the chat transcript's
 *  question card while the floating card is still being answered. `state` is
 *  imported directly (not injected like the sidebar hook above) because
 *  gating.ts already imports it - that cycle is pre-existing and safe, since
 *  neither side reads the other at module-evaluation time, only inside
 *  functions called later. No-op for a prompt with no session (the headless
 *  permission-card path has no chat transcript to sync into) or when the
 *  prompt's session isn't the one currently on screen. */
function syncQuestionProgress(sessionId: string | undefined, promptId: string, questions: Question[], draft: QuestionDraft): void {
  if (!sessionId || state.selectedId !== sessionId) return;
  const liveAnswered = questions.map((q, i) =>
    isQuestionAnswered(q, draft.freeText.get(i) ?? "", draft.selections.get(i))
  );
  state.renderer?.updateQuestionProgress(promptId, liveAnswered);
}

function showQuestionCard(payload: QuestionRequestedPayload, restoredDraft?: QuestionDraft): void {
  // Park the prompt while it's on screen so switching chats and back re-surfaces
  // it (the reliable poll only emits each id once, so a card torn down by
  // navigation is otherwise lost while the daemon turn hangs). Cleared when the
  // prompt resolves (see the `prompt-resolved` listener).
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "question", payload });
  }
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions];

  // Snapshot draft from the old card if it belongs to this session (covers the
  // case where the user switched away and back without another session getting
  // an AUQ in between). Falls back to the persisted draft - the in-memory
  // snapshot is gone after a full app restart, but localStorage isn't.
  const initialDraft = restoredDraft
    ?? (payload.session_id ? snapshotActiveCardDraft(payload.session_id) : undefined)
    ?? loadQuestionDraft(payload.id)
    ?? undefined;

  renderQuestionUI({
    id: payload.id,
    sessionId: payload.session_id,
    questions,
    initialDraft,
    cwd: resolveCwdForSession(payload.session_id),
    titleIcon: "ph-chat-circle-dots",
    titleText: "Claude is asking",
    submitLabel: "Submit",
    submitIcon: "ph-paper-plane-right",
    cancelLabel: "Skip",
    // Only this flow can deliver an extra message / pasted images to Claude
    // (see QuestionUIOpts.supportsExtras doc) - the built-in-tool flow in
    // permission-card.ts settles via a plain deny.message string instead.
    supportsExtras: true,
    onDraftChange: (draft) => {
      saveQuestionDraft(payload.id, draft);
      syncQuestionProgress(payload.session_id, payload.id, questions, draft);
    },
    onSubmit: async (answers, extras) => {
      clearQuestionDraft(payload.id);
      const sid = payload.session_id;
      // Settle the daemon card FIRST: drop the durable fire-and-forget prompt
      // record + clear "Input Needed". There's no blocking hook to resolve
      // anymore (the asking turn already ended), so `respond_question` is pure
      // teardown here - the answer itself travels separately, as a normal
      // message below (settle_prompt tolerates the missing waiter).
      try {
        await invoke("respond_question", { id: payload.id, answers });
      } catch (e) {
        console.warn("respond_question (settle) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
      if (!sid) return;
      // bundleHeld/extractAuqAnswerText key off the AUQ_ANSWER_SENTINEL block
      // staying its own standalone content block (cca356d8) - never merge it
      // with extras into one block, or the card fails to fold.
      const answerText = formatAnswersAsMessage(questions, answers);
      const answerBlock: ContentBlock = { type: "text", text: `${AUQ_ANSWER_SENTINEL}${answerText}` };
      const extraBlocks: ContentBlock[] = [];
      if (extras.additionalMessage) extraBlocks.push({ type: "text", text: extras.additionalMessage });
      for (const a of extras.attachments) {
        if (a.path) extraBlocks.push({ type: "text", text: `<file:${a.path}::${a.filename}>` });
      }
      if (state.selectedId === sid && state.heldMessages) {
        // Stage the extras FIRST so flushHeldWithDraft's single bundleHeld call
        // folds them alongside the isolated sentinel block into one bundle,
        // instead of a second message queued behind it.
        if (extraBlocks.length) state.heldMessages.stage(extraBlocks);
        await state.heldMessages.flushHeldWithDraft([answerBlock]);
      } else {
        const cwd = resolveCwdForSession(sid) ?? ".";
        await invoke("send_message", { sessionId: sid, cwd, blocks: [answerBlock, ...extraBlocks] });
      }
    },
    onCancel: async () => {
      // Fire-and-forget skip: the asking turn already ended, so there is nothing
      // to interrupt. Just settle the card (drop the durable prompt + clear
      // "Input Needed"). No message is sent - skip means "no answer, move on",
      // and with no blocking waiter the model never even sees a skip signal.
      clearQuestionDraft(payload.id);
      try {
        await invoke("respond_question", { id: payload.id, answers: {} });
      } catch (e) {
        console.warn("respond_question (skip settle) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
    },
  });
}

/** A permission tool fired. Allow (auto-accept / remembered rule), park (a
 *  backgrounded chat), or surface the card (the focused chat). */
function handlePermissionRequested(payload: PermissionRequestedPayload): void {
  console.info("[perm-relay] frontend received permission-requested", { tool: payload.tool_name, session: payload.session_id, ...gateDiag() });
  if (!isForSelectedSession(payload.session_id)) {
    if (payload.session_id) {
      // Auto-accept is on for this backgrounded chat: allow NOW rather than
      // parking, so no "needs attention" dot appears for a prompt that will
      // never need the user. (Questions still park - never auto-answered.)
      if (isAutoAccept(payload.session_id) && extractQuestions(payload.input) === null) {
        console.debug("[auto-accept] background allow", payload.tool_name, "for", payload.session_id);
        allowPermission(payload, "background respond_permission");
        return;
      }
      // Switched-away chat: try a saved Always-Allow rule FIRST so a chat the
      // user already granted access to doesn't park a red prompt off-screen.
      // autoAllowIfRemembered returns false for question-shaped / destructive /
      // unmatched, which then falls through to parking. Replayed on selectSession.
      const sid = payload.session_id;
      void (async () => {
        if (await autoAllowIfRemembered(payload)) {
          console.debug("[perm-rules] background auto-allow", payload.tool_name, "for", sid);
          return;
        }
        storePendingPrompt(sid, { kind: "permission", payload });
        rerenderSidebar();
        console.warn("[perm-gate] PARKED permission-requested for backgrounded chat", { eventSessionId: sid, tool: payload.tool_name, ...gateDiag() });
      })();
    } else {
      console.warn("[perm-gate] DROPPED permission-requested (no session_id)", { tool: payload.tool_name, ...gateDiag() });
    }
    return;
  }

  if (
    payload.session_id
    && isAutoAccept(payload.session_id)
    && extractQuestions(payload.input) === null
  ) {
    console.debug("[auto-accept] allowing", payload.tool_name, "for", payload.session_id);
    allowPermission(payload, "respond_permission");
    return;
  }

  void (async () => {
    if (await autoAllowIfRemembered(payload)) return;
    showPermissionCard(payload);
  })();
}

/** An AskUserQuestion fired. Park it (backgrounded chat) or show the card (the
 *  focused chat). Never auto-answered. Exported (alongside dismissQuestionCard
 *  below) so view-harness e2e specs can drive the real gate + card mount
 *  without a full Tauri event round-trip. */
export function handleQuestionRequested(payload: QuestionRequestedPayload): void {
  console.info("[perm-relay] frontend received question-requested", { session: payload.session_id, ...gateDiag() });
  if (!isForSelectedSession(payload.session_id)) {
    if (payload.session_id) {
      storePendingPrompt(payload.session_id, { kind: "question", payload });
      rerenderSidebar();
      console.warn("[perm-gate] PARKED question-requested for backgrounded chat", { eventSessionId: payload.session_id, ...gateDiag() });
    } else {
      console.warn("[perm-gate] DROPPED question-requested (no session_id)", { ...gateDiag() });
    }
    return;
  }
  showQuestionCard(payload);
}

/** A prompt closed on the daemon (answered elsewhere or timed out). Clear its
 *  park so it doesn't re-surface on session switch, but leave the card on
 *  screen - the user dismisses it explicitly. */
function handlePromptResolved(id: string): void {
  clearPendingPromptById(id);
  // No-op if this id never had a draft (permission-shaped prompt, or a
  // question already answered/skipped through the normal submit/cancel path).
  clearQuestionDraft(id);
  rerenderSidebar();
}

/**
 * Phone (browser PWA) substitute for the desktop's Tauri-event delivery. The
 * desktop's reliable poll lives in Rust (daemon_link.rs); the phone has no
 * Tauri event bus, so it polls `list_pending_prompts` over the remote RPC and
 * demuxes each prompt into the same handlers. Without this, AskUserQuestion +
 * permission prompts raised during a phone-driven turn never surfaced.
 */
function startRemotePromptPoll(): void {
  const emitted = new Set<string>();
  const cb = {
    onQuestion: handleQuestionRequested,
    onPermission: handlePermissionRequested,
    onResolved: handlePromptResolved,
  };
  const tick = async (): Promise<void> => {
    let prompts: unknown;
    try {
      prompts = await getTransport().call("list_pending_prompts");
    } catch {
      return; // network blip - keep `emitted` and retry next tick
    }
    reconcilePendingPrompts(prompts, emitted, cb);
  };
  void tick();
  setInterval(() => void tick(), 700);
}

let installed = false;

export function installPermissionModalListener(): void {
  if (installed) return;
  installed = true;

  // Seed the auto-accept set from the persisted store so the toggle survives a
  // restart. Done before the transport split below so the phone (which has no
  // Tauri event bus) still hydrates its gate.
  void hydrateAutoAccept();

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) {
    // Phone / browser PWA: no Tauri events. Poll the daemon's pending-prompt
    // store over RPC so AUQs + permission prompts surface here too.
    startRemotePromptPoll();
    return;
  }

  ev.listen<PermissionRequestedPayload>("permission-requested", (event) => handlePermissionRequested(event.payload));
  ev.listen<QuestionRequestedPayload>("question-requested", (event) => handleQuestionRequested(event.payload));
  // The reliable pending-prompt poll (daemon_link.rs) emits this, so it survives
  // the lossy broadcast.
  ev.listen<{ id: string }>("prompt-resolved", (event) => {
    const id = event.payload?.id;
    if (id) handlePromptResolved(id);
  });
}

/**
 * Drain a parked permission prompt for a session that just had auto-accept
 * toggled ON: allow it immediately and clear the sidebar attention dot. A
 * parked question (never auto-answered) is left in place. No-op if nothing is
 * parked. Called from the auto-accept toggle so flipping it on retroactively
 * clears an already-waiting prompt instead of leaving the dot until switch-back.
 */
export function autoAcceptParked(sessionId: string): void {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return;
  if (pending.kind === "permission" && extractQuestions(pending.payload.input) === null) {
    allowPermission(pending.payload, "flush respond_permission");
    rerenderSidebar();
    return;
  }
  // Can't auto-answer (question / AskUserQuestion-shaped): leave it parked.
  storePendingPrompt(sessionId, pending);
}

/**
 * Replay a parked permission/question prompt for a session the user just
 * selected. Mirrors the arrival path (auto-accept, remembered-rule auto-allow,
 * then the card) so a switch-back surfaces exactly what would have shown had
 * the chat been focused when the tool fired. False if nothing is parked, so the
 * caller can fall back to {@link rehydratePendingPrompts}.
 *
 * Called from selectSession AFTER the pane is mounted so the card anchors over
 * the right composer.
 */
export function replayPendingPrompt(sessionId: string): boolean {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return false;
  rerenderSidebar(); // clear the attention marker now that we're surfacing it
  surfacePending(pending);
  return true;
}

/** Shared tail of replay/reopen: render the parked prompt's card, applying the
 *  arrival path's auto-accept / remembered-rule shortcuts. */
function surfacePending(pending: PendingPrompt): void {
  if (pending.kind === "question") {
    showQuestionCard(pending.payload, pending.draft);
    return;
  }
  const payload = pending.payload;
  if (
    payload.session_id
    && isAutoAccept(payload.session_id)
    && extractQuestions(payload.input) === null
  ) {
    allowPermission(payload, "replay respond_permission");
    return;
  }
  void (async () => {
    if (await autoAllowIfRemembered(payload)) return;
    showPermissionCard(payload);
  })();
}

/** Ask the DAEMON what it is still waiting on for `sessionId` and re-park it.
 *  The push path sends each id once, so a park lost with its webview is never
 *  re-sent - pull instead. No-op if already parked (may hold a live draft). */
export async function rehydratePendingPrompts(sessionId: string): Promise<boolean> {
  if (!sessionId || peekPendingPrompt(sessionId)) return false;
  let prompts: unknown;
  try {
    prompts = await getTransport().call("list_pending_prompts");
  } catch (e) {
    console.warn("[perm-gate] rehydrate failed:", e);
    return false;
  }
  // One park per session, so take the longest-waiting if the daemon holds two.
  const [rec] = findPendingPromptsForSession(prompts, sessionId);
  if (!rec) return false;
  storePendingPrompt(sessionId, rec.kind === "question"
    ? { kind: "question", payload: rec.payload }
    : { kind: "permission", payload: rec.payload });
  rerenderSidebar();
  return true;
}

/** Put the real card back up for a transcript card the user clicked: local park
 *  first, then the daemon's store. False when nothing is open for this chat, so
 *  the caller can say so - silently doing nothing is the whole complaint. */
export async function reopenPendingPrompt(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  let pending = takePendingPrompt(sessionId);
  if (!pending) {
    await rehydratePendingPrompts(sessionId);
    pending = takePendingPrompt(sessionId);
  }
  if (!pending) return false;
  // Only safe to drop what's on screen now we hold a replacement.
  dismissQuestionCard();
  rerenderSidebar();
  surfacePending(pending);
  return true;
}
