// Data-fetch/polling layer for SessionStatusbar, extracted per todo 748. Each
// function keeps the original race-guard shape (an `isCurrent()` check taken
// AFTER the await) but takes it as a param instead of reading `this`, so the
// class stays the sole owner of instance-state mutation and re-render calls.
import { invoke } from "../../shared/ipc";
import { RemoteUnavailableError } from "../../shared/http-transport";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { getChatRendererSnapshot } from "../../shared/chat/chat-renderer-bridge";
import { sessionEvents } from "../../shared/chat/event-store";
import {
  countsCache, ctxStatusCache, fetchGitInfo,
  type SessionCounts,
} from "./session-statusbar-helpers";

export { countsCache, ctxStatusCache, type SessionCounts } from "./session-statusbar-helpers";

/** User prompts this chat has actually delivered, or null when the live
 *  renderer can't answer for this session (a different chat is mounted, or
 *  older history is still unpaged). */
export function deliveredPrompts(sid: string): number | null {
  const snap = getChatRendererSnapshot();
  if (!snap || snap.sessionId !== sid) return null;
  if (sessionEvents.hasMore(sid)) return null;
  return snap.messages.reduce((n, m) => n + (m.kind === "user" ? 1 : 0), 0);
}

export async function refreshCounts(opts: {
  sessionId: string;
  isCurrent: () => boolean;
  onClear: () => void;
  onUpdate: (counts: SessionCounts) => void;
}): Promise<void> {
  const sid = opts.sessionId;
  try {
    const r = await invoke<{ tokens: number; turns: number; prompts?: number }>("instance_token_stats", { sessionId: sid });
    if (!opts.isCurrent()) return;
    const next: SessionCounts = { prompts: r.prompts ?? 0, turns: r.turns ?? 0 };
    // A chat that has delivered nothing cannot own counts, so these belong to
    // another transcript. Fall back to the skeleton chip (todo 660).
    if (next.prompts > 0 && deliveredPrompts(sid) === 0) {
      countsCache.delete(sid);
      opts.onClear();
      return;
    }
    countsCache.set(sid, next);
    opts.onUpdate(next);
  } catch { /* transient - keep last known counts */ }
}

export async function refreshContextStatus(opts: {
  sessionId: string;
  isCurrent: () => boolean;
  hadUsage: boolean;
  hasCtxStatus: () => boolean;
  allowRetry: boolean;
  onResult: (status: ContextStatus) => void;
  scheduleRetry: (fn: () => void) => void;
}): Promise<void> {
  try {
    const r = await invoke<ContextStatus | null>("context_status", { sessionId: opts.sessionId });
    if (!opts.isCurrent()) return;
    if (r) {
      ctxStatusCache.set(opts.sessionId, r);
      opts.onResult(r);
    } else if (opts.allowRetry && opts.hadUsage && !opts.hasCtxStatus()) {
      opts.scheduleRetry(() => {
        if (opts.isCurrent() && !opts.hasCtxStatus()) void refreshContextStatus({ ...opts, allowRetry: false });
      });
    }
  } catch { /* command may predate this binary, or transient - keep fallback */ }
}

export async function refreshGitInfo(opts: {
  cwd: string;
  isCurrent: () => boolean;
  onSuccess: (info: GitInfo) => void;
  onUnavailable: () => void;
}): Promise<void> {
  try {
    const info = await fetchGitInfo(opts.cwd);
    if (!opts.isCurrent()) return;
    opts.onSuccess(info);
  } catch (e) {
    // An unwired remote command resolves the skeleton to hidden instead of
    // spinning forever; a genuine transient failure keeps retrying.
    if (e instanceof RemoteUnavailableError) opts.onUnavailable();
  }
}

export async function refreshDirty(opts: {
  cwd: string;
  isCurrent: () => boolean;
  onSuccess: (count: number) => void;
  onUnavailable: () => void;
}): Promise<void> {
  try {
    const files = await invoke<string[]>("get_git_dirty", { cwd: opts.cwd });
    if (!opts.isCurrent()) return;
    opts.onSuccess(files.length);
  } catch (e) {
    if (e instanceof RemoteUnavailableError) opts.onUnavailable();
  }
}

/** Resolve the session's live working dir (the AI may have moved into a
 *  worktree). Falls back to the spawn cwd when the live lookup is unavailable. */
export async function resolveLiveCwd(sessionId: string, fallback: string): Promise<string> {
  try {
    return await invoke<string>("session_live_cwd", { sessionId, fallback });
  } catch {
    return fallback;
  }
}

/** Servers are external processes with no event stream, so poll on a light
 *  interval; the caller only re-renders when the list changes. */
export function startServersPoll(refresh: () => void, intervalMs = 8000): ReturnType<typeof setInterval> {
  refresh();
  return setInterval(refresh, intervalMs);
}
