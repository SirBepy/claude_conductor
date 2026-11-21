// Where the Run card's data comes from (pc-1804 step 5): the daemon's `run_plan_state`, read
// when the chat's id is first known and again whenever the daemon announces
// `run-plan-changed` for this chat (a lane started or finished, a step closed, the run
// moved to a respawned chat). The dashboard derives from `sideData()`; the DOM is run-card.ts.

import { invoke } from "../../../shared/ipc";
import { getTransport } from "../../../shared/transport";
import { normaliseRun, type RunSide } from "../../../shared/chat/dashboard/run-model";

export interface RunSourceHost {
  /** The chat's id; null until the renderer knows it. */
  sessionId(): string | null;
  /** Asks the dashboard for a redraw. */
  schedule(): void;
}

/** The finished run Joe cleared, per chat. A dashboard is rebuilt on every chat switch, and a
 *  finished run stays in the daemon's file until the next `create`, so without this a cleared
 *  card would come back whenever he returns to the chat. In memory only: a restart shows it
 *  once more, which is harmless and says the run ended. */
const clearedByChat = new Map<string, string>();

export class RunSource {
  private side: RunSide | undefined;
  private asked = false;
  private unlisten: (() => void) | null = null;
  private disposed = false;
  /** Bumps per read, so a slow answer never overwrites a newer one. */
  private req = 0;

  constructor(private readonly cb: RunSourceHost) {}

  /** What the dashboard derives from; undefined until the first read, and for a cleared run. */
  sideData(): RunSide | undefined {
    const sid = this.cb.sessionId();
    // Only a finished run stays cleared: `add` can reopen the same run id, and then it is back.
    if (!this.side || (this.side.status === "done" && sid && clearedByChat.get(sid) === this.side.id)) return undefined;
    return this.side;
  }

  async subscribe(): Promise<void> {
    try {
      const un = await getTransport().listen<{ session_id?: string }>("run-plan-changed", (p) => {
        if (p?.session_id && p.session_id === this.cb.sessionId()) void this.load();
      });
      if (this.disposed) un();
      else this.unlisten = un;
    } catch (err) {
      console.warn("[chat-dashboard] listen(run-plan-changed) failed", err);
    }
  }

  /** Reads the run the first time the chat's id is known. */
  ensureLoaded(): void {
    if (this.asked || !this.cb.sessionId()) return;
    this.asked = true;
    void this.load();
  }

  /** Hides the finished run until the chat makes another one. */
  clear(): void {
    const sid = this.cb.sessionId();
    if (!sid || !this.side) return;
    clearedByChat.set(sid, this.side.id);
    this.cb.schedule();
  }

  private async load(): Promise<void> {
    const sessionId = this.cb.sessionId();
    if (!sessionId) return;
    const req = ++this.req;
    try {
      const raw = await invoke<unknown>("run_plan_state", { sessionId });
      if (this.disposed || req !== this.req) return;
      this.side = normaliseRun(raw);
      // A run that is open again forgets its clearing, so finishing a second time shows it.
      if (this.side?.status !== "done") clearedByChat.delete(sessionId);
      this.cb.schedule();
    } catch (err) {
      console.warn("[chat-dashboard] run_plan_state failed", err);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
  }
}
