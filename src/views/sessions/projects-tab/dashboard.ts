// One mounted dashboard: owns its root element, the snapshot/history loads, and
// the event subscriptions that keep it live until the root leaves the DOM.
import { html, render, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { getTransport, type Unlisten } from "../../../shared/transport";
import { debounce } from "../../../shared/debounce";
import { hydrateProjectTechIcons } from "../../../shared/projects";
import { makeActions, type ActionHost } from "./dash-actions";
import { customCards } from "./dash-cards";
import { header, quickActions } from "./dash-header";
import { syncTrack } from "./quick-track";
import type { DashCtx } from "./dash-parts";
import { reports } from "./dash-reports";
import { chats } from "./dash-chats";
import { needsYou, nextUp, running, shipState, yourTodos } from "./dash-sections";
import type { DashboardHistory, DashboardTargetRef, DashSnapshot } from "./types";

import "./pd-dashboard.css";
import "./pd-cards.css";

export interface DashboardDeps {
  pane: HTMLElement;
  /** Leave the dashboard because a chat is about to take the pane. */
  flipToChats(): void;
  /** Refetch the Projects list (a group was edited). */
  reloadList(): void;
  /** The shown target no longer exists (deleted group). */
  deselect(): void;
}

export interface DashboardHandle {
  root: HTMLElement;
  /** Refetch now, bypassing the debounce. */
  refresh(): void;
  destroy(): void;
}

// Everything that can change what a dashboard shows. instances-changed covers
// chat status, the other three are the dashboard's own stores.
const LIVE_EVENTS = ["instances-changed", "user-todos-changed", "message-drafts-changed", "dashboard-changed"];
const REFETCH_DEBOUNCE_MS = 400;
// History mining is the expensive call, so a burst of events never repeats it inside this window.
const HISTORY_MIN_INTERVAL_MS = 15_000;

export function dashboardTemplate(c: DashCtx): TemplateResult {
  return html`${header(c)}${quickActions(c)}
    <div class="pd-grid">
      ${needsYou(c)}${yourTodos(c)}${chats(c)}${nextUp(c)}${shipState(c)}${running(c)}${customCards(c)}${reports(c)}
    </div>`;
}

export function mountDashboard(ref: DashboardTargetRef, deps: DashboardDeps): DashboardHandle {
  const root = document.createElement("div");
  root.className = "pd-root";
  root.dataset.pdTarget = `${ref.kind}:${ref.id}`;

  let ctx: DashCtx | null = null;
  let destroyed = false;
  let snapSeq = 0;
  let historyAt = 0;
  let galleryRunning = false;
  const unlisteners: Unlisten[] = [];

  const paint = (): void => {
    if (destroyed) return;
    if (!ctx) { render(html`<div class="pd-quiet pd-loading">Loading...</div>`, root); return; }
    ctx.nowMs = Date.now();
    render(dashboardTemplate(ctx), root);
    void hydrateProjectTechIcons(root);
    syncQuickActions();
    for (const hook of [...ctx.paintHooks]) hook();
  };

  // The chip track's page boundaries depend on measured widths, so they are
  // re-derived after every paint and whenever the window resizes.
  const syncQuickActions = (): void => {
    const qa = root.querySelector<HTMLElement>(".pd-qa");
    if (qa && ctx) ctx.qaStart = syncTrack(qa, ctx.qaStart);
  };
  const onResize = (): void => syncQuickActions();
  window.addEventListener("resize", onResize);

  const loadGallery = async (): Promise<void> => {
    if (galleryRunning || !ctx?.history) return;
    galleryRunning = true;
    try {
      for (const g of ctx.history.gallery) {
        if (destroyed || !ctx) return;
        if (ctx.images.has(g.id)) continue;
        try { ctx.images.set(g.id, await invoke<string>("dashboard_gallery_image", { id: g.id })); }
        catch { ctx?.images.set(g.id, "failed"); }
        paint();
      }
    } finally { galleryRunning = false; }
  };

  const loadHistory = async (): Promise<void> => {
    historyAt = Date.now();
    try {
      const h = await invoke<DashboardHistory>("dashboard_history", { target: ref });
      if (destroyed || !ctx) return;
      ctx.history = h;
      paint();
      if (ctx.tab === "gallery") void loadGallery();
    } catch (err) { console.warn("[projects-tab] dashboard_history failed", err); }
  };

  const host: ActionHost = {
    ctx: () => ctx!,
    pane: () => deps.pane,
    flipToChats: deps.flipToChats,
    patch: (fn) => { if (ctx && !destroyed) { fn(ctx); paint(); } },
    reload: () => { deps.reloadList(); void loadSnapshot(); },
    deselect: deps.deselect,
    loadGallery: () => { void loadGallery(); },
  };

  async function loadSnapshot(): Promise<void> {
    const mine = ++snapSeq;
    try {
      const snap = await invoke<DashSnapshot>("dashboard_snapshot", { target: ref });
      if (destroyed || mine !== snapSeq) return;
      const first = !ctx;
      if (!ctx) {
        ctx = {
          snap, history: null, repo: null, tab: "outcomes", images: new Map(), refreshing: new Set(),
          doneTodos: new Set(), pages: new Map(), chatsTab: "current", qaStart: 0, paintHooks: new Set(),
          nowMs: Date.now(), act: makeActions(host),
        };
      } else {
        ctx.snap = snap;
        // Keep a checked-off mark only while the todo is still in the snapshot (write in flight).
        const open = new Set(snap.your_todos.map((t) => t.id));
        ctx.doneTodos = new Set([...ctx.doneTodos].filter((id) => open.has(id)));
        if (ctx.repo && !snap.target.repos.some((r) => r.cwd === ctx!.repo)) ctx.repo = null;
      }
      paint();
      if (first || Date.now() - historyAt > HISTORY_MIN_INTERVAL_MS) void loadHistory();
    } catch (err) {
      console.error("[projects-tab] dashboard_snapshot failed", err);
      if (!destroyed && !ctx) render(html`<div class="pd-quiet pd-loading">Could not load this dashboard.</div>`, root);
    }
  }

  const refetch = debounce(() => {
    if (destroyed) return;
    if (!root.isConnected) { destroy(); return; }
    void loadSnapshot();
  }, REFETCH_DEBOUNCE_MS);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    refetch.cancel();
    window.removeEventListener("resize", onResize);
    for (const u of unlisteners.splice(0)) { try { u(); } catch { /* already gone */ } }
    root.remove();
  }

  for (const name of LIVE_EVENTS) {
    void getTransport().listen(name, () => refetch()).then((u) => {
      if (destroyed) u(); else unlisteners.push(u);
    });
  }

  paint();
  void loadSnapshot();

  return { root, refresh: () => void loadSnapshot(), destroy };
}
