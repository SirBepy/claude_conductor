/**
 * Typed state module shared across views.
 *
 * During Phase 4 migration, state still lives on `window.*` (set by the legacy
 * dashboard.js). These accessors read/write through `window` so legacy and TS
 * views see the same values. Once legacy is deleted, main.ts will own the
 * initial hydration and window bridging goes away.
 */

import type { AliasMap, TokenRecord } from "./tokens";
import type { Avatar } from "./projects";

export interface ProjectConfig {
  id: string;
  path: string;
  name?: string;
  avatar?: Avatar;
  automation?: { enabled?: boolean } | null;
}

export interface SettingsShape {
  projects?: ProjectConfig[];
  projectAliases?: AliasMap;
  projectBlacklist?: string[];
  colorApplyTo?: Record<string, boolean | undefined>;
  paceBand?: number;
  paceColors?: { under?: string; nearSafe?: string; nearOver?: string; over?: string };
  audioOutputDevice?: string | null;
  /** Floating overlay backing style: per-dial circular discs ("circles",
   * default) or one shared rounded card behind the row ("card"). */
  overlayBackgroundStyle?: "circles" | "card";
  /** Dashboard widget layout (multi-account milestone 05) - ordered
   * `{id, enabled}` entries. Untyped passthrough (see dashboard-widget-logic.ts
   * for the shape); absence is the trigger for the one-time `pinnedCards`
   * migration, so don't default this to `[]` when reading raw settings. */
  dashboardWidgets?: unknown;
  /** Legacy closed-enum home-card pin list, replaced by `dashboardWidgets`.
   * Kept typed here only so `resolveDashboardWidgets` can read it off a
   * `SettingsShape` for the one-time migration. */
  pinnedCards?: unknown;
  /** Ambient animated background behind the main window and chat windows
   * (see shared/background-fx.ts). Off by default. */
  backgroundEnabled?: boolean;
  backgroundVariant?: "pattern" | "gradient";
  [k: string]: unknown;
}

export interface ProjectDetailState {
  cwd: string | null;
  range: string;
  offset: number;
}

interface WindowWithState {
  currentSettings?: SettingsShape;
  lastTokenHistory?: TokenRecord[] | null;
  lastHistory?: unknown;
  projectDetailState?: ProjectDetailState;
  projectSubviewStack?: string[];
  currentSessionRecord?: unknown;
}

function win(): WindowWithState {
  return window as unknown as WindowWithState;
}

// ── Settings ──────────────────────────────────────────────────────────────
export function getSettings(): SettingsShape {
  return win().currentSettings ?? {};
}

export function setSettings(s: SettingsShape): void {
  win().currentSettings = s;
}

// ── Token history ─────────────────────────────────────────────────────────
export function getTokenHistory(): TokenRecord[] | null {
  return win().lastTokenHistory ?? null;
}

export function setTokenHistory(h: TokenRecord[] | null): void {
  win().lastTokenHistory = h;
}

// ── Usage history (five-hour/seven-day snapshots) ─────────────────────────
export function getUsageHistory(): unknown {
  return win().lastHistory ?? null;
}

export function setUsageHistory(h: unknown): void {
  win().lastHistory = h;
}

// ── Project detail navigation state ───────────────────────────────────────
export function getProjectDetailState(): ProjectDetailState {
  let s = win().projectDetailState;
  if (!s) {
    s = { cwd: null, range: "30d", offset: 0 };
    win().projectDetailState = s;
  }
  return s;
}

// ── Project subview stack (sub-route history) ─────────────────────────────
export function getProjectSubviewStack(): string[] {
  let s = win().projectSubviewStack;
  if (!s) {
    s = [];
    win().projectSubviewStack = s;
  }
  return s;
}

// ── Current session record (session-detail view) ──────────────────────────
export function getCurrentSessionRecord(): unknown {
  return win().currentSessionRecord ?? null;
}

export function setCurrentSessionRecord(r: unknown): void {
  win().currentSessionRecord = r;
}
