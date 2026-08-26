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
import { reconcilePendingPrompts } from "./remote-prompt-poll";
import { dismissQuestionCard, extractQuestions, formatAnswersAsMessage, isQuestionAnswered, renderQuestionUI, snapshotActiveCardDraft } from "./question-ui";
import { getActiveCardId, isActiveCardId } from "./question-state";
import { showPermissionCard } from "./permission-card";
import { AUQ_ANSWER_SENTINEL, AUQ_EXTRA_SENTINEL } from "../../../shared/chat/chat-transforms";
import type { ContentBlock } from "../../../types/ipc.generated";
import { clearQuestionDraft, saveQuestionDraft } from "./draft-persistence";
import { scheduleAuqPush, clearAuqPush, cancelAuqPush, fetchFreshestAuqDraft } from "./auq-draft-sync";
import {
  allowPermission,
  autoAllowIfRemembered,
  hydrateAutoAccept,
  isAutoAccept,
  isForSelectedSession,
  isLatestQuestion,
  markLatestQuestion,
  gateDiag,
  resolveCwdForSession,
  storePendingPrompt,
  clearPendingPromptById,
  peekPendingPrompt,
  pendingPromptSessionIds,
} from "./gating";
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
export { autoAcceptParked, replayPendingPrompt, rehydratePendingPrompts, reopenPendingPrompt } from "./resurface";

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
 *  appears (or clears) on the row. No-op until the hook is wired. Exported for
 *  resurface.ts (split out of this file, ai_todo 517). */
export function rerenderSidebar(): void {
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

// Exported for resurface.ts (split out of this file, ai_todo 517).
export async function showQuestionCard(payload: QuestionRequestedPayload, restoredDraft?: QuestionDraft): Promise<void> {
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

  // Priority: in-memory snapshot (switch-away/back, always freshest), then
  // whichever of daemon/localStorage is NEWER by timestamp (fetchFreshestAuqDraft).
  const initialDraft = restoredDraft
    ?? (payload.session_id ? snapshotActiveCardDraft(payload.session_id, payload.id) : undefined)
    ?? (await fetchFreshestAuqDraft(payload.session_id, payload.id))
    ?? undefined;

  renderQuestionUI({
    id: payload.id,
    sessionId: payload.session_id,
    questions,
    initialDraft,
    cwd: resolveCwdForSession(payload.session_id),
    titleIcon: "ph-chat-circle-dots",
    submitLabel: "Submit",
    submitIcon: "ph-paper-plane-right",
    cancelLabel: "Skip",
    // Only this flow can deliver an extra message / pasted images to Claude
    // (see QuestionUIOpts.supportsExtras doc) - the built-in-tool flow in
    // permission-card.ts settles via a plain deny.message string instead.
    supportsExtras: true,
    // Lives on the PROMPT PAYLOAD (question.rs), never the model's tool_use
    // input - the one place this is actually readable.
    degradedBuiltin: payload.degraded_builtin === true,
    onDraftChange: (draft) => {
      saveQuestionDraft(payload.id, draft);
      scheduleAuqPush(payload.session_id, payload.id, draft);
      syncQuestionProgress(payload.session_id, payload.id, questions, draft);
    },
    onSubmit: async (answers, extras) => {
      clearQuestionDraft(payload.id);
      void clearAuqPush(payload.session_id, payload.id);
      const sid = payload.session_id;
      // Settle the daemon card + learn whether a live oneshot was resolved:
      // delivered=true means the answer already reached the model in-band, as
      // the MCP tool's own result (our only live AUQ path) - see answerBlocks
      // below, which used to send it again unconditionally and race that.
      let delivered = false;
      try {
        delivered = await invoke<boolean>("respond_question", { id: payload.id, answers, skipped: false });
      } catch (e) {
        console.warn("respond_question (settle) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
      if (!sid) return;
      if (!isLatestQuestion(sid, payload.id)) {
        // A newer question superseded this card while it sat unanswered - the
        // conversation already moved on, so don't inject a reply into it now.
        console.warn("[perm-relay] dropping stale question answer", payload.id, "for", sid);
        return;
      }
      // bundleHeld/extractAuqAnswerText key off the AUQ_ANSWER_SENTINEL block
      // staying standalone (cca356d8). Only included when NOT delivered
      // in-band - extras still travel either way, since the tool_result only
      // ever carries the structured answers, never free-form extra text/files.
      const answerBlocks: ContentBlock[] = delivered
        ? []
        : [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}${formatAnswersAsMessage(questions, answers)}` }];
      // Tagged AUQ_EXTRA_SENTINEL so this folds into the SAME card (see
      // chat-question-card.ts's resolvePendingQuestionExtra), not a detached bubble.
      const cardExtraBlocks: ContentBlock[] = [];
      if (extras.additionalMessage) cardExtraBlocks.push({ type: "text", text: `${AUQ_EXTRA_SENTINEL}${extras.additionalMessage}` });
      for (const a of extras.attachments) {
        if (a.path) cardExtraBlocks.push({ type: "text", text: `<file:${a.path}::${a.filename}>` });
      }
      if (state.selectedId === sid && state.heldMessages) {
        // Unrelated to the card - staged as its own item so it joins any
        // already-queued prose, never merged with the card's own extras.
        const attach = state.heldMessages.getAttached();
        if (attach && !attach.isDraftEmpty()) {
          state.heldMessages.stage(attach.getDraftBlocks());
          attach.clearComposer();
        }
        // Its own held item so bundleHeld's sentinel-group check (held-messages.ts)
        // keeps the note+attachments intact, not merged into the queued prose.
        if (cardExtraBlocks.length) state.heldMessages.stage(cardExtraBlocks);
        await state.heldMessages.flushHeldWithDraft(answerBlocks);
      } else if (answerBlocks.length || cardExtraBlocks.length) {
        const cwd = resolveCwdForSession(sid) ?? ".";
        await invoke("send_message", { sessionId: sid, cwd, blocks: [...answerBlocks, ...cardExtraBlocks] });
      }
    },
    onCancel: async () => {
      // Fire-and-forget skip: the asking turn already ended, so there is nothing
      // to interrupt. Just settle the card (drop the durable prompt + clear
      // "Input Needed"). No message is sent - skip means "no answer, move on",
      // and with no blocking waiter the model never even sees a skip signal.
      clearQuestionDraft(payload.id);
      void clearAuqPush(payload.session_id, payload.id);
      try {
        await invoke("respond_question", { id: payload.id, answers: {}, skipped: true });
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
  // Track staleness (see gating.ts) before the park/show branch below, so a
  // superseded card's late answer can be told apart from a live one.
  markLatestQuestion(payload.session_id, payload.id, payload.seq);
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
  void showQuestionCard(payload);
}

/** A durable resolve is always genuine; a non-durable one for the id ON
 *  SCREEN can be a `claude -p` EOF poll-tick race mid-edit, so it's left alone. */
export function handlePromptResolved(id: string, durable = false): void {
  clearPendingPromptById(id);
  const isActive = isActiveCardId(id);
  if (durable || !isActive) clearQuestionDraft(id);
  // Only cancel the (module-global) push for the card actually on screen.
  if (isActive && durable) cancelAuqPush();
  if (durable) dismissQuestionCard(id);
  rerenderSidebar();
}

/** On regaining visibility/focus, reconcile against the daemon's CURRENT
 *  pending set - a diff-based poll only detects a removal it was awake for. */
let reconcileInFlight = false;
async function reconcileKnownPromptsOnRegainedVisibility(): Promise<void> {
  if (reconcileInFlight) return;
  const known = new Set<string>();
  const activeId = getActiveCardId();
  if (activeId) known.add(activeId);
  for (const sid of pendingPromptSessionIds()) {
    const id = peekPendingPrompt(sid)?.payload.id;
    if (id) known.add(id);
  }
  if (known.size === 0) return;
  reconcileInFlight = true;
  try {
    let prompts: unknown;
    try {
      prompts = await getTransport().call("list_pending_prompts");
    } catch {
      return; // network blip - don't wrongly resolve everything
    }
    const present = new Set<string>();
    if (Array.isArray(prompts)) {
      for (const p of prompts as Array<{ id?: unknown }>) {
        if (typeof p?.id === "string") present.add(p.id);
      }
    }
    for (const id of known) {
      if (!present.has(id)) handlePromptResolved(id, true);
    }
  } finally {
    reconcileInFlight = false;
  }
}

/**
 * Phone (browser PWA) substitute for the desktop's Tauri-event delivery. The
 * desktop's reliable poll lives in Rust (daemon_link.rs); the phone has no
 * Tauri event bus, so it polls `list_pending_prompts` over the remote RPC and
 * demuxes each prompt into the same handlers. Without this, AskUserQuestion +
 * permission prompts raised during a phone-driven turn never surfaced.
 */
function startRemotePromptPoll(): void {
  const emitted = new Map<string, boolean>();
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

  // Registered on both transports below - catches a stale card the same way
  // on desktop, phone, and a detached window (own module realm, own listener).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reconcileKnownPromptsOnRegainedVisibility();
  });
  window.addEventListener("focus", () => void reconcileKnownPromptsOnRegainedVisibility());

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
  ev.listen<{ id: string; durable?: boolean }>("prompt-resolved", (event) => {
    const id = event.payload?.id;
    if (id) handlePromptResolved(id, event.payload?.durable === true);
  });
}
