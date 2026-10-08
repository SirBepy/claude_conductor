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

import { getTransport } from "../../../shared/transport";
import { visibleInterval } from "../../../shared/visible-interval";
import { reconcilePendingPrompts } from "./remote-prompt-poll";
import { confirmQuestionRendered, dismissQuestionCard, extractQuestions } from "./question-ui";
import { getActiveCardId, isActiveCardId } from "./question-state";
import { showPermissionCard } from "./permission-card";
import { clearQuestionDraft } from "./draft-persistence";
import { cancelAuqPush } from "./auq-draft-sync";
import {
  allowPermission,
  autoAllowIfRemembered,
  hydrateAutoAccept,
  isAutoAccept,
  isForSelectedSession,
  markLatestQuestion,
  gateDiag,
  storePendingPrompt,
  clearPendingPromptById,
  peekPendingPrompt,
  pendingPromptSessionIds,
} from "./gating";
import type { PermissionRequestedPayload, QuestionRequestedPayload } from "./types";
import { showQuestionCard } from "./question-submit";
export type { ShowQuestionCardOpts } from "./question-submit";

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
export { showQuestionCard };

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

// ── Sibling question queue (todo 897) ───────────────────────────────────────
//
// gating.ts's `_pendingPrompts` holds exactly one entry per session, whether
// shown or parked. The daemon (1d4e1815) now keeps a session's `awaiting`
// set to "question" until every open sibling resolves, so a second still-open
// question for the SAME session must never overwrite that one slot - doing so
// drops the older prompt from all local tracking while the daemon still holds
// it open, which is exactly "input needed" with nothing on screen to answer.
// Queued here instead; drained into the slot once the front prompt resolves
// (promoteQueuedSibling) or picked directly by id when its own transcript
// card is clicked (resurface.ts's reopenPendingPrompt).

const _queuedSiblingQuestions = new Map<string, QuestionRequestedPayload[]>();

/** Queue a still-open sibling behind whichever prompt already owns this
 *  session's slot, instead of clobbering it. No-op if already queued.
 *  Exported for resurface.ts's rehydration/reopen paths, which hit the same
 *  one-slot limit against the daemon's own `list_pending_prompts`. */
export function queueSiblingQuestion(sessionId: string, payload: QuestionRequestedPayload): void {
  const q = _queuedSiblingQuestions.get(sessionId) ?? [];
  if (q.some((p) => p.id === payload.id)) return;
  q.push(payload);
  _queuedSiblingQuestions.set(sessionId, q);
}

/** Remove and return the queued sibling carrying `id`, if any - lets a
 *  clicked transcript card surface directly instead of falling through to
 *  the "newest open question" fallback, which would wrongly mark a genuine
 *  sibling as superseded (todo 860). */
export function takeQueuedSiblingQuestionById(sessionId: string, id: string): QuestionRequestedPayload | null {
  const q = _queuedSiblingQuestions.get(sessionId);
  if (!q) return null;
  const i = q.findIndex((p) => p.id === id);
  if (i === -1) return null;
  const [payload] = q.splice(i, 1);
  if (q.length === 0) _queuedSiblingQuestions.delete(sessionId);
  return payload ?? null;
}

/** Promote the oldest queued sibling once the session's front prompt
 *  resolves, by re-running the normal arrival gate - the slot is already
 *  empty by the time handlePromptResolved calls this, so it parks or shows
 *  exactly as a fresh event would. */
function promoteQueuedSibling(sessionId: string): void {
  const q = _queuedSiblingQuestions.get(sessionId);
  if (!q?.length) return;
  const next = q.shift();
  if (q.length === 0) _queuedSiblingQuestions.delete(sessionId);
  if (next) handleQuestionRequested(next);
}

/** Which session (if any) currently owns the pending-prompt slot holding
 *  `id` - captured before clearPendingPromptById removes it, so the right
 *  sibling queue can be drained. */
function findSessionForPendingId(id: string): string | null {
  for (const sid of pendingPromptSessionIds()) {
    if (peekPendingPrompt(sid)?.payload.id === id) return sid;
  }
  return null;
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
  const sid = payload.session_id;
  if (sid) {
    const existing = peekPendingPrompt(sid);
    // A different question already owns this session's one slot - queue this
    // one instead of overwriting it (see the sibling-queue block above), UNLESS
    // that slot is merely a STALE answered entry (todo 971): onSubmit marks a
    // slot `answered` the instant the user settles it, well before the
    // daemon's `prompt-resolved` poll clears it, so a slot's presence alone
    // can't tell "still genuinely open" from "answered, poll hasn't caught up
    // yet" - tests/auq-second-card-answer-delivery.test.mjs (todo 773) depends
    // on the latter case rendering q2 immediately, on a FOCUSED session, with
    // no poll ever simulated. Session-agnostic on purpose: a live parallel
    // tool_use pair on a focused session is the same clobber shape 897 fixed
    // for the backgrounded/parked case, just reachable with the chat on screen
    // instead of AFK (todo 971).
    if (existing?.kind === "question" && existing.payload.id !== payload.id && !existing.answered) {
      queueSiblingQuestion(sid, payload);
      // Not shown/parked yet, but genuinely delivered here (queued) - the
      // daemon's on_question_request wait must not time out over this.
      confirmQuestionRendered(payload.id, payload.session_id);
      rerenderSidebar();
      console.warn("[perm-gate] QUEUED sibling question-requested behind an open slot", { eventSessionId: sid, ...gateDiag() });
      return;
    }
  }
  if (!isForSelectedSession(sid)) {
    if (sid) {
      storePendingPrompt(sid, { kind: "question", payload });
      // A parked prompt is a genuine delivery, just like the shown-card branch
      // in question-ui.ts - the backgrounded chat WILL see it via its sidebar
      // marker, so on_question_request must not time out and report false.
      confirmQuestionRendered(payload.id, payload.session_id);
      rerenderSidebar();
      console.warn("[perm-gate] PARKED question-requested for backgrounded chat", { eventSessionId: sid, ...gateDiag() });
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
  const sid = findSessionForPendingId(id);
  clearPendingPromptById(id);
  const isActive = isActiveCardId(id);
  if (durable || !isActive) clearQuestionDraft(id);
  // Only cancel the (module-global) push for the card actually on screen.
  if (isActive && durable) cancelAuqPush();
  if (durable) dismissQuestionCard(id);
  // A genuine resolve (or a background id that was never on screen) frees the
  // session's slot for its next queued sibling, if any (todo 897).
  if (sid && (durable || !isActive)) promoteQueuedSibling(sid);
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
  // KEEP-RUNNING (todo 1008): AskUserQuestion + permission prompts raised
  // during a phone-driven turn must reach the user while they look
  // elsewhere - that's the whole point of this poll.
  visibleInterval(() => void tick(), 700, {
    whileHidden: true,
    reason: "AskUserQuestion + permission prompts raised during a phone-driven turn must reach the user while they look elsewhere",
  });
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
