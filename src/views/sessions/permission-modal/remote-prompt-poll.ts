/**
 * Reading of the daemon's pending-prompt store, for both transports.
 *
 * The desktop learns about AskUserQuestion / permission prompts through a
 * reliable poll in the Rust app (daemon_link.rs::spawn_pending_prompt_poll):
 * it lists `list_pending_prompts`, emits each open prompt's Tauri event once,
 * and emits `prompt-resolved` when one disappears. The phone has no Tauri event
 * bus, so AUQs never reached it. `reconcilePendingPrompts` is that same demux,
 * in JS, driven by the HttpTransport poll in index.ts.
 *
 * Pure (no DOM / transport imports) so both exports are unit-testable.
 */

import type { PermissionRequestedPayload, QuestionRequestedPayload, SecretRequestedPayload } from "./types";

export interface PromptPollCallbacks {
  onQuestion: (p: QuestionRequestedPayload) => void;
  onPermission: (p: PermissionRequestedPayload) => void;
  onSecret: (p: SecretRequestedPayload) => void;
  onResolved: (id: string, durable: boolean) => void;
}

/** One stored prompt as returned by `list_pending_prompts`:
 *  `{ id, event, payload, durable }` (see daemon state.rs::add_prompt). */
interface StoredPrompt {
  id?: unknown;
  event?: unknown;
  payload?: unknown;
  durable?: unknown;
}

/**
 * Diff a fresh `list_pending_prompts` snapshot against the ids already
 * surfaced. New question/permission prompts fire their callback exactly once
 * (and are added to `emitted`, mapped to their durability); ids that vanished
 * from the snapshot fire `onResolved` with that durability and are dropped.
 * Mutates `emitted` in place.
 */
export function reconcilePendingPrompts(
  prompts: unknown,
  emitted: Map<string, boolean>,
  cb: PromptPollCallbacks,
): void {
  if (!Array.isArray(prompts)) return;
  const present = new Set<string>();
  for (const raw of prompts) {
    const p = raw as StoredPrompt;
    const id = typeof p?.id === "string" ? p.id : undefined;
    if (!id) continue;
    present.add(id);
    if (emitted.has(id)) continue;
    const event = typeof p.event === "string" ? p.event : "";
    if (p.payload == null) continue;
    const durable = typeof p.durable === "boolean" ? p.durable : false;
    if (event === "question-requested") {
      cb.onQuestion(p.payload as QuestionRequestedPayload);
      emitted.set(id, durable);
    } else if (event === "permission-requested") {
      cb.onPermission(p.payload as PermissionRequestedPayload);
      emitted.set(id, durable);
    } else if (event === "secret-requested") {
      cb.onSecret(p.payload as SecretRequestedPayload);
      emitted.set(id, durable);
    }
  }
  for (const [id, durable] of Array.from(emitted)) {
    if (!present.has(id)) {
      cb.onResolved(id, durable);
      emitted.delete(id);
    }
  }
}

/** One demuxed record from a `list_pending_prompts` snapshot. */
export type PendingPromptRecord =
  | { kind: "question"; id: string; payload: QuestionRequestedPayload }
  | { kind: "permission"; id: string; payload: PermissionRequestedPayload }
  | { kind: "secret"; id: string; payload: SecretRequestedPayload };

/** Every still-open prompt whose card shows in `displayId`'s window, in snapshot
 *  order: that chat's own, and each hidden sub's (`display_session_id`). A
 *  payload with no display id displays on its asker, as before. */
export function findPendingPromptsDisplayedOn(
  prompts: unknown,
  displayId: string,
): PendingPromptRecord[] {
  if (!Array.isArray(prompts) || !displayId) return [];
  return findPendingPromptsMatching(prompts, (p) => (p.display_session_id || p.session_id) === displayId);
}

/** Every still-open prompt for `sessionId`, in snapshot order. Stateless unlike
 *  {@link reconcilePendingPrompts} - no "already emitted" memory - so a lost
 *  card can be rebuilt on demand however many times it takes. */
export function findPendingPromptsForSession(
  prompts: unknown,
  sessionId: string,
): PendingPromptRecord[] {
  if (!Array.isArray(prompts) || !sessionId) return [];
  return findPendingPromptsMatching(prompts, (p) => p.session_id === sessionId);
}

function findPendingPromptsMatching(
  prompts: unknown[],
  matches: (payload: { session_id?: unknown; display_session_id?: unknown }) => boolean,
): PendingPromptRecord[] {
  const out: PendingPromptRecord[] = [];
  for (const raw of prompts) {
    const p = raw as StoredPrompt;
    const id = typeof p?.id === "string" ? p.id : undefined;
    if (!id || p.payload == null) continue;
    if (!matches(p.payload as { session_id?: unknown; display_session_id?: unknown })) continue;
    const event = typeof p.event === "string" ? p.event : "";
    if (event === "question-requested") {
      out.push({ kind: "question", id, payload: p.payload as QuestionRequestedPayload });
    } else if (event === "permission-requested") {
      out.push({ kind: "permission", id, payload: p.payload as PermissionRequestedPayload });
    } else if (event === "secret-requested") {
      out.push({ kind: "secret", id, payload: p.payload as SecretRequestedPayload });
    }
  }
  return out;
}

// ---- Live frames on the global stream ------------------------------------------------

/** The daemon pushes each new prompt on `/api/global/stream` as it is raised
 *  (`permission_request`, `question_request`, `secret_request`; the stream's
 *  event map renames them to these). The frame's payload is the stored
 *  prompt's payload, so a card needs no poll tick to appear: the 8s
 *  render-confirm window (question.rs RENDER_CONFIRM_TIMEOUT) is met by the
 *  frame's own latency. */
const FRAME_EVENTS = ["question-requested", "permission-requested", "secret-requested"] as const;

/** A question outlives the daemon's prompt sweep (`durable`); the other two do not. */
const FRAME_DURABLE: Record<(typeof FRAME_EVENTS)[number], boolean> = {
  "question-requested": true,
  "permission-requested": false,
  "secret-requested": false,
};

/** Surfaces one prompt frame, once: a prompt the poll already surfaced (same
 *  id in `emitted`) is not shown again. Returns whether a card was raised. */
export function surfacePromptFrame(
  event: (typeof FRAME_EVENTS)[number],
  payload: unknown,
  emitted: Map<string, boolean>,
  cb: PromptPollCallbacks,
): boolean {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id || emitted.has(id)) return false;
  if (event === "question-requested") cb.onQuestion(payload as QuestionRequestedPayload);
  else if (event === "permission-requested") cb.onPermission(payload as PermissionRequestedPayload);
  else cb.onSecret(payload as SecretRequestedPayload);
  emitted.set(id, FRAME_DURABLE[event]);
  return true;
}

/** `question_expired`: the daemon's sweep dropped the question. */
export function expirePromptFrame(payload: unknown, emitted: Map<string, boolean>, cb: PromptPollCallbacks): void {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !emitted.has(id)) return;
  cb.onResolved(id, emitted.get(id) === true);
  emitted.delete(id);
}

export interface PromptFeedDeps {
  /** `list_pending_prompts`. */
  list: () => Promise<unknown>;
  /** The transport's `listen`; a throw or rejection leaves the poll as the only path. */
  listen: (event: string, cb: (payload: unknown) => void) => Promise<unknown> | unknown;
  cb: PromptPollCallbacks;
}

export interface PromptFeed {
  /** Reads the daemon's pending set and reconciles it: the fallback for a frame
   *  that never came (lagged stream) and the only way a prompt answered
   *  elsewhere disappears. */
  tick(): Promise<void>;
}

/** The phone's prompt intake: live frames first, `tick` as the safety net. */
export function startPromptFeed(deps: PromptFeedDeps): PromptFeed {
  const emitted = new Map<string, boolean>();
  // Counts frames seen. A snapshot requested before a frame landed cannot
  // contain that frame's prompt, so reconciling it would resolve the card the
  // frame just raised; such a snapshot is dropped and the next tick repairs.
  let frames = 0;

  const listen = async (event: string, handler: (payload: unknown) => void): Promise<void> => {
    try {
      await deps.listen(event, handler);
    } catch (e) {
      console.warn(`[prompt-feed] listen(${event}) failed, polling only:`, e);
    }
  };
  for (const event of FRAME_EVENTS) {
    void listen(event, (payload) => {
      frames++;
      surfacePromptFrame(event, payload, emitted, deps.cb);
    });
  }
  void listen("question-expired", (payload) => {
    frames++;
    expirePromptFrame(payload, emitted, deps.cb);
  });

  return {
    async tick(): Promise<void> {
      const startedAt = frames;
      let prompts: unknown;
      try {
        prompts = await deps.list();
      } catch {
        return; // network blip - keep `emitted` and retry next tick
      }
      if (frames !== startedAt) return;
      reconcilePendingPrompts(prompts, emitted, deps.cb);
    },
  };
}
