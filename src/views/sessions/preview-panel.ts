// Docked HTML preview panel (ai_todo 138, frontend chunk).
//
// The daemon owns one global preview timeline: terminal Claude (curl to
// `/hooks/preview`) and the in-app chat AI both push HTML snapshots to it,
// each snapshot tagged with the pushing session's `session_id`. This module
// renders that store — live latest + a history rail — as a dockable panel,
// but only for whichever chat is currently active: `setSessionScope` is
// called on every session switch (see state.ts's `setActiveSession`) and
// re-filters the fetched list client-side. A snapshot pushed with no
// session_id (e.g. an ad-hoc curl outside any chat) simply never matches any
// scope and won't appear — that's an accepted, unrequested-workaround-free
// consequence of scoping being per-chat now, not a bug.
//
// `renderPreview(root, { mode })` takes a `mode` so a future pop-out OS
// window can reuse this exact renderer (ai_todo 138's deferred follow-up);
// only `mode: "panel"` is wired up today, per the frontend-chunk scope.
//
// Live updates arrive two ways, per `project_daemon_notifier_broadcast_lossy`:
// a `preview` daemon-notifier broadcast (fast, but can be dropped under
// backpressure) AND an explicit `list_previews` refetch on panel open/window
// focus (authoritative, never skipped).

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { escapeHtml } from "../../shared/escape-html";
import { formatRelativeMinutes } from "../../shared/formatters";
import type { ChatEvent, ContentBlock, PreviewMeta, PreviewSnapshot } from "../../types/ipc.generated";
import { wireResizeHandle, MIN_WIDTH, MAX_WIDTH } from "./preview-panel-resize";
import { ComposerCore } from "../../shared/chat/composer-core/core";
import { SlashProvider } from "../../shared/chat/caret-popup/providers/slash";
import type { SuggestProvider } from "../../shared/chat/caret-popup/types";
import "../../shared/chat/caret-popup/popup.css";
import "../../shared/chat/composer.css";
import { sessionEvents } from "../../shared/chat/event-store";
import { showToast } from "../../shared/toast";
import { isCurrentSessionBusy } from "./session-thinking-bar";
import { state } from "./state";

export type PreviewMode = "panel" | "window";
type DeviceWidth = "desktop" | "tablet" | "phone";

export interface PreviewController {
  toggle(): void;
  open(snapshotId?: string): void;
  close(): void;
  isOpen(): boolean;
  /** Scopes the panel to one chat's previews, INCLUDING its open/closed
   *  state (each chat remembers its own independently); call on every
   *  active-session switch (see state.ts). Clears and re-fetches when the
   *  id changes. */
  setSessionScope(sessionId: string | null): void;
  destroy(): void;
}

// ── Persistence (dock-open + panel width — the real cross-reopen behavior
// per the spec; device-width and history-rail-open stay in-memory, same as
// the removed auto-refresh toggle used to). Open state is keyed per session
// id (Joe, 2026-08-01: opening the panel in one chat must not show it open
// in another) — same per-session-key shape as composer-persistence.ts's
// draftKey. Width stays a single global key; a dragged panel width isn't a
// per-chat preference. ──────────────────────────────────────────────────
const LS_OPEN_PREFIX = "cc_preview_panel_open:";
const LS_WIDTH_KEY = "cc_preview_panel_width";

function openKey(sessionId: string): string {
  return LS_OPEN_PREFIX + sessionId;
}

function loadOpen(sessionId: string): boolean {
  try {
    return localStorage.getItem(openKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function saveOpen(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(openKey(sessionId), open ? "1" : "0");
  } catch {
    /* quota or storage disabled */
  }
}

/** Explicit px width from a past manual drag, or null if the dev has never
 *  resized it - in which case the panel takes an even 50/50 flex split with
 *  the chat pane (Joe, 2026-07-20: "I want my view to be split into 2"), not
 *  a narrow fixed-px sidebar. Dragging the handle commits a fixed px width
 *  from then on, same as any split-pane. */
function loadWidth(): number | null {
  try {
    const raw = localStorage.getItem(LS_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    /* ignore */
  }
  return null;
}

function saveWidth(px: number): void {
  try {
    localStorage.setItem(LS_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

/** Past-tense relative time ("just now" / "5m ago" / "2h 3m ago") built on
 * the shared forward-looking h/m breakdown (`formatRelativeMinutes`) so the
 * math stays in one place; only the wording differs for a past timestamp. */
function agoText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  return formatRelativeMinutes(ms).replace(/^in /, "") + " ago";
}

function sourceDotClass(source: string): string {
  return source === "terminal" ? "pv-dot-terminal" : "pv-dot-chat";
}

/** AI-pushed HTML may be a bare fragment; wrap it in minimal boilerplate
 * before it becomes the iframe's data: URL document. */
function wrapFragmentIfNeeded(html: string): string {
  if (/<html[\s>]/i.test(html) || /<body[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

// Inner document CSP. Locked decision (Joe, 2026-06-26): do NOT hard-block
// network — a preview may legitimately fetch data. Left permissive on
// script/style/connect so "look-right rendering" (inline <script>, CDN
// fetches) isn't broken; the REAL isolation boundary is the iframe's
// `sandbox="allow-scripts"` with no `allow-same-origin` (opaque origin —
// scripts run but can't reach the parent DOM, storage, or IPC).
const INNER_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; font-src * data:;">`;

// Self-contained reporter injected into every pushed doc (see
// project_preview_panel_data_url_not_srcdoc: inline scripts have silently
// no-op'd in live WebView2, no repro outside it) - renders its own banner
// INSIDE the iframe DOM since parent postMessage can't be assumed to work.
const DIAGNOSTICS_HEAD_SCRIPT = `<script>(function(){
  window.__previewDiag = { bodyEndRan: false };
  function banner(text){
    var show = function(){
      var el = document.createElement("div");
      el.setAttribute("style","position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4a1420;color:#ffd7d7;font:12px/1.5 ui-monospace,Consolas,monospace;padding:8px 12px;white-space:pre-wrap;cursor:pointer;border-bottom:2px solid #ff6b6b;");
      el.textContent = "\\u26a0 preview diagnostic \\u2014 " + text + " (click to dismiss)";
      el.onclick = function(){ el.remove(); };
      document.body.prepend(el);
    };
    if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
  }
  window.onerror = function(msg, src, line, col, err){
    banner("script error: " + msg + " (" + (src || "inline") + ":" + line + ":" + col + ")");
  };
  window.addEventListener("unhandledrejection", function(e){
    banner("unhandled rejection: " + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  document.addEventListener("securitypolicyviolation", function(e){
    banner("CSP blocked " + e.violatedDirective + ": " + e.blockedURI);
  });
  setTimeout(function(){
    if (!window.__previewDiag.bodyEndRan) banner("trailing content never executed \\u2014 parsing likely stalled or was blocked before reaching the end of the document");
  }, 1500);
})();</script>`;

// Marks that parsing/execution reached the end of the document; the head
// script's timeout checks this flag to catch a total, error-free script
// no-op (the documented failure mode) rather than only catching exceptions.
const DIAGNOSTICS_BODY_END_SCRIPT = `<script>window.__previewDiag && (window.__previewDiag.bodyEndRan = true);</script>`;

/** Loaded via a `data:` URL, never `iframe.srcdoc`: a srcdoc document has no
 * navigation, so it inherits the app's CSP and can only intersect this meta,
 * never loosen it. A data: URL navigates into its own opaque origin, which
 * makes this meta the sole governing policy. */
function buildPreviewDocumentHtml(html: string): string {
  const wrapped = wrapFragmentIfNeeded(html);
  const withHead = /<head[^>]*>/i.test(wrapped)
    ? wrapped.replace(/<head[^>]*>/i, (m) => `${m}${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}`)
    : /<html[^>]*>/i.test(wrapped)
      ? wrapped.replace(/<html[^>]*>/i, (m) => `${m}<head>${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}</head>`)
      : `${INNER_CSP_META}${DIAGNOSTICS_HEAD_SCRIPT}${wrapped}`;
  return /<\/body>/i.test(withHead)
    ? withHead.replace(/<\/body>/i, `${DIAGNOSTICS_BODY_END_SCRIPT}</body>`)
    : `${withHead}${DIAGNOSTICS_BODY_END_SCRIPT}`;
}

class PreviewPanel implements PreviewController {
  private root: HTMLElement;
  private mode: PreviewMode;
  private snapshots: PreviewMeta[] = [];
  private selected: PreviewSnapshot | null = null;
  /** Full-html snapshots already fetched this session, keyed by id, so
   *  revisiting a chat (or a window-focus refetch) never re-invokes
   *  get_preview or rebuilds the iframe for content already seen. Pruned in
   *  refreshList to whatever ids the daemon's list still reports, so it can
   *  never outgrow the daemon-side MAX_HISTORY cap. */
  private snapshotCache = new Map<string, PreviewSnapshot>();
  private deviceWidth: DeviceWidth = "desktop";
  private openState: boolean;
  /** Explicit manually-dragged px width, or null for the default 50/50 flex
   *  split with the chat pane - see loadWidth's doc. */
  private width: number | null;
  /** Only previews pushed with this session_id are shown. Set by
   *  state.ts's setActiveSession on every chat switch; null before any
   *  chat is selected. */
  private currentSessionId: string | null = null;
  /** Ids already shown (or baselined) this window session - see
   *  `checkForUnseen`'s doc for why this exists. In-memory only, same
   *  don't-resurface-what-was-already-surfaced shape as main.ts's
   *  `seenMissedIds`. */
  private seenIds = new Set<string>();
  /** History rail visibility — in-memory only, defaults closed (Joe,
   *  2026-07-20: "for now let's make it so history tab can also be toggled
   *  on/off and by default its off"). */
  private historyOpen = false;
  private moreMenuOpen = false;
  private unlistenPreview: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;
  private resizeCleanup: (() => void) | null = null;
  /** Typing-experience core for the reply composer docked at the panel's
   *  bottom (ai_todo composer-unification) - the shared popup/highlight/
   *  auto-resize, not a reimplementation. Mounted once in the constructor:
   *  unlike the AUQ card, this panel's own DOM is never innerHTML-rebuilt
   *  (renderIframe/renderRail/renderHeader only touch their own sub-elements),
   *  so there's no per-render remount to do. */
  private composerCore: ComposerCore | null = null;
  private composerSlash: SlashProvider | null = null;

  constructor(root: HTMLElement, mode: PreviewMode) {
    this.root = root;
    this.mode = mode;
    this.width = loadWidth();
    // Open state is per-session (see LS_OPEN_PREFIX); unknown until
    // setSessionScope runs, which sessions.ts calls synchronously right
    // after construction - start closed so there's no flash of the wrong
    // chat's open state in between.
    this.openState = false;

    this.applyWidth();
    this.renderShell();
    this.mountComposer();
    this.wireEvents();
    this.resizeCleanup = wireResizeHandle(this.root, (px) => {
      this.width = px;
      saveWidth(px);
      this.applyWidth();
    });
    void this.subscribeLive();

    this.focusHandler = () => {
      if (this.openState) void this.refreshList();
      else void this.checkForUnseen();
    };
    window.addEventListener("focus", this.focusHandler);

    this.root.hidden = true;
    this.renderHeaderEmpty();
    this.renderCanvasEmpty();
  }

  /** Sets the flex sizing on the host element (`this.root`, the actual flex
   *  item inside `.sessions-layout`, sibling to `.session-pane`): an even
   *  50/50 split by default (`flex: 1 1 0%`, matching `.session-pane`'s own
   *  `flex: 1`), or a fixed px width once the dev has dragged the resize
   *  handle (`flex: 0 0 <px>px`). The inner `.preview-panel` div just fills
   *  whatever width this resolves to (width/height 100%). */
  private applyWidth(): void {
    this.root.style.flex = this.width === null ? "1 1 0%" : `0 0 ${this.width}px`;
  }

  // ── Public controller API ────────────────────────────────────────────────

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  open(snapshotId?: string): void {
    this.openState = true;
    if (this.currentSessionId) saveOpen(this.currentSessionId, true);
    this.root.hidden = false;
    void this.refreshList(snapshotId ? { selectId: snapshotId } : {});
  }

  close(): void {
    this.openState = false;
    if (this.currentSessionId) saveOpen(this.currentSessionId, false);
    this.root.hidden = true;
  }

  isOpen(): boolean {
    return this.openState;
  }

  setSessionScope(sessionId: string | null): void {
    if (this.currentSessionId === sessionId) return;
    this.currentSessionId = sessionId;
    // Each chat's open/closed state is independent (loadOpen defaults false
    // for an id with no saved key yet, e.g. one that's never had the panel
    // opened) - re-derive from THIS chat's key, never carry over the
    // previous chat's this.openState.
    if (sessionId && loadOpen(sessionId)) {
      this.openState = true;
      this.root.hidden = false;
      void this.refreshList();
    } else {
      this.openState = false;
      this.root.hidden = true;
      // Drop the stale cross-chat cache so a later open() never flashes the
      // previous chat's snapshots before the fresh fetch lands.
      this.snapshots = [];
      this.selected = null;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
      // Baseline only - the chat just switched into may already have older
      // previews; those shouldn't force-open the panel, only a push that
      // arrives *after* this baseline should (see checkForUnseen doc).
      void this.checkForUnseen({ allowOpen: false });
    }
  }

  destroy(): void {
    if (this.unlistenPreview) {
      try { this.unlistenPreview(); } catch { /* ignore */ }
      this.unlistenPreview = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
    if (this.resizeCleanup) { this.resizeCleanup(); this.resizeCleanup = null; }
    this.composerCore?.destroy();
    this.composerCore = null;
    this.composerSlash?.stop();
    this.composerSlash = null;
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  /** Authoritative fallback for the lossy `preview` notifier broadcast (see
   *  class docs): `onLivePush` is the fast path, but a dropped broadcast
   *  packet must never silently swallow a preview Claude just pushed for the
   *  active chat. Called on every window focus while the panel is closed
   *  (and once at mount / on every session-scope change, with `allowOpen:
   *  false`, purely to baseline `seenIds` so pre-existing history never
   *  spuriously pops the panel). Finds any snapshot in the current chat's
   *  scope not yet in `seenIds` and, if allowed, opens the panel on it -
   *  exactly what `onLivePush` does for the fast path. */
  private async checkForUnseen(opts: { allowOpen: boolean } = { allowOpen: true }): Promise<void> {
    if (!this.currentSessionId) return;
    let all: PreviewMeta[];
    try {
      all = await invoke<PreviewMeta[]>("list_previews");
    } catch (err) {
      console.error("[preview-panel] checkForUnseen failed", err);
      return;
    }
    const scoped = (Array.isArray(all) ? all : []).filter((m) => m.session_id === this.currentSessionId);
    const unseen = scoped.filter((m) => !this.seenIds.has(m.id));
    scoped.forEach((m) => this.seenIds.add(m.id));
    const mostRecentUnseen = unseen[unseen.length - 1];
    if (opts.allowOpen && mostRecentUnseen && !this.openState) {
      this.open(mostRecentUnseen.id);
    }
  }

  private async refreshList(opts: { selectId?: string } = {}): Promise<void> {
    try {
      const list = await invoke<PreviewMeta[]>("list_previews");
      const all = Array.isArray(list) ? list : [];
      this.snapshots = all.filter((m) => m.session_id === this.currentSessionId);
      this.snapshots.forEach((s) => this.seenIds.add(s.id));
      const validIds = new Set(all.map((m) => m.id));
      for (const id of this.snapshotCache.keys()) {
        if (!validIds.has(id)) this.snapshotCache.delete(id);
      }
    } catch (err) {
      console.error("[preview-panel] list_previews failed", err);
    }
    this.renderRail();

    const first = this.snapshots[0];
    if (!first) {
      this.selected = null;
      this.renderHeaderEmpty();
      this.renderCanvasEmpty();
      return;
    }
    const targetId = opts.selectId ?? this.selected?.id ?? first.id;
    const stillExists = this.snapshots.some((s) => s.id === targetId);
    await this.selectSnapshot(stillExists ? targetId : first.id);
  }

  private async selectSnapshot(id: string): Promise<void> {
    // Already the exact snapshot on screen (same id + version) — a
    // window-focus refetch or a re-scope back to a chat whose top snapshot
    // hasn't changed. Skip the round-trip and the iframe rebuild entirely so
    // switching chats doesn't re-execute the previewed HTML's scripts.
    const meta = this.snapshots.find((s) => s.id === id);
    if (this.selected?.id === id && (!meta || meta.version === this.selected.version)) {
      return;
    }
    const cached = this.snapshotCache.get(id);
    if (cached && meta && cached.version === meta.version) {
      this.selected = cached;
    } else {
      try {
        this.selected = await invoke<PreviewSnapshot>("get_preview", { id });
      } catch (err) {
        console.error("[preview-panel] get_preview failed", err);
        return;
      }
      this.snapshotCache.set(id, this.selected);
    }
    this.renderHeader();
    this.renderIframe();
    this.renderRail();
  }

  /** `preview` notifier broadcast handler. Always opens the panel for the
   * active chat's push (Joe, 2026-07-20: no opt-out on auto-refresh). A push
   * for a background chat never switches the view (Joe, 2026-08-03: never
   * force-switch) - it only flags that chat's own open state for next time. */
  private onLivePush(meta: PreviewMeta | undefined): void {
    if (!meta) return;
    if (meta.session_id !== this.currentSessionId) {
      if (meta.session_id) saveOpen(meta.session_id, true);
      return;
    }
    this.seenIds.add(meta.id);

    const idx = this.snapshots.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.snapshots[idx] = meta;
    else this.snapshots.unshift(meta);

    if (!this.openState) {
      this.open(meta.id);
      return;
    }
    this.renderRail();
    void this.selectSnapshot(meta.id);
  }

  private async subscribeLive(): Promise<void> {
    try {
      this.unlistenPreview = await getTransport().listen<{ snapshot: PreviewMeta }>(
        "preview",
        (payload) => this.onLivePush(payload?.snapshot),
      );
    } catch (err) {
      console.warn("[preview-panel] listen(preview) failed", err);
    }
  }

  // ── Reply composer ───────────────────────────────────────────────────────
  // Docked at the bottom of the panel (ai_todo composer-unification): the
  // shared typing core (popup/highlight/auto-resize), not a reimplementation.
  // Voice/PTT/schedule/builtins are main-composer-only and don't apply here.

  private mountComposer(): void {
    const ta = this.root.querySelector<HTMLTextAreaElement>(".pv-composer-input");
    const highlightEl = this.root.querySelector<HTMLElement>(".pv-composer .composer-highlight");
    const sendBtn = this.root.querySelector<HTMLButtonElement>(".pv-composer-send");
    if (!ta) return;
    this.composerSlash = new SlashProvider();
    // No single cwd concept for this panel (it's scoped by session, not a
    // project directory) - null still surfaces user/builtin skills, same as
    // Composer's own SlashProvider.start(null) fallback.
    void this.composerSlash.start(null);
    this.composerCore = new ComposerCore({
      textarea: ta,
      highlightEl,
      providers: [this.composerSlash] as unknown as SuggestProvider<unknown>[],
      onInput: () => {
        if (sendBtn) sendBtn.disabled = ta.value.trim().length === 0;
      },
      onEnter: () => void this.sendToOwningSession(),
    });
    sendBtn?.addEventListener("click", () => void this.sendToOwningSession());
  }

  /** Sends the composer's draft to whichever session pushed the
   *  currently-viewed snapshot, tagged with a reference to it. That session
   *  is always the active pane (this panel is scoped to it via
   *  setSessionScope), so busy/held semantics reuse the SAME
   *  state.heldMessages controller the main composer uses - not
   *  reimplemented here. */
  private async sendToOwningSession(): Promise<void> {
    const ta = this.root.querySelector<HTMLTextAreaElement>(".pv-composer-input");
    const snap = this.selected;
    if (!ta || !snap) return;
    const text = ta.value.trim();
    if (!text) return;
    const sessionId = snap.session_id;
    if (!sessionId) {
      showToast("This preview has no owning session to reply to.");
      return;
    }
    const inst = state.sessions.find((s) => s.session_id === sessionId);
    if (!inst) {
      showToast("Session no longer available.");
      return;
    }
    const label = snap.title || snap.slug;
    const tag = `[re: preview v${snap.version}${label ? ` - ${label}` : ""}]`;
    const blocks: ContentBlock[] = [{ type: "text", text: `${tag}\n${text}` }];

    ta.value = "";
    this.composerCore?.autoResize();
    this.composerCore?.updateHighlight();
    const sendBtn = this.root.querySelector<HTMLButtonElement>(".pv-composer-send");
    if (sendBtn) sendBtn.disabled = true;

    if (isCurrentSessionBusy()) {
      state.heldMessages?.stage(blocks);
      return;
    }
    if (state.heldMessages?.hasItemsForActive()) {
      void state.heldMessages.flushHeldWithDraft(blocks);
      return;
    }

    const optimisticEvent = {
      type: "user_message",
      content: blocks,
      timestamp: BigInt(Date.now()),
    } as ChatEvent;
    sessionEvents.pushSynthetic(sessionId, optimisticEvent);
    try {
      await invoke<string>("send_message", { sessionId, cwd: String(inst.cwd ?? "."), blocks });
    } catch (err) {
      console.error("[preview-panel] send_message failed", err);
      sessionEvents.removeSynthetic(sessionId, optimisticEvent);
      ta.value = text;
      this.composerCore?.autoResize();
      this.composerCore?.updateHighlight();
      showToast(`Send failed: ${err}`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private openInBrowser(): void {
    if (!this.selected) return;
    // Windows' ShellExecuteW has no protocol handler for data: URLs, so we
    // write a real temp .html file and open that path instead.
    void (async () => {
      try {
        const path = await invoke<string>("write_temp_html", { html: this.selected!.html });
        await invoke("open_external", { url: path });
      } catch (err) {
        console.error("[preview-panel] open_external failed", err);
      }
    })();
  }

  private setDeviceWidth(w: DeviceWidth): void {
    this.deviceWidth = w;
    this.root.querySelectorAll<HTMLElement>(".pv-seg-btn").forEach((b) => {
      b.classList.toggle("on", b.dataset.w === w);
    });
    const frame = this.root.querySelector<HTMLElement>(".pv-frame");
    if (frame) frame.dataset.w = w;
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    const rail = this.root.querySelector<HTMLElement>("[data-rail]");
    if (rail) rail.hidden = !this.historyOpen;
    const item = this.root.querySelector<HTMLElement>('.pv-more-item[data-act="history"]');
    if (item) item.classList.toggle("on", this.historyOpen);
  }

  private toggleMoreMenu(): void {
    this.moreMenuOpen = !this.moreMenuOpen;
    this.renderMoreMenuState();
  }

  private closeMoreMenu(): void {
    if (!this.moreMenuOpen) return;
    this.moreMenuOpen = false;
    this.renderMoreMenuState();
  }

  private renderMoreMenuState(): void {
    const menu = this.root.querySelector<HTMLElement>(".pv-more-menu");
    if (menu) menu.hidden = !this.moreMenuOpen;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="preview-panel" data-mode="${this.mode}">
        <div class="pv-resize-handle" data-resize title="Drag to resize"></div>
        <header class="pv-head">
          <span class="pv-title"><i class="ph ph-monitor-play"></i><span class="pv-name">No previews yet</span><span class="pv-ver"></span></span>
          <span class="pv-grow"></span>
          <div class="pv-more-wrap">
            <button type="button" class="pv-icon-btn" data-act="more" title="More options"><i class="ph ph-dots-three-vertical"></i></button>
            <div class="pv-more-menu" hidden>
              <button type="button" class="pv-more-item" data-act="refresh"><i class="ph ph-arrow-clockwise"></i>Refresh</button>
              <button type="button" class="pv-more-item" data-act="open-browser"><i class="ph ph-arrow-square-out"></i>Open in browser</button>
              <button type="button" class="pv-more-item" data-act="history"><i class="ph ph-clock-counter-clockwise"></i>Show history</button>
              <div class="pv-more-sep"></div>
              <div class="pv-more-label">Toggle size</div>
              <button type="button" class="pv-seg-btn on" data-w="desktop"><i class="ph ph-monitor"></i>Desktop</button>
              <button type="button" class="pv-seg-btn" data-w="tablet"><i class="ph ph-device-tablet"></i>Tablet</button>
              <button type="button" class="pv-seg-btn" data-w="phone"><i class="ph ph-device-mobile"></i>Phone</button>
              <div class="pv-more-sep"></div>
              <button type="button" class="pv-more-item" data-act="popout" disabled><i class="ph ph-arrows-out-simple"></i>Pop-out window (coming soon)</button>
            </div>
          </div>
          <button type="button" class="pv-icon-btn" data-act="close" title="Close panel"><i class="ph ph-x"></i></button>
        </header>
        <div class="pv-body">
          <div class="pv-rail" data-rail hidden><div class="pv-rail-lbl">History</div></div>
          <div class="pv-canvas"></div>
        </div>
        <div class="pv-composer">
          <div class="composer-input-wrap">
            <div class="composer-highlight" aria-hidden="true"></div>
            <textarea class="composer-textarea pv-composer-input" rows="1" placeholder="Message the session that pushed this preview..."></textarea>
          </div>
          <button type="button" class="pv-composer-send icon-btn" title="Send" disabled>
            <i class="ph ph-paper-plane-right"></i>
          </button>
        </div>
      </div>
    `;
    this.renderCanvasEmpty();
  }

  private renderHeader(): void {
    if (!this.selected) return;
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    if (nameEl) nameEl.textContent = this.selected.slug;
    if (verEl) verEl.textContent = ` · v${this.selected.version}`;
  }

  private renderHeaderEmpty(): void {
    const nameEl = this.root.querySelector<HTMLElement>(".pv-name");
    const verEl = this.root.querySelector<HTMLElement>(".pv-ver");
    if (nameEl) nameEl.textContent = "No previews yet";
    if (verEl) verEl.textContent = "";
  }

  private renderIframe(): void {
    if (!this.selected) return;
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `<div class="pv-frame" data-w="${this.deviceWidth}"><iframe class="pv-iframe" sandbox="allow-scripts"></iframe></div>`;
    const iframe = canvas.querySelector<HTMLIFrameElement>(".pv-iframe");
    // data: src (not .srcdoc) — see buildPreviewDocumentHtml's doc for why.
    if (iframe) {
      iframe.src = "data:text/html;charset=utf-8," + encodeURIComponent(buildPreviewDocumentHtml(this.selected.html));
    }
  }

  private renderCanvasEmpty(): void {
    const canvas = this.root.querySelector<HTMLElement>(".pv-canvas");
    if (!canvas) return;
    canvas.innerHTML = `
      <div class="pv-empty">
        <i class="ph ph-monitor-play"></i>
        <p>No previews yet</p>
        <p class="pv-empty-hint">Push one via <code>/preview</code>, or ask the chat AI to show you something.</p>
      </div>
    `;
  }

  private renderRail(): void {
    const rail = this.root.querySelector<HTMLElement>("[data-rail]");
    if (!rail) return;
    if (this.snapshots.length === 0) {
      rail.innerHTML = `<div class="pv-rail-lbl">History</div>`;
      return;
    }
    const liveId = this.snapshots[0]?.id;
    const rows = this.snapshots.map((s) => {
      const sel = this.selected?.id === s.id ? " sel" : "";
      const liveTag = s.id === liveId ? ` <span class="pv-live-tag">LIVE</span>` : "";
      return `<div class="pv-snap${sel}" data-id="${escapeHtml(s.id)}">
        <div class="pv-snap-title">${escapeHtml(s.title || s.slug)}${liveTag}</div>
        <div class="pv-snap-meta"><span class="pv-dot ${sourceDotClass(s.source)}"></span>v${s.version} · ${agoText(s.created_at)}</div>
      </div>`;
    }).join("");
    rail.innerHTML = `<div class="pv-rail-lbl">History</div>${rows}`;
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  private wireEvents(): void {
    this.root.addEventListener("click", (e) => this.onClick(e));
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    const actBtn = target.closest<HTMLElement>("[data-act]");
    if (actBtn) {
      switch (actBtn.dataset.act) {
        case "refresh": void this.refreshList(); this.closeMoreMenu(); return;
        case "open-browser": this.openInBrowser(); this.closeMoreMenu(); return;
        case "history": this.toggleHistory(); this.closeMoreMenu(); return;
        case "more": this.toggleMoreMenu(); return;
        case "close": this.close(); return;
        default: return; // "popout" is disabled (deferred pop-out window)
      }
    }

    const segBtn = target.closest<HTMLElement>(".pv-seg-btn");
    if (segBtn?.dataset.w) {
      this.setDeviceWidth(segBtn.dataset.w as DeviceWidth);
      this.closeMoreMenu();
      return;
    }

    const snap = target.closest<HTMLElement>(".pv-snap");
    if (snap?.dataset.id) {
      void this.selectSnapshot(snap.dataset.id);
      return;
    }

    if (!target.closest(".pv-more-wrap")) this.closeMoreMenu();
  }
}

/**
 * Shared preview renderer. `mode: "panel"` is the only wired-up variant today
 * (docked sibling of `.session-pane`); `"window"` is reserved for the
 * deferred pop-out OS window follow-up so that surface can mount this exact
 * component later with zero renderer changes.
 */
export function renderPreview(root: HTMLElement, opts: { mode: PreviewMode }): PreviewController {
  return new PreviewPanel(root, opts.mode);
}
