// What the daemon stored on each sub's brief that the Plan card draws: its kind (the icon) and its
// task (the line under a queued chat's header). Read once per sub through `get_sub_brief`, the way
// the Subchats card's queued popup reads a task; until a read lands the card draws the kind the
// sub's name suggests (chat-kinds.ts `guessKind`), so a row never waits on it.

import { invoke } from "../../../shared/ipc";
import { normalizeKind, type ChatKind } from "../../../shared/chat/chat-kinds";

interface BriefReply {
  brief: { task?: string; kind?: string } | null;
}

export class SubKinds {
  /** Sub id to its stored kind; a sub whose brief names none (a chat the user started) has no entry. */
  readonly kinds = new Map<string, ChatKind>();
  /** Sub id to the first line of its brief's task, "" when it has none. */
  readonly tasks = new Map<string, string>();
  private readonly asked = new Set<string>();
  private disposed = false;

  constructor(private readonly onRead: () => void) {}

  /** Reads every sub not asked about yet. A failed read is not retried: the guess stands. */
  ensure(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.asked.has(id)) continue;
      this.asked.add(id);
      void invoke<BriefReply>("get_sub_brief", { sessionId: id })
        .then((r) => {
          if (this.disposed) return;
          const kind = normalizeKind(r?.brief?.kind);
          if (kind) this.kinds.set(id, kind);
          this.tasks.set(id, (r?.brief?.task ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "");
          this.onRead();
        })
        .catch(() => { /* no brief: the name's kind stands */ });
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
