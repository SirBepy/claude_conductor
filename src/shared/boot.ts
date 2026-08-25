/**
 * Boot-time wiring extracted from the legacy src/dashboard.js.
 *
 * Owns:
 *  - initial data fetch (usage history, token history with live merge, settings)
 *  - refreshDashboardView + dead-path check once all three land
 *  - live subscriptions (onHistoryUpdated, onTokenHistoryUpdated, onInstancesChanged)
 *  - hook-registration consent modal wiring
 *  - legacy obsidian_claude_remote import banner wiring
 *
 * All state goes through src/shared/state.ts. DOM-level static templates live
 * in src/index.html; this module only wires button handlers.
 */

import {
  getSettings,
  setSettings,
  setTokenHistory,
  setUsageHistory,
  getTokenHistory,
} from "./state";
import type { SettingsShape } from "./state";
import type { TokenRecord, AliasMap } from "./tokens";
import { doMerge } from "./merges";
import { showToast } from "./toast";
import { api } from "./api";
import { curateLatestPerFamily, setApiModels } from "./effort-presets";
import { refreshDashboardView } from "../views/dashboard/dashboard";
import { renderProjectsList } from "../views/projects/projects";
import { renderProjectDetailContent } from "../views/project-detail/project-detail";
import * as shortcuts from "./shortcuts";
import { triggerNewSessionGlobal } from "../views/sessions/sessions";
import { showView } from "./navigation";
import { isRemote } from "./transport";
import { wireInitialFetches } from "./initial-render-gate";

function activeViewName(): string {
  return window.location.hash.replace(/^#/, "") || "dashboard";
}

// ── Live token history merge ───────────────────────────────────────────────
async function fetchTokenHistoryWithLive(): Promise<TokenRecord[]> {
  const history = (await api.getTokenHistory().catch(() => [])) ?? [];
  try {
    const active = (await api.getActiveSessions()) ?? [];
    if (active.length) return [...history, ...active];
  } catch {
    // handler may not be registered yet
  }
  return history;
}

// ── Dead-path reconciliation ──────────────────────────────────────────────
const deadPaths = new Set<string>();

async function runDeadPathCheck(): Promise<void> {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) return;
  const settings = getSettings();
  const aliases: AliasMap = (settings.projectAliases as AliasMap) || {};

  const cwds = [
    ...new Set(tokenHistory.map((r) => r.cwd).filter((c): c is string => !!c)),
  ].filter((c) => !aliases[c]?.mergedInto);
  if (!cwds.length) return;

  const allPathsToCheck = new Set<string>(cwds);
  for (const c of cwds) {
    const merged = aliases[c]?.mergedPaths || [];
    for (const m of merged) allPathsToCheck.add(m);
  }

  const existsMap = await api.checkPathsExist([...allPathsToCheck]);

  const isProjectAlive = (c: string): boolean => {
    if (existsMap[c]) return true;
    const merged = aliases[c]?.mergedPaths || [];
    return merged.some((m) => existsMap[m]);
  };

  const dead = cwds.filter((c) => !isProjectAlive(c));
  if (!dead.length) return;
  const live = cwds.filter(isProjectAlive);

  let anyMerged = false;
  for (const deadCwd of dead) {
    const deadName =
      deadCwd.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "";
    const matches = live.filter(
      (lc) =>
        (lc.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "") ===
        deadName,
    );
    if (matches.length === 1 && matches[0]) {
      doMerge(aliases, deadCwd, matches[0]);
      settings.projectAliases = aliases;
      setSettings(settings);
      void api.saveSettings(settings);
      anyMerged = true;
    } else {
      deadPaths.add(deadCwd);
    }
  }
  if (anyMerged) {
    void renderProjectsList();
    refreshDashboardView();
  } else if (deadPaths.size) {
    void renderProjectsList();
  }
}

// ── Hook-registration consent modal ────────────────────────────────────────
async function renderHookModalPreview(): Promise<void> {
  const state = await api.getHookRegistrationState();
  const port = state?.port ?? "?";
  const preview = [
    `"hooks": {`,
    `  "SessionStart": [{`,
    `    "matcher": "aiusage-taskbar",`,
    `    "hooks": [{ "type": "command",`,
    `      "command": "curl -sS -X POST … :${port}/hooks/session-start" }]`,
    `  }],`,
    `  "SessionEnd": [{ ... similarly … }]`,
    `}`,
  ].join("\n");
  const el = document.getElementById("hookModalPreview");
  if (el) el.textContent = preview;
}

function hideHookModal(): void {
  const b = document.getElementById("hookModalBackdrop");
  const m = document.getElementById("hookModal");
  if (b) b.style.display = "none";
  if (m) m.style.display = "none";
}

function showHookModal(): void {
  const b = document.getElementById("hookModalBackdrop");
  const m = document.getElementById("hookModal");
  if (b) b.style.display = "block";
  if (m) m.style.display = "block";
  void renderHookModalPreview();
}

async function maybeShowHookModal(): Promise<void> {
  // Hook registration installs a SessionStart hook on THIS machine so local
  // `claude` instances surface in the app. It is meaningless on the remote
  // phone browser (which has no local machine to instrument) and the RPC isn't
  // served there, so the desktop-only check below keeps the modal from popping
  // on the phone home screen. The phone mirrors the desktop's state instead.
  if (isRemote()) return;
  const state = await api.getHookRegistrationState();
  if (!state || state.registered || state.declined) return;
  showHookModal();
}

function wireHookModal(): void {
  const accept = document.getElementById("hookModalAccept");
  const skip = document.getElementById("hookModalSkip");
  const never = document.getElementById("hookModalNever");

  if (accept) {
    (accept as HTMLButtonElement).onclick = async () => {
      try {
        await api.registerHooksGlobally();
        hideHookModal();
        showToast("Hooks enabled. Running instances will now show up.");
      } catch (e) {
        showToast(`Hook install failed: ${String(e)}`);
      }
    };
  }
  if (skip) {
    (skip as HTMLButtonElement).onclick = () => {
      hideHookModal();
    };
  }
  if (never) {
    (never as HTMLButtonElement).onclick = async () => {
      await api.skipHookRegistration();
      hideHookModal();
    };
  }
}

// ── Legacy obsidian_claude_remote import banner ────────────────────────────
async function maybeOfferLegacyImport(): Promise<void> {
  let preview: unknown;
  try {
    preview = await api.importLegacyObsidianConfig();
  } catch {
    return;
  }
  if (!preview) return;
  try {
    await api.confirmLegacyObsidianImport(true);
    showToast("Imported Obsidian channel from old tray app. See Projects.");
  } catch (e) {
    console.error("confirm_legacy_obsidian_import failed", e);
  }
}

// ── Settings salvage/reset notice ──────────────────────────────────────────
/** One-shot: the Rust side `take()`s the notice, so this cannot double-toast. */
async function maybeShowSettingsLoadNotice(): Promise<void> {
  if (isRemote()) return;
  try {
    const notice = await api.getSettingsLoadNotice();
    if (notice) showToast(notice, { ttlMs: 10000 });
  } catch (e) {
    console.warn("[settings] load-notice check failed", e);
  }
}

function applyThemeFromSettings(s: SettingsShape): void {
  const fullId = (s.theme as string) || "void";
  const isLight = fullId.endsWith("-light");
  const baseId = isLight ? fullId.replace("-light", "") : fullId;
  const el = document.documentElement;
  el.dataset.theme = baseId;
  el.dataset.mode = isLight ? "light" : "dark";
}

function coerceSettings(s: SettingsShape): SettingsShape {
  const colorApplyTo = (s.colorApplyTo as Record<string, boolean | undefined> | undefined) || {};
  s.colorApplyTo = {
    icon: colorApplyTo.icon !== false,
    number: colorApplyTo.number !== false,
    dashboard: colorApplyTo.dashboard !== false,
    tooltip: colorApplyTo.tooltip !== false,
    overlay: colorApplyTo.overlay !== false,
  };
  return s;
}

// ── Public entrypoint ──────────────────────────────────────────────────────
export function initBoot(): void {
  // Initial data fetches: render once all three settle (success OR failure, so
  // a failed fetch can't wedge the gate - see wireInitialFetches).
  wireInitialFetches({
    fetchUsage: () => api.getUsageHistory(),
    fetchTokens: () => fetchTokenHistoryWithLive(),
    fetchSettings: () => api.getSettings(),
    onUsage: (h) => setUsageHistory(h),
    onTokens: (t) => setTokenHistory(t),
    onSettings: (s) => {
      if (s) {
        const coerced = coerceSettings(s);
        setSettings(coerced);
        applyThemeFromSettings(coerced);
      }
    },
    onReady: () => {
      refreshDashboardView();
      void runDeadPathCheck();
    },
  });

  // Live subscriptions.
  api.onHistoryUpdated((h) => {
    setUsageHistory(h);
    refreshDashboardView();
    if (activeViewName() === "projects") void renderProjectsList();
  });
  api.onTokenHistoryUpdated(async (th) => {
    let active: TokenRecord[] = [];
    try {
      active = (await api.getActiveSessions()) ?? [];
    } catch {
      /* ignore */
    }
    const merged = active.length ? [...(th || []), ...active] : th || [];
    setTokenHistory(merged);
    refreshDashboardView();
    const view = activeViewName();
    if (view === "projects") void renderProjectsList();
    if (view === "project-detail") renderProjectDetailContent();
  });
  api.onInstancesChanged(() => {
    if (activeViewName() === "projects") void renderProjectsList();
  });
  let _daemonWasConnected = true;
  // daemon-status-changed is an app-wide event: every window that runs initBoot
  // (main + the Chats window) would otherwise toast the same drop, so one real
  // reconnect looked like "over and over". Own the toast in the main window only.
  const _isMainWindow = !document.body.classList.contains("chats-window-mode");
  api.onDaemonStatus((s) => {
    if (!s.connected) {
      _daemonWasConnected = false;
      if (_isMainWindow) showToast("Daemon disconnected - reconnecting...");
    } else if (!_daemonWasConnected) {
      _daemonWasConnected = true;
      if (_isMainWindow) showToast("Daemon reconnected.");
    }
  });

  // Discover available models from the API and update the model picker base.
  // Silent on failure (offline, expired token, missing credentials).
  void api.fetchAvailableModels().then((models) => {
    if (models && models.length > 0) setApiModels(curateLatestPerFamily(models));
  }).catch(() => {});

  // Modal + banner wiring (idempotent; safe to call on boot).
  wireHookModal();
  void maybeOfferLegacyImport();
  void maybeShowHookModal();
  // Main window only: otherwise the Chats window can win the take() race and
  // swallow the one toast.
  if (_isMainWindow) void maybeShowSettingsLoadNotice();

  shortcuts.register("new-chat", triggerNewSessionGlobal);
  shortcuts.register("go-home", () => showView("dashboard"));
  shortcuts.register("go-chats", () => showView("sessions"));
}
