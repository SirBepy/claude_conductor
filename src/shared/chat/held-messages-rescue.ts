// Auto-rescue fuse (todo 926), split out of held-messages.ts (todo 935) to
// keep that controller under the size convention. Same host-interface
// composition shape held-messages-render.ts's HeldRenderHost already uses -
// this class touches only its own two fields plus the narrow RescueHost
// below, never held-messages.ts's map/persist/sync internals directly.
//
// The fuse's SEVEN cancellation paths are the whole safety argument for this
// feature (normal flush, session switch, view teardown, manual Send now,
// rename mid-flight, non-answer staging, background staging) - see todo
// 926's "Shipped" section. Several route through methods that stay behind in
// held-messages.ts (flush, flushHeldWithDraft, attach, renameSession,
// sendNow), which is why this module exposes schedule/clear/rename/sid
// rather than folding those call sites in here too.

/** Everything the fuse needs from HeldMessages to decide whether firing is
 *  still safe (see fire()'s guards) and to actually rescue. */
export interface RescueHost {
  /** True when `sid` is the currently-attached (mounted) session. */
  isAttachedTo(sid: string): boolean;
  /** Whether the held set for `sid` already carries an AUQ answer. */
  hasAuqAnswerFor(sid: string): boolean;
  /** True while the attached session's turn is still busy. Only meaningful
   *  once isAttachedTo(sid) has already confirmed something is attached. */
  isBusy(): boolean;
  /** Interrupt + flush, same as the manual "Send now" button. */
  sendNow(): Promise<boolean>;
}

// A fire-and-forget AUQ answer staged while `busy` is stuck true is
// deadlocked - the thing that would clear `busy` (the turn's own result
// line) is what's waiting on the answer. The healthy case (the asking turn
// genuinely still finishing) resolves on its own via onCompletion within
// ~15s, well under this, so the fuse only ever fires on the genuinely stuck
// case. Decided by Joe 2026-09-10: ~60s.
const RESCUE_FUSE_MS = 60_000;

export class HeldMessagesRescue {
  // Scoped to the ATTACHED session only: fire() acts through the host's
  // isAttachedTo/isBusy, which are only reliable for whichever session is
  // currently mounted. A background stageFor() (answered a question in a
  // chat you're not looking at) does not arm this; the existing ~15s
  // background sweep still owns that case, unchanged.
  private rescueSid: string | null = null;
  private rescueTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: RescueHost) {}

  /** The session currently armed, if any. */
  get sid(): string | null {
    return this.rescueSid;
  }

  /** Arm the fuse for `sid`, unless one is already running. One at a time:
   *  `sid` is always the attached session (the only caller, stageFor, gates
   *  on that), so a second stage before the first fuse fires just leaves the
   *  original countdown running. */
  schedule(sid: string): void {
    if (this.rescueTimer !== null) return;
    this.rescueSid = sid;
    this.rescueTimer = setTimeout(() => this.fire(), RESCUE_FUSE_MS);
  }

  /** Disarm the fuse, if any. Safe to call unconditionally - every
   *  cancellation path (flush, flushHeldWithDraft, sendNow, attach to a
   *  different session, and the public cancelPendingRescue escape hatch)
   *  calls this. */
  clear(): void {
    if (this.rescueTimer !== null) {
      clearTimeout(this.rescueTimer);
      this.rescueTimer = null;
    }
    this.rescueSid = null;
  }

  /** Follow a session rename rather than cancel: fire() re-reads rescueSid
   *  at fire time, so this keeps the SAME in-flight timer pointed at the
   *  session's new id instead of losing the fuse to a mid-flight rename
   *  (e.g. a pending-session placeholder upgrading while its answer waits). */
  rename(from: string, to: string): void {
    if (this.rescueSid === from) this.rescueSid = to;
  }

  /** Fires ~60s after an AUQ answer was staged (see held-messages.ts's
   *  stageFor). Reads rescueSid fresh rather than closing over the id
   *  staged at, so a rename() mid-flight is followed rather than missed.
   *  Every guard below is a reason NOT to touch the turn - this is the
   *  highest-risk path in the class, since an errant cancel_turn would hit
   *  an unrelated, live turn:
   *   - the session was switched away from (attach() to a different sid
   *     already cleared this - rescueSid would be null here, not a stale id)
   *   - the answer already flushed by the normal completion path
   *   - `busy` already cleared (rescuing now would interrupt a FRESH turn,
   *     not the stuck one this fuse exists for) */
  private fire(): void {
    this.rescueTimer = null;
    const sid = this.rescueSid;
    this.rescueSid = null;
    if (!sid) return;
    if (!this.host.isAttachedTo(sid)) return;
    if (!this.host.hasAuqAnswerFor(sid)) return;
    if (!this.host.isBusy()) return;
    void this.host.sendNow();
  }
}
