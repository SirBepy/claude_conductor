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
  /** What is queued behind `sessionId`'s slot, oldest first. Read-only. */
  all(sessionId: string): readonly T[];
}

/** `yields` marks payloads that wait behind every other queued payload, whatever
 *  arrived first (a quiet checkup card): `promote` takes the oldest payload that
 *  does not yield, and a yielding one only when nothing else is queued. */
export function createPromptQueue<T extends { id: string }>(
  dispatch: (payload: T) => void,
  opts: { yields?: (payload: T) => boolean } = {},
): PromptQueue<T> {
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
      const q = queues.get(sessionId) ?? [];
      const first = opts.yields ? q.findIndex((p) => !opts.yields!(p)) : 0;
      const next = remove(sessionId, first === -1 ? 0 : first);
      if (next) dispatch(next);
    },
    all(sessionId) {
      return queues.get(sessionId) ?? [];
    },
  };
}
