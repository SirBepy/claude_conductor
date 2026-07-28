/**
 * Canonical number + time + byte formatters.
 * All views import from here. Phase 4 deletes the duplicate implementations
 * in dashboard.js/modules/stats.js/modules/chart.js once every view has
 * migrated off them.
 */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

/** Always render in millions (one decimal), e.g. 245_443 -> "0.2M", 0 -> "0M". */
export function formatMillions(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0M";
  return (n / 1_000_000).toFixed(1) + "M";
}

export function formatTimeAgo(iso: string | Date): string {
  const ts = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const suffix = units[i] ?? "TB";
  return `${v.toFixed(1)} ${suffix}`;
}

export function formatCompactNumber(n: number): string {
  return formatTokens(n);
}

// ── Percentage / reset-time / color helpers (ported from modules/formatters.js) ──

export function fmtPct(v: number | null | undefined): string {
  return v !== null && v !== undefined ? v + "%" : "--";
}

function roundToNearest10Min(d: Date): Date {
  const ten = 10 * 60_000;
  return new Date(Math.round(d.getTime() / ten) * ten);
}

export function fmtResetTime(isoStr: string | null | undefined): string | null {
  if (!isoStr) return null;
  const raw = new Date(isoStr);
  if (isNaN(raw.getTime())) return null;
  const d = roundToNearest10Min(raw);
  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs <= 0) return "now";
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 12) {
    const day = d.toLocaleDateString("en-US", { weekday: "short" });
    const hour = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    return `resets ${day}<br>${hour}`;
  }
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

export interface ResetDisplay {
  absolute: string;
  relative: string;
  diffMs: number;
}

/** "in Xh Ym" / "in Ym" for a non-negative ms delta - shared relative-time
 * math for `fmtResetDisplay` and the rate-limit banner's countdown. */
export function formatRelativeMinutes(diffMs: number): string {
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

export function fmtResetDisplay(isoStr: string | null | undefined): ResetDisplay | null {
  if (!isoStr) return null;
  const raw = new Date(isoStr);
  if (isNaN(raw.getTime())) return null;
  const d = roundToNearest10Min(raw);
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return { absolute: "now", relative: "", diffMs: 0 };
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  const hour = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const absolute = `${day} ${hour}`;
  const relative = formatRelativeMinutes(diffMs);
  return { absolute, relative, diffMs };
}

// Near/hot urgency thresholds for a reset countdown - shared by every reset
// display so "near" (amber) and "hot" (red, about to fire) mean the same
// thing everywhere one shows (dashboard account-selector.ts ring time-stacks,
// the overlay's reset popup).
export const RESET_NEAR_MS = 3_600_000; // 1h
export const RESET_HOT_MS = 300_000; // 5m

export interface ResetUrgency {
  text: string;
  near: boolean;
  hot: boolean;
}

/** Countdown text ("in Xh Ym") plus near/hot urgency for a reset timestamp,
 * built on the same fmtResetDisplay used for the absolute/relative pair. */
export function resetUrgency(isoStr: string | null | undefined): ResetUrgency | null {
  const reset = fmtResetDisplay(isoStr);
  if (!reset) return null;
  if (reset.diffMs <= 0) return { text: "now", near: false, hot: false };
  return {
    text: formatRelativeMinutes(reset.diffMs),
    near: reset.diffMs <= RESET_NEAR_MS,
    hot: reset.diffMs <= RESET_HOT_MS,
  };
}

export function pctColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "var(--text-dim)";
  if (v >= 80) return "#e74c3c";
  if (v >= 50) return "#e67e22";
  return "#27ae60";
}

export interface ColorThreshold {
  min: number;
  color: string;
}

export interface PaceColorSettings {
  paceBand?: number;
  paceColors?: { under?: string; nearSafe?: string; nearOver?: string; over?: string };
}

export function getPaceColor(pct: number, safePace: number, settings: PaceColorSettings): string {
  const band = settings.paceBand ?? 10;
  const pc = settings.paceColors || {};
  if (pct < safePace - band) return pc.under || "#27ae60";
  if (pct < safePace) return pc.nearSafe || "#f1c40f";
  if (pct < safePace + band) return pc.nearOver || "#e67e22";
  return pc.over || "#e74c3c";
}

export interface ValueColorSettings extends PaceColorSettings {
  colorApplyTo?: Record<string, boolean | undefined>;
  colorThresholds?: ColorThreshold[];
}

/**
 * Safe-pace percent for a usage window: how far through the window "now" is,
 * i.e. the even-burn line a usage percent is compared against. `null` when
 * there's no reset timestamp to anchor the window (matches the pre-existing
 * inline calc this replaces in dashboard.ts, now shared with the account
 * cards - milestone 05).
 */
export function computeSafePacePct(
  resetIso: string | null | undefined,
  windowMs: number,
  now: number = Date.now(),
): number | null {
  if (!resetIso) return null;
  const resetMs = new Date(resetIso).getTime();
  if (isNaN(resetMs)) return null;
  return Math.max(0, Math.min(100, Math.round(((windowMs - (resetMs - now)) / windowMs) * 100)));
}

export function valueColor(
  pct: number,
  safePace: number | null | undefined,
  settings: ValueColorSettings,
  target: string = "dashboard",
): string {
  if (settings.colorApplyTo?.[target] === false) return "var(--text)";
  if (safePace != null) {
    return getPaceColor(pct, safePace, settings);
  }
  return pctColor(pct);
}
