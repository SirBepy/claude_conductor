// Account-selector cards (multi-account milestone 05). One card per
// registered account, showing 5h + 7d as `usage%/safepace%` per the locked
// number format (docs/multi-account/00-overview.md), safe-pace tick on the
// bar, active card = border+glow (mockup: .for_bepy/multi-account-mockup.html
// section 1). See account-selector-logic.ts for the pure default/reconcile
// rules this wires up.

import { escapeHtml } from "../../shared/escape-html";
import { accountIconBadgeHtml } from "../../shared/account-chip";
import { fmtResetDisplay, valueColor, computeSafePacePct, formatRelativeMinutes } from "../../shared/formatters";
import type { ValueColorSettings } from "../../shared/formatters";
import type { Account, AuthState, UsageRecord } from "../../shared/api";

const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;

// Near/hot countdown thresholds - shared by the initial render (ringHtml) and
// the live per-second tick (tickAccountCardCountdowns) so both agree on when
// the duration switches to a ticking "M:SS" and when it turns red.
const NEAR_THRESHOLD_MS = 3_600_000; // 1h - duration switches to live M:SS countdown
const HOT_THRESHOLD_MS = 300_000; // 5m - countdown turns red + pulses

// ── Ring fill: pace-brightness as a CSS conic-gradient ──────────────────────
// Mirrors overlay.ts's ring()/seg() logic (same three cases: on-pace, under-
// pace with a faded ghost continuation, over-pace with a darker fill under a
// bright overshoot) but expressed as gradient stops instead of SVG arcs,
// since this is a flat circular gauge rather than a dial.

function ringPaceStops(cur: number, safe: number, color: string): Array<[number, number, string]> {
  if (cur === safe) return [[0, cur, color]];
  if (cur < safe) {
    const ghost = `color-mix(in srgb, ${color} 30%, var(--color-surface-alt, #262637))`;
    return [
      [0, cur, color],
      [cur, safe, ghost],
    ];
  }
  const darker = `color-mix(in srgb, ${color} 52%, #08060c)`;
  return [
    [0, safe, darker],
    [safe, cur, color],
  ];
}

function ringConicGradient(stops: Array<[number, number, string]>, track: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const [a, b, color] of stops) {
    if (a > last) parts.push(`${track} ${(last * 3.6).toFixed(1)}deg`);
    parts.push(`${color} ${(a * 3.6).toFixed(1)}deg ${(b * 3.6).toFixed(1)}deg`);
    last = b;
  }
  if (last < 100) parts.push(`${track} ${(last * 3.6).toFixed(1)}deg 360deg`);
  return `conic-gradient(${parts.join(", ")})`;
}

// ── Time-stack formatting ────────────────────────────────────────────────—

function fmtCountdown(ms: number): string {
  const clamped = Math.max(0, ms);
  const m = Math.floor(clamped / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The bare duration/countdown text + near/hot state for a reset - shared by
 * the initial render and the live tick so both compute it identically. */
function timeBigText(diffMs: number): { text: string; near: boolean; hot: boolean } {
  const near = diffMs <= NEAR_THRESHOLD_MS;
  const hot = diffMs <= HOT_THRESHOLD_MS;
  // Ring time-stack shows bare "4h 30m" / "12m" with no "resets in" prose, so
  // strip the shared formatter's "in " prefix (same pattern as
  // sessions/preview-panel.ts's relative-time formatting).
  const text = near ? fmtCountdown(diffMs) : formatRelativeMinutes(diffMs).replace(/^in /, "");
  return { text, near, hot };
}

function ringHtml(
  label: string,
  pct: number | null,
  safePct: number | null,
  resetIso: string | null | undefined,
  settings: ValueColorSettings,
): string {
  if (pct == null) {
    return `<div class="dash-ring-col">
      <div class="dash-ring">
        <div class="dash-ring-hole">
          <div class="dash-ring-pcts"><span class="dash-ring-cur dash-ring-cur-dim">--</span></div>
        </div>
      </div>
    </div>`;
  }

  const clampedPct = Math.max(0, Math.min(100, pct));
  const clampedSafe = safePct != null ? Math.max(0, Math.min(100, safePct)) : clampedPct;
  const color = valueColor(pct, safePct, settings, "dashboard");
  const bg = ringConicGradient(ringPaceStops(clampedPct, clampedSafe, color), "var(--color-surface-alt, #262637)");
  const safeLine = safePct != null ? `<span class="dash-ring-safe">/${safePct}%</span>` : "";

  const reset = fmtResetDisplay(resetIso);
  let timeHtml = "";
  let resetTitle = "";
  let ringHotClass = "";
  let dataAttr = "";
  if (reset && reset.diffMs > 0) {
    const { text: big, near, hot } = timeBigText(reset.diffMs);
    const bigClass = `dash-ring-time-big${near ? " dash-ring-time-near" : ""}${hot ? " dash-ring-time-hot" : ""}`;
    const clock = new Date(resetIso as string).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    timeHtml = `<div class="dash-ring-time">
      <span class="${bigClass}">${escapeHtml(big)}</span>
      <span class="dash-ring-time-dim">${escapeHtml(clock)}</span>
    </div>`;
    resetTitle = ` Resets ${reset.absolute}${reset.relative ? ` (${reset.relative})` : ""}.`;
    ringHotClass = hot ? " dash-ring-hot" : "";
    dataAttr = ` data-reset-iso="${escapeHtml(resetIso as string)}"`;
  }

  const title = `${label}: ${pct}% used this window${safePct != null ? `, ${safePct}% is the even safe-pace line` : ""}.${resetTitle}`;

  return `<div class="dash-ring-col" title="${escapeHtml(title)}"${dataAttr}>
    <div class="dash-ring${ringHotClass}" style="background:${bg}">
      <div class="dash-ring-hole">
        <div class="dash-ring-pcts">
          <span class="dash-ring-cur" style="color:${escapeHtml(color)}">${pct}%</span>
          ${safeLine}
        </div>
      </div>
    </div>
    ${timeHtml}
  </div>`;
}

function accountCardHtml(account: Account, usage: UsageRecord | undefined, selected: boolean, settings: ValueColorSettings, authState?: AuthState): string {
  const sessionSafe = usage ? computeSafePacePct(usage.session_resets_at, SESSION_WINDOW_MS) : null;
  const weeklySafe = usage
    ? computeSafePacePct(usage.weekly_resets_at || new Date(Date.now() + 3_600_000).toISOString(), WEEKLY_WINDOW_MS)
    : null;

  const body = usage
    ? `<div class="dash-ring-row">
        ${ringHtml("5h", usage.session_pct as number | null, sessionSafe, usage.session_resets_at, settings)}
        ${ringHtml("7d", usage.weekly_pct as number | null, weeklySafe, usage.weekly_resets_at, settings)}
      </div>`
    : `<div class="dash-ring-empty">No data yet</div>`;

  // Additive, not a replacement for `body` - a network/timeout failure never
  // reaches "needslogin" (see get_auth_state_map), so this never masks stale
  // but still-valid usage numbers. Mirrors accounts.css's `.acc-drift-warning`.
  const needsLoginBadge = authState === "needslogin"
    ? `<div class="dash-acard-warning"><i class="ph ph-warning"></i> Needs login</div>`
    : "";

  return `<div class="dash-acard${selected ? " active" : ""}" data-acc-id="${escapeHtml(account.id)}" style="--acc:${escapeHtml(account.colour)}">
    <div class="dash-ah">${accountIconBadgeHtml(account)}<span class="dash-who">${escapeHtml(account.label)}</span></div>
    ${body}
    ${needsLoginBadge}
  </div>`;
}

/** Live per-second tick for the ring time-stacks: recomputes each reset's
 * diffMs against the current time and updates only that ring's countdown
 * text + near/hot classes in place - no innerHTML rebuild, no touching
 * anything outside the matched `[data-reset-iso]` column. Safe to call on a
 * container that has none (no-op). */
export function tickAccountCardCountdowns(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>("[data-reset-iso]").forEach((col) => {
    const iso = col.dataset["resetIso"];
    const big = col.querySelector<HTMLElement>(".dash-ring-time-big");
    const ring = col.querySelector<HTMLElement>(".dash-ring");
    if (!iso || !big || !ring) return;
    const reset = fmtResetDisplay(iso);
    if (!reset || reset.diffMs <= 0) {
      big.textContent = "now";
      big.classList.remove("dash-ring-time-near", "dash-ring-time-hot");
      ring.classList.remove("dash-ring-hot");
      return;
    }
    const { text, near, hot } = timeBigText(reset.diffMs);
    big.textContent = text;
    big.classList.toggle("dash-ring-time-near", near);
    big.classList.toggle("dash-ring-time-hot", hot);
    ring.classList.toggle("dash-ring-hot", hot);
  });
}

export function buildAccountCardsHTML(
  accounts: Account[],
  usageByAccount: Record<string, UsageRecord>,
  selectedAccountId: string | null,
  settings: ValueColorSettings,
  authStateByAccount: Record<string, AuthState> = {},
): string {
  if (!accounts.length) return "";
  return `<div class="dash-sel-row">${accounts
    .map((a) => accountCardHtml(a, usageByAccount[a.id], a.id === selectedAccountId, settings, authStateByAccount[a.id]))
    .join("")}</div>`;
}

export function wireAccountCardClicks(root: HTMLElement, onSelect: (accountId: string) => void): void {
  root.querySelectorAll<HTMLElement>(".dash-acard").forEach((card) => {
    card.onclick = () => {
      const id = card.dataset["accId"];
      if (id) onSelect(id);
    };
  });
}
