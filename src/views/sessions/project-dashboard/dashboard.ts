// One mounted dashboard: owns its root element and its chip row, the
// snapshot/history loads, and the event subscriptions that keep it live until
// the root leaves the DOM. Shown inside a new-chat draft (draft-dashboard.ts)
// or as a page of its own (dashboard-page.ts).
import { html, nothing, render, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { getTransport, type Unlisten } from "../../../shared/transport";
import { debounce } from "../../../shared/debounce";
import { hydrateProjectTechIcons } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { showToast } from "../../../shared/toast";
import { loadTokenHistory } from "../../../shared/token-history";
import type { AliasMap } from "../../../shared/tokens";
import { makeActions, type ActionHost } from "./dash-actions";
import { customCards } from "./dash-cards";
import { header, quickActions } from "./dash-header";
import { syncEdges } from "./quick-track";
import type { DashCtx, DashMode } from "./dash-parts";
import { reportsBar } from "./dash-reports";
import { usage, type UsageRange } from "./dash-usage";
import { todoChart } from "./dash-todo-chart";
import { openContextMenu } from "./dash-menu";
import { chats } from "./dash-chats";
import { nextUp, running, shipState, yourTodos } from "./dash-sections";
import { assignColumns, naturalHeight } from "../../../shared/balance";
import { cardRefreshSecs, staleCardIds } from "./format";
import type { CardResult, DashboardHistory, DashboardTargetRef, DashSnapshot } from "./types";

import "./pd-dashboard.css";
import "./pd-cards.css";

export interface DashboardDeps {
  mode: DashMode;
  pane: HTMLElement;
  /** Leave the standalone page because a chat is about to take the pane. No-op in a draft. */
  leave(): void;
  /** Leave the standalone page for the chat open before it. No-op in a draft. */
  back(): void;
  /** The shown target no longer exists (deleted group). */
  deselect(): void;
}

export interface DashboardHandle {
  root: HTMLElement;
  /** The quick-action chip row; the caller places it (above a draft's message box, under the page). */
  chips: HTMLElement;
  /** Refetch now, bypassing the debounce. */
  refresh(): void;
  destroy(): void;
}

// Everything that can change what a dashboard shows. instances-changed covers
// chat status, the other three are the dashboard's own stores.
const LIVE_EVENTS = ["instances-changed", "user-todos-changed", "dashboard-changed"];
const REFETCH_DEBOUNCE_MS = 400;
const RESIZE_DEBOUNCE_MS = 100;
// History mining is the expensive call, so a burst of events never repeats it inside this window.
const HISTORY_MIN_INTERVAL_MS = 15_000;
// How often an open dashboard re-checks its custom cards for a result past its refresh interval.
const CARD_STALE_CHECK_MS = 60_000;

interface Section { id: string, body: TemplateResult | typeof nothing }

/** The half-width sections, in reading order; hidden ones drop out. */
function halfSections(c: DashCtx): Section[] {
  const all: Section[] = [
    { id: "next_up", body: nextUp(c) },
    { id: "ship", body: shipState(c) },
    { id: "usage", body: usage(c, (getSettings()?.projectAliases ?? {}) as AliasMap) },
    { id: "todo_chart", body: todoChart(c) },
    ...customCards(c),
  ];
  return all.filter((s) => s.body !== nothing);
}

export function dashboardTemplate(c: DashCtx): TemplateResult {
  // Until a paint has measured them, sections alternate columns.
  const halves = halfSections(c);
  // rebalance() needs the reading order, which the two-column DOM no longer shows.
  c.halfOrder = halves.map((s) => s.id);
  const col = (n: 0 | 1): Array<TemplateResult | typeof nothing> =>
    halves.filter((s, i) => (c.columns.get(s.id) ?? i % 2) === n).map((s) => s.body);
  // Past results' links lead, then Chats (input-needed first, in red);
  // Running sits last since it is often empty. A draft has no header: the chat
  // header above it already names the project.
  return html`${c.mode === "page" ? header(c) : nothing}${reportsBar(c)}
    <div class="pd-top">${chats(c)}${yourTodos(c)}</div>
    <div class="pd-cols"><div class="pd-col">${col(0)}</div><div class="pd-col">${col(1)}</div></div>
    <div class="pd-bottom">${running(c)}</div>`;
}

const ONE_COLUMN = "(max-width: 900px)";

/** Re-places the half-width sections by measured height. True when the
 *  placement changed and the dashboard needs another paint. */
function rebalance(root: HTMLElement, c: DashCtx): boolean {
  const cols = root.querySelector<HTMLElement>(".pd-cols");
  if (!cols) return false;
  const secs = [...cols.querySelectorAll<HTMLElement>(".pd-col > [data-pd-card]")];
  const byId = new Map(secs.map((s) => [s.dataset.pdCard!, s]));
  const ids = c.halfOrder;
  // One column (narrow window): reading order, all in the first column.
  const narrow = window.matchMedia?.(ONE_COLUMN).matches ?? false;
  let next: Array<0 | 1>;
  if (narrow) next = ids.map((): 0 | 1 => 0);
  else {
    const heights = ids.map((id) => (byId.get(id) ? naturalHeight(byId.get(id)!) : 0));
    // Not laid out (a hidden pane, a detached root): every height reads 0,
    // which would pile everything into the left column. Keep the placement;
    // the root's ResizeObserver re-runs this once it is shown again.
    if (heights.every((h) => h === 0)) return false;
    next = assignColumns(heights);
  }
  let changed = false;
  ids.forEach((id, i) => {
    if (c.columns.get(id) !== next[i]) { c.columns.set(id, next[i]!); changed = true; }
  });
  return changed;
}

export function mountDashboard(ref: DashboardTargetRef, deps: DashboardDeps): DashboardHandle {
  const root = document.createElement("div");
  root.className = `pd-root is-${deps.mode}`;
  root.dataset.pdTarget = `${ref.kind}:${ref.id}`;
  const chips = document.createElement("div");
  chips.className = `pd-qa-host is-${deps.mode}`;

  let ctx: DashCtx | null = null;
  let destroyed = false;
  let snapSeq = 0;
  let historyAt = 0;
  let galleryRunning = false;
  const unlisteners: Unlisten[] = [];

  const paint = (): void => {
    if (destroyed) return;
    // A draft stays empty until there is something to show: its message box is the point of the pane.
    if (!ctx) { render(deps.mode === "page" ? html`<div class="pd-quiet pd-loading">Loading...</div>` : nothing, root); return; }
    ctx.nowMs = Date.now();
    render(dashboardTemplate(ctx), root);
    render(quickActions(ctx, ctx.mode === "page"), chips);
    // A second render at most: the placement only depends on heights, which the move does not change.
    if (rebalance(root, ctx)) render(dashboardTemplate(ctx), root);
    void hydrateProjectTechIcons(root);
    void hydrateProjectTechIcons(chips);
    syncQuickActions();
    for (const hook of [...ctx.paintHooks]) hook();
  };

  // Whether the chip row overflows depends on measured widths, so its edge
  // fades are re-derived after every paint and whenever the root's size changes.
  const syncQuickActions = (): void => {
    const track = chips.querySelector<HTMLElement>(".pd-qa-track");
    if (track) syncEdges(track);
  };
  // Observing the root, not the window, also catches the pane being shown
  // again after a paint it was hidden for (rebalance skips unmeasured paints).
  const onResize = debounce((): void => { syncQuickActions(); if (ctx && rebalance(root, ctx)) paint(); }, RESIZE_DEBOUNCE_MS);
  const resizeObs = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => onResize());
  resizeObs?.observe(root);

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

  // Custom cards fetch themselves: one at a time, never a card the user is
  // already refreshing, and a card that failed to run is not retried until
  // its own interval has passed again (the failure itself is the result).
  let cardsRunning = false;
  const lastAutoRun = new Map<string, number>();
  const refreshStaleCards = async (): Promise<void> => {
    if (cardsRunning || !ctx) return;
    cardsRunning = true;
    try {
      for (const id of staleCardIds(ctx.snap.cards)) {
        if (destroyed || !ctx || !root.isConnected) return;
        if (ctx.refreshing.has(id)) continue;
        const cfg = ctx.snap.cards.find((v) => v.config.id === id)?.config;
        const tried = lastAutoRun.get(id);
        if (tried && Date.now() - tried < cardRefreshSecs(cfg?.refresh_secs) * 1000) continue;
        lastAutoRun.set(id, Date.now());
        ctx.refreshing.add(id);
        paint();
        try {
          const result = await invoke<CardResult>("dashboard_card_refresh", { id });
          const v = ctx?.snap.cards.find((x) => x.config.id === id);
          if (v && result) v.result = result;
        } catch (err) {
          console.warn("[project-dashboard] card auto-refresh failed", id, err);
        } finally {
          ctx?.refreshing.delete(id);
          paint();
        }
      }
    } finally { cardsRunning = false; }
  };
  // Also the dashboard's own sweeper: a draft or page torn down by a pane wipe
  // is noticed here even when no live event comes to trigger refetch's check.
  const staleTimer = window.setInterval(() => {
    if (!root.isConnected) { destroy(); return; }
    void refreshStaleCards();
  }, CARD_STALE_CHECK_MS);

  let usageSeq = 0;
  const loadUsage = (range: UsageRange): void => {
    const mine = ++usageSeq;
    // "All" is the one range past the default window, which is otherwise all the store loads.
    void loadTokenHistory(range === "all" ? 0 : undefined).then((records) => {
      if (destroyed || !ctx || mine !== usageSeq) return;
      ctx.usage.records = records;
      paint();
    });
  };

  const loadHistory = async (): Promise<void> => {
    historyAt = Date.now();
    try {
      const h = await invoke<DashboardHistory>("dashboard_history", { target: ref });
      if (destroyed || !ctx) return;
      ctx.history = h;
      ctx.historyFailed = false;
      paint();
      if (ctx.tab === "gallery") void loadGallery();
    } catch (err) {
      console.warn("[project-dashboard] dashboard_history failed", err);
      if (destroyed || !ctx || ctx.history) return;
      ctx.historyFailed = true;
      paint();
    }
  };

  const host: ActionHost = {
    ctx: () => ctx!,
    pane: () => deps.pane,
    leave: deps.leave,
    back: deps.back,
    patch: (fn) => { if (ctx && !destroyed) { fn(ctx); paint(); } },
    reload: () => { void loadSnapshot(); },
    deselect: deps.deselect,
    loadGallery: () => { void loadGallery(); },
    loadUsage,
  };

  async function loadSnapshot(): Promise<void> {
    const mine = ++snapSeq;
    try {
      const snap = await invoke<DashSnapshot | null>("dashboard_snapshot", { target: ref });
      if (destroyed || mine !== snapSeq) return;
      if (!snap) throw new Error("no snapshot for this target");
      const first = !ctx;
      if (!ctx) {
        ctx = {
          mode: deps.mode, usage: { range: "30d", offset: 0, records: null }, todoRange: "30d",
          snap, history: null, tab: "outcomes", images: new Map(), refreshing: new Set(),
          doneTodos: new Set(), pages: new Map(), columns: new Map(), halfOrder: [], paintHooks: new Set(),
          nowMs: Date.now(), act: makeActions(host),
        };
      } else {
        ctx.snap = snap;
        // Keep a checked-off mark only while the todo is still in the snapshot (write in flight).
        const open = new Set(snap.your_todos.map((t) => t.id));
        ctx.doneTodos = new Set([...ctx.doneTodos].filter((id) => open.has(id)));
      }
      paint();
      void refreshStaleCards();
      if (first || Date.now() - historyAt > HISTORY_MIN_INTERVAL_MS) void loadHistory();
      if (first) loadUsage(ctx.usage.range);
    } catch (err) {
      console.error("[project-dashboard] dashboard_snapshot failed", err);
      if (destroyed || mine !== snapSeq) return;
      if (!ctx) {
        if (deps.mode === "page") render(html`<div class="pd-quiet pd-loading">Could not load this dashboard.</div>`, root);
      } else {
        // The old snapshot stays on screen, so say it is no longer current.
        showToast(`Could not refresh the dashboard: ${String(err)}`);
      }
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
    window.clearInterval(staleTimer);
    onResize.cancel();
    resizeObs?.disconnect();
    for (const u of unlisteners.splice(0)) { try { u(); } catch { /* already gone */ } }
    root.remove();
    chips.remove();
  }

  // Right-click (a long-press on the phone): the item's own actions, then the project's.
  root.addEventListener("contextmenu", (e) => { if (ctx) openContextMenu(e, host); });

  for (const name of LIVE_EVENTS) {
    void getTransport().listen(name, () => refetch()).then((u) => {
      if (destroyed) u(); else unlisteners.push(u);
    });
  }

  paint();
  void loadSnapshot();

  return { root, chips, refresh: () => void loadSnapshot(), destroy };
}
