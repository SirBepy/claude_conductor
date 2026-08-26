// Last-resort recovery for text that left the composer: every message it
// consumes is recorded here before the box clears, so Ctrl+Z can pull it back
// even when the send silently never landed. Text only - attachment bytes would
// blow the localStorage quota (see composer-persistence.ts's AttachmentMeta).

const OUTBOX_PREFIX = "chat-sent:v1:";

/** Per session. Deep enough to walk back through a burst of messages, small
 *  enough that a long chat's entries stay well inside the LS quota. */
const MAX_ENTRIES = 20;

function outboxKey(sessionId: string): string {
  return OUTBOX_PREFIX + sessionId;
}

function read(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(outboxKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function write(sessionId: string, list: string[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(outboxKey(sessionId));
    else localStorage.setItem(outboxKey(sessionId), JSON.stringify(list));
  } catch {
    /* quota or storage disabled - recovery is best-effort, never fatal */
  }
}

/** Record text the composer is about to clear. Oldest entries fall off. */
export function recordSent(sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const list = read(sessionId);
  // Re-sending the same text (a Retry, a resend after an edit) shouldn't
  // stack duplicates the user then has to press Ctrl+Z through twice.
  if (list[list.length - 1] === trimmed) return;
  list.push(trimmed);
  write(sessionId, list.slice(-MAX_ENTRIES));
}

/** Take the most recent entry back off the stack. Null when empty. */
export function popLastSent(sessionId: string): string | null {
  const list = read(sessionId);
  const last = list.pop();
  if (last === undefined) return null;
  write(sessionId, list);
  return last;
}

/** Drop a session's history (session discarded / chat deleted). */
export function clearSentOutbox(sessionId: string): void {
  write(sessionId, []);
}

/** Carry history across a placeholder -> real session id upgrade, mirroring
 *  moveComposerDraft so a new chat's first messages stay recoverable. */
export function moveSentOutbox(fromId: string, toId: string): void {
  const list = read(fromId);
  if (list.length) write(toId, [...read(toId), ...list].slice(-MAX_ENTRIES));
  write(fromId, []);
}
