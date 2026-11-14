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
import { isAndroidShell } from "../../../shared/mobile/android-shell";
import { reconcilePendingPrompts } from "./remote-prompt-poll";
import { confirmQuestionRendered, dismissQuestionCard, extractQuestions } from "./question-ui";
import { expandActiveCard, getActiveCardAsker, getActiveCardId, isActiveCardId, refreshActiveCardAskers } from "./question-state";
import { state } from "../state";
import { showPermissionCard } from "./permission-card";
import { showSecretCard, dismissSecretCard } from "./secret-card";
import { clearQuestionDraft } from "./draft-persistence";
import { cancelAuqPush } from "./auq-draft-sync";
import {
  allowPermission,
  autoAllowIfRemembered,
  deferPendingPrompt,
  displayIdOf,
  needsHumanApproval,
  hydrateAutoAccept,
  hydrateSubchatsOn,
  onSubchatsChange,
  isAutoAccept,
  isForSelectedSession,
  isQuietPrompt,
  markLatestQuestion,
  gateDiag,
  storePendingPrompt,
  clearPendingPromptById,
  peekPendingPrompt,
  pendingPromptAskerIds,
  selectionGuard,
} from "./gating";
import type { PermissionRequestedPayload, QuestionRequestedPayload, SecretRequestedPayload } from "./types";
import { showQuestionCard } from "./question-submit";
import { createPromptQueue } from "./prompt-queue";
import { dropIfAlreadyAnswered } from "./answered-gate";
export type { ShowQuestionCardOpts } from "./question-submit";

export {
  isAutoAccept,
  setAutoAccept,
  isSubchatsOn,
  setSubchatsOn,
  adoptSubchatsOn,
  setSelectedSessionId,
  getSelectedSessionId,
  clearPendingPrompt,
  pendingPromptSessionIds,
  parkedDisplayIds,
} from "./gating";
export { dismissQuestionCard } from "./question-ui";
export { autoAcceptParked, replayPendingPrompt, rehydratePendingPrompts, rehydrateAndReplay, reopenPendingPrompt, surfaceNextForDisplay, surfaceParkedPrompt } from "./resurface";
import { surfaceNextForDisplay } from "./resurface";
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
// (handlePromptResolved promotes it) or picked directly by id when its own transcript
// card is clicked (resurface.ts's reopenPendingPrompt).

// Promotion re-runs the normal arrival gate - the slot is already empty by
// the time handlePromptResolved promotes, so the sibling parks or shows
// exactly as a fresh event would.
// A quiet card (the restart-lost stall card) waits behind every other queued card of its
// chat, whatever arrived first: Joe is only interrupted for something wrong.
const _queuedSiblingQuestions = createPromptQueue<QuestionRequestedPayload>((p) => handleQuestionRequested(p), {
  yields: (p) => p.quiet === true,
});

/** A quiet card owns the slot and a real card just arrived for the same chat: the
 *  quiet one steps back into the queue (taking its card off screen if it was up),
 *  so the real one is shown or parked as a fresh arrival. Without this the real
 *  card sat behind the quiet one until Joe dismissed it. */
function yieldQuietSlot(sid: string, incoming: QuestionRequestedPayload): void {
  const existing = peekPendingPrompt(sid);
  if (!existing || existing.kind !== "question" || existing.answered) return;
  if (!isQuietPrompt(existing) || incoming.quiet === true || existing.payload.id === incoming.id) return;
  if (isActiveCardId(existing.payload.id)) dismissQuestionCard(existing.payload.id);
  clearPendingPromptById(existing.payload.id);
  _queuedSiblingQuestions.push(sid, existing.payload);
}

/** What is queued behind `askerId`'s slot, for the asker picker's counts. Read at
 *  call time by askers.ts: that module sits in this file's import cycle, so a
 *  registration call made while this module evaluates would reach it too early. */
export function queuedQuestionsFor(askerId: string): readonly QuestionRequestedPayload[] {
  return _queuedSiblingQuestions.all(askerId);
}

/** Queue a still-open sibling behind whichever prompt already owns this
 *  session's slot, instead of clobbering it. No-op if already queued.
 *  Exported for resurface.ts's rehydration/reopen paths, which hit the same
 *  one-slot limit against the daemon's own `list_pending_prompts`. */
export function queueSiblingQuestion(sessionId: string, payload: QuestionRequestedPayload): void {
  _queuedSiblingQuestions.push(sessionId, payload);
}

/** Remove and return the queued sibling carrying `id`, if any - lets a
 *  clicked transcript card surface directly instead of falling through to
 *  the "newest open question" fallback, which would wrongly mark a genuine
 *  sibling as superseded (todo 860). */
export function takeQueuedSiblingQuestionById(sessionId: string, id: string): QuestionRequestedPayload | null {
  return _queuedSiblingQuestions.takeById(sessionId, id);
}

/** Which session (if any) currently owns the pending-prompt slot holding
 *  `id` - captured before clearPendingPromptById removes it, so the right
 *  sibling queue can be drained. */
function findSessionForPendingId(id: string): string | null {
  for (const sid of pendingPromptAskerIds()) {
    if (peekPendingPrompt(sid)?.payload.id === id) return sid;
  }
  return null;
}

// ── Secret-request queue ─────────────────────────────────────────────────
//
// Unlike questions, a secret request has no multi-sibling "awaiting" set on
// the daemon side - but the same single-slot-per-session park (gating.ts's
// `_pendingPrompts`) would still silently drop an EARLIER secret card if a
// second one for the same, currently-focused session arrived while the first
// was still open (storePendingPrompt overwrites the slot). Queued here
// instead, same shape as the sibling-question queue above, and drained once
// the session's slot frees up (handlePromptResolved below).

const _queuedSecrets = createPromptQueue<SecretRequestedPayload>((p) => handleSecretRequested(p));

/** A `request_secret` tool fired. Queue behind an already-open secret card for
 *  the SAME session, park a backgrounded session's, or surface the card (the
 *  focused chat). Never auto-answered - only Joe can supply the value. */
export function handleSecretRequested(payload: SecretRequestedPayload): void {
  const sid = payload.session_id;
  if (sid) {
    const existing = peekPendingPrompt(sid);
    if (existing?.kind === "secret" && existing.payload.id !== payload.id) {
      _queuedSecrets.push(sid, payload);
      rerenderSidebar();
      console.warn("[perm-gate] QUEUED secret-requested behind an open slot", { eventSessionId: sid, ...gateDiag() });
      return;
    }
  }
  if (!isForSelectedSession(displayIdOf(payload))) {
    if (sid) {
      storePendingPrompt(sid, { kind: "secret", payload });
      rerenderSidebar();
      console.warn("[perm-gate] PARKED secret-requested for backgrounded chat", { eventSessionId: sid, ...gateDiag() });
    } else {
      console.warn("[perm-gate] DROPPED secret-requested (no session_id)", { ...gateDiag() });
    }
    return;
  }
  showSecretCard(payload);
}

/** A permission tool fired. Allow (auto-accept / remembered rule), park (a
 *  backgrounded chat), or surface the card (the focused chat). Exported so unit
 *  tests can drive the gate without a Tauri event round-trip. */
export function handlePermissionRequested(payload: PermissionRequestedPayload): void {
  console.info("[perm-relay] frontend received permission-requested", { tool: payload.tool_name, session: payload.session_id, ...gateDiag() });
  // Where the card shows is the display chat; whether it is auto-allowed is the
  // ASKER's own setting. A sub's prompt must never ride its main chat's
  // auto-accept (that mode is deliberately not handed to chats it starts), so
  // every isAutoAccept below keys on payload.session_id and never on this.
  if (!isForSelectedSession(displayIdOf(payload))) {
    if (payload.session_id) {
      // Auto-accept is on for this backgrounded chat: allow NOW rather than
      // parking, so no "needs attention" dot appears for a prompt that will
      // never need the user. (Questions still park - never auto-answered.)
      if (isAutoAccept(payload.session_id) && extractQuestions(payload.input) === null && !needsHumanApproval(payload)) {
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
    && !needsHumanApproval(payload)
  ) {
    console.debug("[auto-accept] allowing", payload.tool_name, "for", payload.session_id);
    allowPermission(payload, "respond_permission");
    return;
  }

  const stillSelected = selectionGuard();
  void (async () => {
    if (await autoAllowIfRemembered(payload)) return;
    // Switched chats during the rule check: park it for switch-back instead
    // of mounting it over the chat now on screen.
    if (!stillSelected() && payload.session_id) {
      storePendingPrompt(payload.session_id, { kind: "permission", payload });
      rerenderSidebar();
      return;
    }
    // The window already shows ANOTHER asker's question: mounting this card would
    // tear it down under Joe's hands (ensureHost), half-typed answers and all.
    // Held behind it instead, as a second question is, with a chip in the picker
    // and a turn to be shown when the card in front is done. A slot already
    // occupied for this asker keeps today's behaviour, since a slot holds one prompt.
    const onScreen = getActiveCardAsker();
    if (payload.session_id && onScreen && onScreen !== payload.session_id && !peekPendingPrompt(payload.session_id)) {
      deferPendingPrompt(payload.session_id, { kind: "permission", payload });
      refreshActiveCardAskers();
      rerenderSidebar();
      return;
    }
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
  // Answered elsewhere (another window, the phone, an earlier app run whose
  // daemon still lists it): never show or park it. Still counts as delivered
  // so the daemon's on_question_request wait doesn't time out over it.
  if (dropIfAlreadyAnswered(sid, payload.id)) {
    confirmQuestionRendered(payload.id, sid);
    return;
  }
  // The same prompt re-announced while its card is already up (a lossy-push
  // replay, the phone poll): re-mounting would reset the card, so only bring
  // it back from its collapsed bar.
  if (isActiveCardId(payload.id)) {
    expandActiveCard({ id: payload.id });
    return;
  }
  if (sid) {
    yieldQuietSlot(sid, payload);
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
      if (hasSurface(payload)) confirmQuestionRendered(payload.id, payload.session_id);
      refreshActiveCardAskers();
      rerenderSidebar();
      console.warn("[perm-gate] QUEUED sibling question-requested behind an open slot", { eventSessionId: sid, ...gateDiag() });
      return;
    }
  }
  if (!isForSelectedSession(displayIdOf(payload))) {
    if (sid) {
      storePendingPrompt(sid, { kind: "question", payload });
      // A parked prompt is a genuine delivery, just like the shown-card branch
      // in question-ui.ts - the backgrounded chat WILL see it via its sidebar
      // marker, so on_question_request must not time out and report false.
      // A sub's card parks on its main chat's row, so it is only delivered while
      // that row exists: with none, nothing could ever show it, and acking it
      // would leave the sub waiting on an answer nobody can give.
      if (hasSurface(payload)) confirmQuestionRendered(payload.id, payload.session_id);
      else console.warn("[perm-gate] NOT confirming sub question: its main chat has no row to mark", { eventSessionId: sid, displayId: displayIdOf(payload) });
      rerenderSidebar();
      console.warn("[perm-gate] PARKED question-requested for backgrounded chat", { eventSessionId: sid, ...gateDiag() });
    } else {
      console.warn("[perm-gate] DROPPED question-requested (no session_id)", { ...gateDiag() });
    }
    return;
  }
  // The window already shows ANOTHER asker's card (a sub's, while this one is the
  // main chat's or a second sub's): mounting this one would replace a card Joe may
  // be mid-answer on. Park it instead and let the picker offer it.
  const onScreen = getActiveCardAsker();
  if (sid && onScreen && onScreen !== sid) {
    storePendingPrompt(sid, { kind: "question", payload });
    confirmQuestionRendered(payload.id, payload.session_id);
    refreshActiveCardAskers();
    rerenderSidebar();
    return;
  }
  void showQuestionCard(payload);
}

/** Whether a parked question has somewhere for Joe to see it. A chat's own
 *  prompt parks on its own row (today's behaviour, Jarvis workers included); a
 *  hidden sub has no row, so its card parks on its main chat's, which exists only
 *  while that chat is in the list. */
function hasSurface(payload: QuestionRequestedPayload): boolean {
  const shownOn = displayIdOf(payload);
  if (!shownOn || shownOn === payload.session_id) return true;
  return state.sessions.some((s) => s.session_id === shownOn);
}

/** A durable resolve is always genuine; a non-durable one for the id ON
 *  SCREEN can be a `claude -p` EOF poll-tick race mid-edit, so it's left alone. */
export function handlePromptResolved(id: string, durable = false): void {
  const sid = findSessionForPendingId(id);
  // Read before the slot is cleared: the window that showed this prompt is the
  // one that may now owe Joe its next card.
  const shownOn = sid ? displayIdOf(peekPendingPrompt(sid)?.payload ?? {}) : undefined;
  clearPendingPromptById(id);
  const isActive = isActiveCardId(id);
  if (durable || !isActive) clearQuestionDraft(id);
  // Only cancel the (module-global) push for the card actually on screen.
  if (isActive && durable) cancelAuqPush();
  if (durable) dismissQuestionCard(id);
  // Secret cards have their own tiny id-scoped registry (secret-card.ts) -
  // this only tears down the card if it's the one still showing for `id`.
  if (durable) dismissSecretCard(id);
  // A genuine resolve (or a background id that was never on screen) frees the
  // session's slot for its next queued sibling, if any (todo 897).
  if (sid && (durable || !isActive)) _queuedSiblingQuestions.promote(sid);
  // Same freed-slot reasoning, for a queued secret request instead of a sibling question.
  if (sid) _queuedSecrets.promote(sid);
  rerenderSidebar();
  // Another chat's count in the picker just changed, and if nothing is on screen
  // any more the window's next waiting card should come up on its own.
  refreshActiveCardAskers();
  if (shownOn && (durable || !isActive)) surfaceNextForDisplay(shownOn);
}

/** On regaining visibility/focus, reconcile against the daemon's CURRENT
 *  pending set - a diff-based poll only detects a removal it was awake for. */
let reconcileInFlight = false;
async function reconcileKnownPromptsOnRegainedVisibility(): Promise<void> {
  if (reconcileInFlight) return;
  const known = new Set<string>();
  const activeId = getActiveCardId();
  if (activeId) known.add(activeId);
  for (const sid of pendingPromptAskerIds()) {
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
export function startRemotePromptPoll(): void {
  const emitted = new Map<string, boolean>();
  const cb = {
    onQuestion: handleQuestionRequested,
    onPermission: handlePermissionRequested,
    onSecret: handleSecretRequested,
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
  if (!isAndroidShell()) {
    visibleInterval(() => void tick(), 700, {
      whileHidden: true,
      reason: "AskUserQuestion + permission prompts raised during a phone-driven turn must reach the user while they look elsewhere",
    });
    return;
  }
  // The Android shell keeps the process alive in the background, where 700ms
  // dials the PC for nothing. It still polls, slower: the daemon waits 8s for
  // a client to confirm a question card rendered (question.rs
  // RENDER_CONFIRM_TIMEOUT) and the phone may be the only client, so the
  // hidden period must stay well inside that window.
  let timer: ReturnType<typeof setInterval> | undefined;
  const arm = (): void => {
    if (timer !== undefined) clearInterval(timer);
    const hidden = document.visibilityState === "hidden";
    timer = setInterval(() => void tick(), hidden ? HIDDEN_PROMPT_POLL_MS : PROMPT_POLL_MS);
  };
  arm();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") void tick();
    arm();
  });
}

const PROMPT_POLL_MS = 700;
const HIDDEN_PROMPT_POLL_MS = 5_000;

let installed = false;

export function installPermissionModalListener(): void {
  if (installed) return;
  installed = true;

  // Seed the auto-accept set from the persisted store so the toggle survives a
  // restart. Done before the transport split below so the phone (which has no
  // Tauri event bus) still hydrates its gate.
  void hydrateAutoAccept();
  // The Main chats group is built from the mode flags, which change outside any
  // instance refresh (the menu toggle, this hydrate). Registered here rather
  // than at module scope: state.ts and this file import each other, so gating
  // may not have finished evaluating when this module's top level runs.
  onSubchatsChange(rerenderSidebar);
  void hydrateSubchatsOn();
  // The set is seeded once above, so a flip made on another surface (the phone, a
  // second window) and a respawn successor that inherits the mode only reach this
  // window by the daemon's nudge. On both transports, like the seed.
  void (async () => {
    try {
      await getTransport().listen("subchats-on-changed", () => { void hydrateSubchatsOn(); });
    } catch (e) {
      console.warn("[subchats-on] listen failed:", e);
    }
  })();

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
  ev.listen<SecretRequestedPayload>("secret-requested", (event) => handleSecretRequested(event.payload));
  // The reliable pending-prompt poll (daemon_link.rs) emits this, so it survives
  // the lossy broadcast.
  ev.listen<{ id: string; durable?: boolean }>("prompt-resolved", (event) => {
    const id = event.payload?.id;
    if (id) handlePromptResolved(id, event.payload?.durable === true);
  });
}
