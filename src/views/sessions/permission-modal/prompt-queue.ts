// Per-session FIFO of prompts waiting behind gating.ts's one pending-prompt
// slot per session. Shared by the sibling-question queue and the
// secret-request queue in index.ts: both hold payloads that would otherwise
// overwrite the slot's current prompt, deduped by id, and both drain by
// re-running their own arrival handler once the slot frees up.

export interface PromptQueue<T extends { id: string }> {
  /** Queue behind the slot's current prompt. No-op if `payload.id` is already queued. */
  push(sessionId: string, payload: T): void;
  /** Remove and return the queued payload carrying `id`, if any. */
  takeById(sessionId: string, id: string): T | null;
  /** Shift the oldest queued payload and hand it to `dispatch`. No-op on an empty queue. */
  promote(sessionId: string): void;
}

export function createPromptQueue<T extends { id: string }>(dispatch: (payload: T) => void): PromptQueue<T> {
  const queues = new Map<string, T[]>();

  function remove(sessionId: string, index: number): T | null {
    const q = queues.get(sessionId);
    if (!q || index < 0 || index >= q.length) return null;
    const [payload] = q.splice(index, 1);
    if (q.length === 0) queues.delete(sessionId);
    return payload ?? null;
  }

  return {
    push(sessionId, payload) {
      const q = queues.get(sessionId) ?? [];
      if (q.some((p) => p.id === payload.id)) return;
      q.push(payload);
      queues.set(sessionId, q);
    },
    takeById(sessionId, id) {
      return remove(sessionId, queues.get(sessionId)?.findIndex((p) => p.id === id) ?? -1);
    },
    promote(sessionId) {
      const next = remove(sessionId, 0);
      if (next) dispatch(next);
    },
  };
}
