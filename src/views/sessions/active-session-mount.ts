// Mount helpers extracted from active-session.ts's `selectSession` (ai_todo 182):
// statusbar + renderer mounting. The composer half moved to
// active-session-composer.ts (ai_todo 485) once this file crossed the
// frontend view size budget.

import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { setFileEditsProvider } from "../../shared/chat/file-viewer";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import type { Instance } from "../../types/ipc.generated";
import { state } from "./state";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero } from "./session-statusbar";
import { readLastChoice, readPresets } from "../../shared/effort-presets";
import { renderSidebar } from "./sidebar";
import { ChangesPanel, dedupeByPath } from "./changes-panel";
import type { SessionHeader } from "./session-header";
import { setThinkingActivity, setThinkingProgress, setThinkingTodoActivity } from "./session-thinking-bar";
import { completeHandoff } from "./handoff";
import {
  takeRetainedChat,
  retainChat,
  isRetainedRenderer,
  restoreRetainedScroll,
  type RetainedChat,
} from "./chat-pane-cache";

/** Mount the statusbar for the session pane. Returns null if the host slot
 * isn't in the DOM (shouldn't happen given the pane skeleton, but mirrors the
 * original guard). Sets `state.statusbar` itself so renderer wiring (which
 * runs right after) can read it off state, same as before extraction. */
export async function mountStatusbar(
  pane: HTMLElement,
  sess: Instance,
  onAccountClick: () => void,
): Promise<SessionStatusbar | null> {
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (!sbHost) return null;
  // Both read the same in-memory settings blob; awaiting them in series put two
  // avoidable IPC round-trips in front of every chat open.
  const [rows, hideZero] = await Promise.all([loadStatuslineRows(), loadStatuslineHideZero()]);
  let effortDisplay = sess.effort ?? "";
  if (!effortDisplay && sess.kind === "external" && sess.cwd) {
    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      const last = readLastChoice(settings, String(sess.cwd));
      const normal = readPresets(settings).find((p) => p.name === "Normal");
      effortDisplay = last?.effort ?? normal?.effort ?? "";
    } catch { /* leave blank */ }
  }
  const sb = new SessionStatusbar(sbHost, sess.started_at, rows, {
    cwd: sess.cwd ? String(sess.cwd) : null,
    effort: effortDisplay,
    sessionId: sess.session_id,
    readOnly: sess.kind === "external",
    sessionModel: sess.model || null,
    hideZero,
    accountId: sess.account_id ?? null,
    onAccountClick,
  });
  state.statusbar = sb;
  // Git info is owned by the statusbar itself: it resolves the session's live
  // cwd (which may follow the AI into a worktree) via `session_live_cwd`, then
  // fetches against that. Fetching here too would race and clobber it with the
  // spawn-cwd branch.
  return sb;
}

/** Point the visible chrome (statusbar, changes panel, thinking bar, CTAs) at
 *  `renderer`. Shared by the cold mount, the retained-pane remount and draft
 *  promotion. Retained renderers stay subscribed off-screen, so every shared-chrome
 *  callback checks it is still the visible one - else a background turn drives it. */
export function wireRenderer(
  pane: HTMLElement,
  sess: Instance,
  header: SessionHeader,
  sessionId: string,
  renderer: ChatRenderer,
  panel: ChangesPanel,
): void {
  state.renderer = renderer;
  state.changesPanel = panel;
  const sb = state.statusbar;
  if (sb) {
    renderer.onMetaUpdate = (meta) => {
      if (state.statusbar === sb) sb.updateMeta(meta);
    };
    renderer.onToolTally = (t) => {
      if (state.statusbar === sb) sb.updateToolTally(t);
    };
    // Tool-chip popovers reuse the in-chat custom views (Read/File Changes/
    // Skills/Questions), built from this renderer's messages.
    sb.setToolViewProvider((tool) => renderer.customToolView(tool));
    // Reopened chat: surface its already-accrued meta + tool counts immediately.
    // Only push meta a renderer actually has - updateMeta writes through to
    // metaCache, so a fresh renderer's zeros would clobber the cached chips.
    sb.updateToolTally(renderer.toolTally);
    const known = renderer.getMeta();
    if (known.hasUsage || known.model) sb.updateMeta(known);
  }
  panel.mount(pane, renderer.container);
  renderer.onFileEditsChanged = (edits) => {
    panel.onUpdate(edits);
    header.setChangesBadge(dedupeByPath(edits).length);
  };
  // Let the file viewer's Diff tab resolve this session's edits for any file.
  setFileEditsProvider(() => renderer.getFileEdits());
  // Let the PR-preview modal's git IPC calls (get_range_files/get_file_diff)
  // resolve this session's working directory.
  setPrReviewCwdProvider(() => (sess.cwd ? String(sess.cwd) : null));
  renderer.onActivityUpdate = (activity) => {
    if (state.renderer === renderer) setThinkingActivity(activity);
  };
  renderer.onProgressUpdate = (n, m) => {
    if (state.renderer === renderer) setThinkingProgress(n, m);
  };
  renderer.onTodoActivityUpdate = (activeForm) => {
    if (state.renderer === renderer) setThinkingTodoActivity(activeForm);
  };
  renderer.onNextAiPromptDone = () => {
    if (state.renderer !== renderer) return;
    renderer.injectCta("pickup");
  };
  renderer.onHandoffReady = () => {
    if (state.renderer !== renderer) return;
    if (state.selectedId !== sessionId) return;
    void completeHandoff(sessionId);
  };
  // NOTE: the sidebar/header question flag is NOT derived here anymore. The
  // renderer's marker detection only ever ran for the OPEN chat, so it went
  // stale the moment a session was backgrounded (a later turn's "done" never
  // cleared an old "question", and vice versa), and it fired on intermediate
  // markers mid-turn. The registry's `awaiting` (set by the daemon from the
  // result line, gen-guarded) is the single source of truth now - see
  // deriveQuestionSet in sessions-helpers.ts.
  header.onChangesClick = () => panel.toggle();
  // Expose the panel toggle through the state seam so view-more-menu and
  // sidebar-ctx-menu can offer "View changes" for the active session.
  state.activeChatActions = { viewChanges: () => panel.toggle() };
}

/** Re-show a cached chat: swap the pane's empty `.session-messages` for the
 *  retained element, re-point the chrome at the surviving renderer, drain what
 *  streamed in while off-screen. No replay, re-highlight, or loading overlay. */
function remountRetained(
  pane: HTMLElement,
  sess: Instance,
  header: SessionHeader,
  sessionId: string,
  hit: RetainedChat,
  slot: HTMLElement,
): void {
  const renderer = hit.renderer;
  slot.replaceWith(hit.messagesEl);
  // Self-heal: a cache hit only proves the pane/DOM survived, not that the
  // store subscription did (e.g. a rekey that ran before this fix, or any
  // future path that severs it). No-op when already correctly subscribed.
  renderer.ensureSubscribed(sessionId);
  const panel = new ChangesPanel();
  wireRenderer(pane, sess, header, sessionId, renderer, panel);
  renderer.resumeLiveRender();
  const edits = renderer.getFileEdits();
  panel.onUpdate(edits);
  header.setChangesBadge(dedupeByPath(edits).length);
  setThinkingActivity(renderer.lastActivity);
  restoreRetainedScroll(hit);
  void sessionEvents.reconcileLatest(sessionId, sess.cwd ? String(sess.cwd) : undefined);
}

/** Attach the ChatRenderer + all-changes panel, wire status/CTA callbacks,
 * load history, and reconcile against the live transcript. Owns the stall
 * guard (ai_todo 226: ring the loading overlay after 150ms, show a
 * "didn't respond" retry state after 8s if nothing settled - a wedged
 * backend used to leave the header floating over a blank pane forever with
 * no feedback). Returns `false` if a newer mount/selectSession superseded
 * this one mid-await (caller should stop and not proceed to mount the
 * composer), `true` otherwise. `onStalledRetry` is called if the user clicks
 * the stall banner's Retry button. */
export async function mountRenderer(
  pane: HTMLElement,
  sess: Instance,
  header: SessionHeader,
  sessionId: string,
  myMount: number,
  onStalledRetry: () => void,
): Promise<boolean> {
  // Never detach a renderer the pane cache still owns - it is the whole point
  // of the cache. Anything else (pending-pane renderer, evicted chat) is dead
  // the moment the pane's DOM is replaced.
  if (state.renderer && !isRetainedRenderer(state.renderer)) state.renderer.detach();
  state.changesPanel?.unmount();
  state.changesPanel = null;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return true;

  const hit = takeRetainedChat(sessionId);
  if (hit) {
    remountRetained(pane, sess, header, sessionId, hit, messagesEl);
    return true;
  }

  let loadSettled = false;
  const ringTimer = window.setTimeout(() => {
    if (!loadSettled) showChatLoadingOverlay(messagesEl);
  }, 150);
  const stallTimer = window.setTimeout(() => {
    if (loadSettled || state.mountId !== myMount || state.selectedId !== sessionId) return;
    // ai_todo 228 diagnostics: this guard times a purely local chain
    // (in-memory settings read + local transcript file read) - it is NOT
    // waiting on the daemon pipe. If this fires, the stall is in that local
    // chain (or an unhandled exception before it), not a pipe EOF.
    console.error(`[sessions] chat load stalled >8s (local settings/history read), session=${sessionId}`);
    messagesEl.querySelector(".chat-loading-overlay")?.remove();
    messagesEl.innerHTML =
      `<div class="session-empty session-empty--stalled chat-load-stalled">` +
      `<i class="ph ph-warning"></i>` +
      `<div>This chat isn't loading - the backend didn't respond.</div>` +
      `<button type="button" class="chat-load-retry">Retry</button>` +
      `</div>`;
    messagesEl.querySelector<HTMLButtonElement>(".chat-load-retry")?.addEventListener("click", onStalledRetry);
  }, 8000);
  const settleLoad = () => {
    loadSettled = true;
    window.clearTimeout(ringTimer);
    window.clearTimeout(stallTimer);
    messagesEl.querySelector(".chat-loading-overlay")?.remove();
  };

  const renderer = new ChatRenderer(messagesEl);
  // Panel listens for file mutations; activity feed routes to the thinking bar.
  wireRenderer(pane, sess, header, sessionId, renderer, new ChangesPanel());
  await renderer.attach(sessionId);
  // Bail if a newer mount or selectSession superseded us during await.
  if (state.mountId !== myMount || state.selectedId !== sessionId) {
    settleLoad();
    renderer.detach();
    return false;
  }
  // Pull from the shared event store. Cache hit = instant render with no
  // IPC. Cache miss triggers load_history_page under the hood (last 20
  // messages). Either way the store keeps the live `chat:<id>` listener
  // attached so events accrue even when this session isn't selected.
  const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
  try {
    // Only resume ticking if a turn is genuinely in flight right now - an
    // idle/awaiting-reply session has no closing user_message either, but
    // it isn't "still working".
    await renderer.loadFromStore(sess.cwd ? String(sess.cwd) : undefined, { resumeLiveTicking: sess.busy });
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      settleLoad();
      renderer.detach();
      return false;
    }
  } catch {
    /* tolerate absence */
  } finally {
    // Also clears the stall watchdog + 150ms ring timer.
    settleLoad();
    overlay?.remove();
  }
  // Self-heal against the lossy daemon->app notifier: a turn that completed
  // while this session was backgrounded may be missing from the cache even
  // though the sidebar marked it "done". Re-read the transcript tail and paint
  // anything the live channel dropped. Fire-and-forget so reopen stays instant;
  // recovered events arrive via the live subscriber path.
  void sessionEvents.reconcileLatest(sessionId, sess.cwd ? String(sess.cwd) : undefined);
  // Built and painted: hand this transcript to the pane cache so the next
  // switch back is an element swap instead of another full rebuild.
  retainChat(sessionId, renderer, messagesEl);
  // Sync sidebar once after replay (no per-event re-renders fired during it).
  const rootEl = document.querySelector<HTMLElement>(".view-sessions");
  const listAfterLoad = rootEl?.querySelector<HTMLElement>("#sessions-list");
  if (listAfterLoad) renderSidebar(listAfterLoad);
  return true;
}
