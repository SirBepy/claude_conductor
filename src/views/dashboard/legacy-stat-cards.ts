// Legacy (pre-onboarding, empty registry) two-card fallback (ai_todo 183).
// Unchanged from the pre-milestone dashboard - the account-selector cards
// replace this once at least one account is registered.

import { fmtPct, fmtResetDisplay, valueColor } from "../../shared/formatters";
import type { ResetDisplay } from "../../shared/formatters";
import { getSettings } from "../../shared/state";
import type { UsageRecord } from "../../shared/api";

export function legacyStatCardsHtml(history: UsageRecord[]): string {
  if (!history.length) {
    return `<div class="v-empty">
      <i class="ph ph-chart-bar v-empty-icon"></i>
      <div class="v-empty-title">No history recorded yet</div>
      <div class="v-empty-hint">Data appears after the first successful refresh.</div>
    </div>`;
  }
  const latest = history[history.length - 1]!;
  const settings = getSettings();
  const sessionReset = fmtResetDisplay(latest.session_resets_at);
  const weeklyReset = fmtResetDisplay(latest.weekly_resets_at);
  const SESSION_WINDOW_MS = 5 * 3_600_000;
  const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;
  const renderReset = (r: ResetDisplay | null, windowMs: number): string => {
    if (!r) return "";
    if (r.diffMs <= 0) return `<div class="reset-info"><div class="reset-relative">now</div></div>`;
    const frac = Math.max(0, Math.min(1, r.diffMs / windowMs));
    const opacity = (1 - frac * 0.7).toFixed(2);
    return `
      <div class="reset-info" style="opacity:${opacity}">
        <div class="reset-label">resets</div>
        <div class="reset-absolute">${r.absolute}</div>
        <div class="reset-relative">${r.relative}</div>
      </div>`;
  };

  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const sessionResetMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : null;
  const sessionSafePct =
    sessionResetMs !== null
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((5 * 3_600_000 - (sessionResetMs - Date.now())) /
                (5 * 3_600_000)) *
                100,
            ),
          ),
        )
      : null;
  const weeklySafePct = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        ((7 * 24 * 3_600_000 - (weeklyEndMs - Date.now())) /
          (7 * 24 * 3_600_000)) *
          100,
      ),
    ),
  );

  return `
    <div class="stat-cards">
      <div class="stat-card home-card">
        <div class="stat-label label">Session (5h)</div>
        <div class="ring-wrap">
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.session_pct as number, sessionSafePct, settings)}">${fmtPct(latest.session_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(sessionSafePct as number)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>
        </div>
        ${renderReset(sessionReset, SESSION_WINDOW_MS)}
      </div>
      <div class="stat-card home-card">
        <div class="stat-label label">Weekly (7d)</div>
        <div class="ring-wrap">
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.weekly_pct as number, weeklySafePct, settings)}">${fmtPct(latest.weekly_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(weeklySafePct)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>
        </div>
        ${renderReset(weeklyReset, WEEKLY_WINDOW_MS)}
      </div>
    </div>
  `;
}
