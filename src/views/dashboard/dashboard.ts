import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./dashboard.css";
import "../../shared/account-chip.css";
import { getSettings, setSettings, setUsageHistory, getUsageHistory } from "../../shared/state";
import { api } from "../../shared/api";
import type { AuthState, UsageRecord } from "../../shared/api";
import { setCachedAccounts, listCachedAccounts } from "../../shared/accounts-cache";
import { navigateTo } from "../../router";
import { escapeHtml } from "../../shared/escape-html";
import {
  buildAccountCardsHTML,
  wireAccountCardClicks,
  tickAccountCardCountdowns,
} from "./account-selector";
import { reconcileSelectedAccountId } from "./account-selector-logic";
import {
  getWidget,
  resolveDashboardWidgets,
  setWidgetEnabled,
  moveWidget,
  widgetsNeedingAccountRerender,
} from "./widget-registry";
import type { DashboardWidgetEntry, WidgetContext } from "./widget-registry";
import {
  closeDashMenu,
  onDashMoreClick as onDashMoreClickImpl,
} from "./dashboard-more-menu";
import type { DashMoreMenuDeps } from "./dashboard-more-menu";
import { legacyStatCardsHtml } from "./legacy-stat-cards";

let refreshBusy = false;
let lastAutoPollMs = 0;
let aiPollTimer: number | null = null;

// ── Module state (per-mount; reset on each renderDashboard call) ───────────
let selectedAccountId: string | null = null;
// Cross-window "focus this account" request (from an overlay card click). Set
// by focusDashboardAccount; consumed on the next fullRefresh when the dashboard
// isn't mounted yet, or applied immediately when it already is.
let pendingFocusAccountId: string | null = null;
let usageMapCache: Record<string, UsageRecord> = {};
let authStateMapCache: Record<string, AuthState> = {};
let dashboardWidgets: DashboardWidgetEntry[] = [];
let editMode = false;
const widgetTeardowns = new Map<string, () => void>();

// Multi-account milestone 08: one-time "set up your accounts" migration
// prompt. Fetched once per mount (not on every refresh) - see renderDashboard.
let showSetupBanner = false;

async function tickAiPoll(): Promise<void> {
  try {
    const instances = await api.listInstances();
    if (instances.length === 0) {
      if (aiPollTimer !== null) {
        window.clearInterval(aiPollTimer);
        aiPollTimer = null;
      }
      return;
    }
    await api.pollNow();
  } catch (err) {
    console.error("[dashboard] ai-running poll failed", err);
  }
}

function ensureAiPollRunning(): void {
  if (aiPollTimer !== null) return;
  aiPollTimer = window.setInterval(() => void tickAiPoll(), 60_000);
}

function getHistory(): UsageRecord[] | null {
  return getUsageHistory() as UsageRecord[] | null;
}

async function maybeAutoPoll(reason: "crossover" | "focus"): Promise<void> {
  if (refreshBusy) return;
  const now = Date.now();
  // Throttle: one auto-poll per minute.
  if (now - lastAutoPollMs < 60_000) return;
  const history = getHistory();
  if (!history || history.length === 0) return;
  const latest = history[history.length - 1]!;
  const sessionMs = latest.session_resets_at ? new Date(latest.session_resets_at).getTime() : null;
  const weeklyMs = latest.weekly_resets_at ? new Date(latest.weekly_resets_at).getTime() : null;
  const sessionExpired = sessionMs !== null && now >= sessionMs;
  const weeklyExpired = weeklyMs !== null && now >= weeklyMs;
  if (reason === "crossover" && !sessionExpired && !weeklyExpired) return;
  lastAutoPollMs = now;
  try {
    await api.pollNow();
  } catch (err) {
    console.error("[dashboard] auto pollNow failed", err);
  }
}

let mountedContainer: HTMLElement | null = null;

export async function renderDashboard(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  const content = root.querySelector<HTMLElement>("#stats-content");
  mountedContainer = content;

  try {
    const promptState = await api.getAccountsSetupPromptState();
    showSetupBanner = promptState.shouldShow;
  } catch (e) {
    console.error("[dashboard] accounts setup prompt state fetch failed", e);
  }

  if (!getHistory()) {
    try {
      setUsageHistory(await api.getUsageHistory());
    } catch (e) {
      console.error("[dashboard] initial history fetch failed", e);
    }
  }
  if (content) await fullRefresh(content);

  const unlisten = api.onHistoryUpdated((h) => {
    setUsageHistory(h);
    const el = root.querySelector<HTMLElement>("#stats-content");
    if (el) void fullRefresh(el);
  });

  const onRefreshEvent = () => {
    const el = root.querySelector<HTMLElement>("#stats-content");
    if (el) void fullRefresh(el);
  };
  window.addEventListener("refresh-dashboard-home", onRefreshEvent);

  const onVisibility = () => {
    if (document.visibilityState === "visible") void maybeAutoPoll("focus");
  };
  document.addEventListener("visibilitychange", onVisibility);

  void maybeAutoPoll("crossover");
  const crossoverTimer = window.setInterval(() => void maybeAutoPoll("crossover"), 60_000);

  // Live per-second ring countdown tick (targeted DOM update, not a re-render
  // - renderShell/mountWidgets aren't torn-down-safe on a 1s timer).
  const ringTickTimer = window.setInterval(() => {
    if (mountedContainer) tickAccountCardCountdowns(mountedContainer);
  }, 1000);

  // Start AI-running poll if any instances are live right now.
  void api.listInstances().then((list) => { if (list.length > 0) ensureAiPollRunning(); });

  const unlistenInstances = api.onInstancesChanged((list) => {
    if (Array.isArray(list) && list.length > 0) ensureAiPollRunning();
  });

  return () => {
    try { unlisten(); } catch { /* ignore */ }
    try { unlistenInstances(); } catch { /* ignore */ }
    window.removeEventListener("refresh-dashboard-home", onRefreshEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(crossoverTimer);
    window.clearInterval(ringTickTimer);
    if (aiPollTimer !== null) { window.clearInterval(aiPollTimer); aiPollTimer = null; }
    closeDashMenu();
    teardownAllWidgets();
    mountedContainer = null;
  };
}

/** Re-renders the mounted dashboard content, if any - the replacement for the
 * deleted statistics.ts's `refreshDashboard()` global (boot.ts calls this on
 * every history/token-history update). No-op when the dashboard isn't the
 * currently-mounted view. */
export function refreshDashboardView(): void {
  if (mountedContainer) void fullRefresh(mountedContainer);
}

/** Focus the dashboard on a specific account (from an overlay card click). If
 * the dashboard is already mounted, switch immediately; otherwise remember the
 * request so the next fullRefresh (on mount) selects it. */
export function focusDashboardAccount(id: string): void {
  pendingFocusAccountId = id;
  if (mountedContainer && listCachedAccounts().some((a) => a.id === id)) {
    onSelectAccount(mountedContainer, id);
    pendingFocusAccountId = null;
  }
}

function template() {
  return html`
    <div class="view view-dashboard">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Claude Conductor</h2>
        <button
          class="icon-btn"
          id="dashMoreBtn"
          title="More options"
          @click=${onDashMoreClick}
        >
          <i class="ph ph-dots-three-vertical"></i>
        </button>
      </div>
      <div class="view-body">
        <div id="stats-content">
          <div class="no-data">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

function onToggleEditMode(): void {
  editMode = !editMode;
  // Pure class toggle - the edit controls are already in the DOM, so the
  // widget bodies (graphs) are never torn down and re-mounted here.
  mountedContainer?.classList.toggle("editing", editMode);
}

async function triggerRefresh(): Promise<void> {
  if (refreshBusy) return;
  refreshBusy = true;
  const btn = document.getElementById("dashMoreBtn");
  btn?.classList.add("spinning");
  try {
    await api.pollNow();
  } catch (err) {
    console.error("pollNow failed", err);
  } finally {
    btn?.classList.remove("spinning");
    refreshBusy = false;
  }
}

// ── "More options" kebab menu delegation ────────────────────────────────────
// The menu itself (build/position/close) lives in dashboard-more-menu.ts;
// dashboard.ts only supplies the small dependency bag it needs.

function dashMenuDeps(): DashMoreMenuDeps {
  return {
    isEditMode: () => editMode,
    onToggleEditMode,
    triggerRefresh,
    getDashboardWidgets: () => dashboardWidgets,
    enableWidget: (id) => {
      dashboardWidgets = setWidgetEnabled(dashboardWidgets, id, true);
      persistDashboardWidgets();
      if (mountedContainer) renderShell(mountedContainer);
    },
  };
}

function onDashMoreClick(e: Event): void {
  onDashMoreClickImpl(e, dashMenuDeps());
}

// ── Settings persistence for the widget layout ──────────────────────────────

function persistDashboardWidgets(): void {
  const s = getSettings();
  s.dashboardWidgets = dashboardWidgets;
  setSettings(s);
  void api.saveSettings(s);
}

// ── Widget shell + registry wiring ──────────────────────────────────────────

function currentCtx(): WidgetContext {
  return { accountId: selectedAccountId, hasAccounts: listCachedAccounts().length > 0 };
}

function selectedAccountLabel(): string {
  return listCachedAccounts().find((a) => a.id === selectedAccountId)?.label ?? "";
}

function widgetShellHtml(entry: DashboardWidgetEntry, index: number, total: number): string {
  const widget = getWidget(entry.id);
  if (!widget) return "";
  const tag = widget.scope === "global"
    ? `<span class="dash-tag dash-tag-global">Global</span>`
    : `<span class="dash-tag dash-tag-scoped" style="--acc:${escapeHtml(listCachedAccounts().find((a) => a.id === selectedAccountId)?.colour ?? "")}">${escapeHtml(selectedAccountLabel())}</span>`;
  // Edit buttons are always in the DOM; CSS (`#stats-content.editing`) shows
  // them only in edit mode, so toggling edit never re-renders the widget
  // bodies (which would blank the graphs for a frame).
  const editButtons =
    `<button class="icon-btn dash-widget-up" data-widget-id="${escapeHtml(entry.id)}" title="Move up" ${index === 0 ? "disabled" : ""}><i class="ph ph-caret-up"></i></button>
     <button class="icon-btn dash-widget-down" data-widget-id="${escapeHtml(entry.id)}" title="Move down" ${index === total - 1 ? "disabled" : ""}><i class="ph ph-caret-down"></i></button>
     <button class="icon-btn dash-widget-remove" data-widget-id="${escapeHtml(entry.id)}" title="Remove"><i class="ph ph-x"></i></button>`;
  return `<div class="dash-widget" data-widget-id="${escapeHtml(entry.id)}">
    <div class="dash-widget-header">
      <i class="ph ${escapeHtml(widget.icon)} dash-widget-icon"></i>
      <span class="dash-widget-title">${escapeHtml(widget.title)}</span>
      ${tag}
      <span class="grow"></span>
      <span class="dash-widget-edit">${editButtons}</span>
    </div>
    <div class="dash-widget-body"></div>
  </div>`;
}

/** Renders account cards + widget shells (headers + empty bodies) from
 * cached data - synchronous, no IPC. Callers mount widget content
 * separately via `mountWidgets`/`remountWidget`. */
function renderShell(container: HTMLElement): void {
  const history = getHistory() || [];
  const accountsCache = listCachedAccounts();
  const cardsHtml = accountsCache.length > 0
    ? buildAccountCardsHTML(accountsCache, usageMapCache, selectedAccountId, getSettings(), authStateMapCache)
    : legacyStatCardsHtml(history);

  const enabled = dashboardWidgets.filter((e) => e.enabled && getWidget(e.id));
  const widgetsHtml = enabled.map((e, i) => widgetShellHtml(e, i, enabled.length)).join("");

  container.innerHTML = `
    ${setupBannerHtml()}
    ${cardsHtml}
    <div class="dash-widgets">${widgetsHtml}</div>
  `;

  container.classList.toggle("editing", editMode);

  if (accountsCache.length > 0) {
    wireAccountCardClicks(container, (id) => onSelectAccount(container, id));
  }
  wireSetupBanner(container);
  wireEditControls(container);
  mountWidgets(container);
}

// ── "Set up your accounts" migration prompt (multi-account milestone 08) ───

function setupBannerHtml(): string {
  // Defensive double-gate: an account may have been added (shared accounts
  // cache populated) in the moment between the mount-time IPC fetch and this
  // render - never show the prompt once there's a real account to select.
  if (!showSetupBanner || listCachedAccounts().length > 0) return "";
  return `
    <div class="dash-setup-banner" id="dashSetupBanner">
      <i class="ph ph-user-circle-plus"></i>
      <span class="dash-setup-banner-text">Set up your Claude accounts to track usage and chats per login.</span>
      <button class="btn-primary dash-setup-banner-cta" id="dashSetupBannerGo">Set up</button>
      <button class="icon-btn dash-setup-banner-dismiss" id="dashSetupBannerDismiss" title="Not now">
        <i class="ph ph-x"></i>
      </button>
    </div>`;
}

function wireSetupBanner(container: HTMLElement): void {
  const go = container.querySelector<HTMLButtonElement>("#dashSetupBannerGo");
  if (go) {
    go.onclick = () => { void navigateTo("settings-accounts"); };
  }
  const dismiss = container.querySelector<HTMLButtonElement>("#dashSetupBannerDismiss");
  if (dismiss) {
    dismiss.onclick = () => {
      showSetupBanner = false;
      renderShell(container);
      void api.dismissAccountsSetupPrompt().catch((e) => {
        console.error("[dashboard] dismissAccountsSetupPrompt failed", e);
      });
    };
  }
}

function widgetBodyEl(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`.dash-widget[data-widget-id="${CSS.escape(id)}"] .dash-widget-body`);
}

function mountWidgets(container: HTMLElement): void {
  for (const entry of dashboardWidgets) {
    if (!entry.enabled) continue;
    const widget = getWidget(entry.id);
    if (!widget) continue;
    const body = widgetBodyEl(container, entry.id);
    if (!body) continue;
    const teardown = widget.render(body, currentCtx());
    if (typeof teardown === "function") widgetTeardowns.set(entry.id, teardown);
  }
}

function remountWidget(container: HTMLElement, id: string): void {
  const widget = getWidget(id);
  const body = widgetBodyEl(container, id);
  if (!widget || !body) return;
  widgetTeardowns.get(id)?.();
  widgetTeardowns.delete(id);
  body.innerHTML = "";
  const teardown = widget.render(body, currentCtx());
  if (typeof teardown === "function") widgetTeardowns.set(id, teardown);
}

function teardownAllWidgets(): void {
  for (const teardown of widgetTeardowns.values()) {
    try { teardown(); } catch { /* ignore */ }
  }
  widgetTeardowns.clear();
}

function onSelectAccount(container: HTMLElement, newId: string): void {
  if (newId === selectedAccountId) return;
  const prev = selectedAccountId;
  selectedAccountId = newId;
  container.querySelectorAll<HTMLElement>(".dash-acard").forEach((card) => {
    card.classList.toggle("active", card.dataset["accId"] === newId);
  });
  // The scoped tag on each account-scoped widget shows the account label -
  // refresh those in place along with the widget content itself.
  container.querySelectorAll<HTMLElement>(".dash-tag-scoped").forEach((tag) => {
    tag.textContent = selectedAccountLabel();
    const colour = listCachedAccounts().find((a) => a.id === newId)?.colour;
    if (colour) tag.style.setProperty("--acc", colour);
  });
  for (const id of widgetsNeedingAccountRerender(dashboardWidgets, prev, newId)) {
    remountWidget(container, id);
  }
}

function wireEditControls(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>(".dash-widget-up").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset["widgetId"];
      if (!id) return;
      dashboardWidgets = moveWidget(dashboardWidgets, id, -1);
      persistDashboardWidgets();
      renderShell(container);
    };
  });
  container.querySelectorAll<HTMLButtonElement>(".dash-widget-down").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset["widgetId"];
      if (!id) return;
      dashboardWidgets = moveWidget(dashboardWidgets, id, 1);
      persistDashboardWidgets();
      renderShell(container);
    };
  });
  container.querySelectorAll<HTMLButtonElement>(".dash-widget-remove").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset["widgetId"];
      if (!id) return;
      dashboardWidgets = setWidgetEnabled(dashboardWidgets, id, false);
      persistDashboardWidgets();
      renderShell(container);
    };
  });
}

// ── Full refresh: re-fetch accounts/usage/history, then render ─────────────

async function fullRefresh(container: HTMLElement): Promise<void> {
  teardownAllWidgets();

  const settings = getSettings();
  const hadPersistedLayout = Array.isArray(settings.dashboardWidgets);
  dashboardWidgets = resolveDashboardWidgets(settings);
  if (!hadPersistedLayout) persistDashboardWidgets();

  try {
    const [accounts, usageMap, authStateMap] = await Promise.all([
      api.listAccounts(), api.getUsageMap(), api.getAuthStateMap(),
    ]);
    setCachedAccounts(accounts);
    usageMapCache = usageMap;
    authStateMapCache = authStateMap;
  } catch (e) {
    console.error("[dashboard] account/usage fetch failed", e);
  }

  const defaultAccountId = (getSettings()["default_account_id"] as string | null | undefined) ?? null;
  selectedAccountId = reconcileSelectedAccountId(selectedAccountId, defaultAccountId, listCachedAccounts());

  // Honour a pending overlay "focus this account" request that arrived before
  // the dashboard was mounted (main.ts navigate-to-account handler).
  if (pendingFocusAccountId) {
    if (listCachedAccounts().some((a) => a.id === pendingFocusAccountId)) {
      selectedAccountId = pendingFocusAccountId;
    }
    pendingFocusAccountId = null;
  }

  renderShell(container);
}
