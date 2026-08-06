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

import type { PermissionRequestedPayload, QuestionRequestedPayload } from "./types";

export interface PromptPollCallbacks {
  onQuestion: (p: QuestionRequestedPayload) => void;
  onPermission: (p: PermissionRequestedPayload) => void;
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
  | { kind: "permission"; id: string; payload: PermissionRequestedPayload };

/** Every still-open prompt for `sessionId`, in snapshot order. Stateless unlike
 *  {@link reconcilePendingPrompts} - no "already emitted" memory - so a lost
 *  card can be rebuilt on demand however many times it takes. */
export function findPendingPromptsForSession(
  prompts: unknown,
  sessionId: string,
): PendingPromptRecord[] {
  if (!Array.isArray(prompts) || !sessionId) return [];
  const out: PendingPromptRecord[] = [];
  for (const raw of prompts) {
    const p = raw as StoredPrompt;
    const id = typeof p?.id === "string" ? p.id : undefined;
    if (!id || p.payload == null) continue;
    const payload = p.payload as { session_id?: unknown };
    if (payload.session_id !== sessionId) continue;
    const event = typeof p.event === "string" ? p.event : "";
    if (event === "question-requested") {
      out.push({ kind: "question", id, payload: p.payload as QuestionRequestedPayload });
    } else if (event === "permission-requested") {
      out.push({ kind: "permission", id, payload: p.payload as PermissionRequestedPayload });
    }
  }
  return out;
}
