// Held-message half of cross-surface draft sync: the daemon round trips
// (add/update/remove/clear) plus the local-id -> server-id swap that keeps
// the chip responsive while offline. held-messages.ts owns the local
// Map<sessionId, HeldItem[]> and its persistence; this only talks to the daemon.

import type { ContentBlock } from "../../types/ipc.generated";
import { debounce, type Debounced } from "../debounce";
import {
  addHeldMessage, updateHeldMessage, removeHeldMessage, clearHeldMessages, getSessionDrafts,
} from "./session-draft-sync";
import { isPendingSessionId } from "./pending-session-id";

const EDIT_PUSH_DEBOUNCE_MS = 500;

const unsyncedKey = (sessionId: string, id: number): string => `${sessionId}:${id}`;

export class HeldDraftSync {
  // Per-item debounced `update_held_message` push, keyed by the item's
  // CURRENT id (local until add_held_message resolves, then server-assigned).
  private editPushDebounced = new Map<number, Debounced<[sessionId: string, id: number, blocks: ContentBlock[]]>>();
  // Tracks an in-flight add_held_message round trip so a remove that races it
  // chains onto the resolved server id instead of racing to delete an id the
  // daemon has never heard of (would silently orphan the item server-side).
  private pendingServerIds = new Map<number, Promise<number | null>>();

  // `sessionId:id` of items whose add_held_message failed: the daemon never saw
  // them, so an absence from clear_held_messages' removed_ids says nothing about
  // them. Keyed by session because local ids come from one window-wide counter
  // while the daemon numbers each session's items from 1, so a bare id could
  // match an unrelated item in another session.
  private unsyncedKeys = new Set<string>();

  isPending(id: number): boolean {
    return this.pendingServerIds.has(id);
  }

  /** True when this item's add never reached the daemon (so it cannot have been
   *  injected mid-turn by the daemon's own copy of the list). */
  isUnsynced(sessionId: string, id: number): boolean {
    return this.unsyncedKeys.has(unsyncedKey(sessionId, id));
  }

  /** Drop the marks of `sessionId`'s items that are no longer in its held list
   *  (`liveIds`): reconcile and markDelivered remove items without going
   *  through remove(). */
  retainUnsynced(sessionId: string, liveIds: number[]): void {
    const live = new Set(liveIds.map((id) => unsyncedKey(sessionId, id)));
    for (const key of this.unsyncedKeys) {
      if (key.startsWith(`${sessionId}:`) && !live.has(key)) this.unsyncedKeys.delete(key);
    }
  }

  /** Carry the marks across a pending placeholder id becoming the real session id. */
  renameSession(from: string, to: string): void {
    for (const key of [...this.unsyncedKeys]) {
      if (!key.startsWith(`${from}:`)) continue;
      this.unsyncedKeys.delete(key);
      this.unsyncedKeys.add(`${to}${key.slice(from.length)}`);
    }
  }

  /** Fetch the daemon's held-items snapshot and hand it to `onResolved`, which
   *  fires from the SAME `.then` as the fetch - no extra hop, so this can't
   *  reorder against stage()'s pendingServerIds swap. Caller reads its own
   *  live item map (not a snapshot passed in here) for the merge. */
  reconcile(sessionId: string, onResolved: (serverItems: { id: number; blocks: ContentBlock[] }[]) => void): Promise<void> {
    if (isPendingSessionId(sessionId)) return Promise.resolve();
    return getSessionDrafts(sessionId).then(
      (drafts) => {
        onResolved(drafts.held.map((h) => ({ id: h.id, blocks: h.blocks })));
      },
      (e) => {
        console.warn("[held] reconcile (get_session_drafts) failed:", e);
      },
    );
  }

  /** Push a newly staged item; `onResolved` fires ONLY on success so a failed
   *  add leaves the local id in place as the permanent fallback. */
  add(sessionId: string, localId: number, blocks: ContentBlock[], onResolved: (serverId: number) => void): void {
    // A retry (repushHeld) starts from a clean slate; only a fresh failure re-marks it.
    this.unsyncedKeys.delete(unsyncedKey(sessionId, localId));
    const pending: Promise<number | null> = addHeldMessage(sessionId, blocks)
      .then((res) => {
        onResolved(res.id);
        return res.id;
      })
      .catch((e) => {
        console.warn("[held] add_held_message failed (offline?):", e);
        this.unsyncedKeys.add(unsyncedKey(sessionId, localId));
        return null;
      })
      .finally(() => this.pendingServerIds.delete(localId));
    this.pendingServerIds.set(localId, pending);
  }

  /** Drop a staged item. If the add for this id is still in flight, chain
   *  onto its resolved server id instead of racing to delete an id the
   *  daemon never assigned. */
  remove(sessionId: string, id: number): void {
    this.editPushDebounced.get(id)?.cancel();
    this.editPushDebounced.delete(id);
    this.unsyncedKeys.delete(unsyncedKey(sessionId, id));
    const doRemove = (serverId: number): void => {
      void removeHeldMessage(sessionId, serverId).catch((e) => console.warn("[held] remove_held_message failed:", e));
    };
    const pending = this.pendingServerIds.get(id);
    if (pending) void pending.then((serverId) => doRemove(serverId ?? id));
    else doRemove(id);
  }

  /** Debounced live-edit push. */
  edit(sessionId: string, id: number, blocks: ContentBlock[]): void {
    this.getEditPush(id)(sessionId, id, blocks);
  }

  flushEdit(id: number): void {
    this.editPushDebounced.get(id)?.flush();
  }

  flushAllEdits(): void {
    for (const d of this.editPushDebounced.values()) d.flush();
  }

  /** Take the daemon's whole held list for `sessionId` in one step and report
   *  which ids it removed (`removed`) and which the mid-turn inject hook had
   *  already handed to Claude (`injected`). Both remove under the same lock, so
   *  an id lands in exactly one of them. An id in neither was never held by
   *  this daemon (it restarted and lost its in-memory list). `injected` is null
   *  from a daemon that only reports `removed_ids`. Awaits every in-flight add
   *  first, so local ids have been swapped for the server ids both lists speak
   *  in. Null when the call fails or `removed_ids` is missing (outcome unknown). */
  async claimAll(sessionId: string): Promise<{ removed: number[]; injected: number[] | null } | null> {
    await Promise.all([...this.pendingServerIds.values()]);
    try {
      const res = await clearHeldMessages(sessionId);
      if (!Array.isArray(res?.removed_ids)) return null;
      return { removed: res.removed_ids, injected: Array.isArray(res.injected_ids) ? res.injected_ids : null };
    } catch (e) {
      console.warn("[held] clear_held_messages (claim) failed:", e);
      return null;
    }
  }

  /** Fire-and-forget: the caller already cleared local state. */
  clear(sessionId: string): void {
    this.retainUnsynced(sessionId, []);
    void clearHeldMessages(sessionId).catch((e) => console.warn("[held] clear_held_messages failed:", e));
  }

  private getEditPush(id: number): Debounced<[sessionId: string, id: number, blocks: ContentBlock[]]> {
    let d = this.editPushDebounced.get(id);
    if (!d) {
      d = debounce((sessionId, itemId, blocks) => {
        void updateHeldMessage(sessionId, itemId, blocks).catch((e) => console.warn("[held] update_held_message failed:", e));
      }, EDIT_PUSH_DEBOUNCE_MS);
      this.editPushDebounced.set(id, d);
    }
    return d;
  }
}
