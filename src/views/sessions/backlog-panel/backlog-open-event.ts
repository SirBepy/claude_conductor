// The statusbar's todos chip (phone only) and a todo id in chat text ask the
// sessions view to open the Backlog panel. Announced on `window` like the draft
// and ask events, because neither the statusbar nor shared/chat may import the
// view that owns the panel host.

export const BACKLOG_OPEN_EVENT = "cc-backlog-open";

// A phone mounts the panel only once it is opened, after this event already
// fired, so the requested todo waits here for the panel's constructor. The
// short expiry keeps a request nobody picked up from opening a todo on some
// later, unrelated panel mount.
const PENDING_TTL_MS = 3000;
let pending: { id: string; at: number } | null = null;

/** Opens the Backlog panel on the todo `id`. */
export function requestTodoOpen(id: string): void {
  pending = { id, at: Date.now() };
  window.dispatchEvent(new CustomEvent(BACKLOG_OPEN_EVENT, { detail: { id } }));
}

/** The todo id a request is waiting to open, handed out once. */
export function takePendingTodoId(): string | null {
  const hit = pending;
  pending = null;
  return hit && Date.now() - hit.at < PENDING_TTL_MS ? hit.id : null;
}
