// Pure helpers for the add-account wizard (multi-account milestone 01).
// Kept free of DOM/IPC so the state-machine bits are cheaply unit-testable
// (see tests/add-account-wizard-logic.test.mjs). The modal itself
// (add-account-wizard.ts) is the only caller.

import type { Account, AccountIdentity, LoginCheckOutcome, OauthAccountInfo } from "../../../../types/ipc.generated";

// Bare Phosphor icon names (no "ph-" prefix) - the wizard renders
// `ph ph-${icon}`. Kept local to this feature; nothing else in the app picks
// account icons yet.
export const ICON_POOL = [
  "user",
  "briefcase",
  "palette",
  "rocket",
  "buildings",
  "lightning",
  "crown",
  "flask",
  "terminal-window",
  "cube",
] as const;

export const COLOUR_POOL = [
  "#9d7dfc",
  "#f5a623",
  "#3ecf8e",
  "#38bdf8",
  "#f472b6",
  "#fb7185",
];

export const LOGIN_POLL_INTERVAL_MS = 2000;
// Frontend-enforced ceiling on the "run /login in the spawned terminal" step.
// The backend session has no timeout of its own; the wizard cancels it.
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * First pool entry (starting at `startIndex`, wrapping) not present in
 * `usedIcons`. Icon collisions are cosmetic, never blocking, so if every icon
 * in the pool is already taken this falls back to the entry at `startIndex`
 * rather than throwing.
 */
export function pickAvailableIcon(
  pool: readonly string[],
  usedIcons: Iterable<string>,
  startIndex = 0,
): string {
  if (pool.length === 0) return "";
  const used = new Set(usedIcons);
  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const candidate = pool[idx]!;
    if (!used.has(candidate)) return candidate;
  }
  return pool[((startIndex % pool.length) + pool.length) % pool.length]!;
}

/**
 * "Fibo Studio" -> "Fibo Studio"; falls back to the email's local part,
 * title-cased on `.`/`_`/`-`, when there's no org name (personal accounts
 * often have none).
 */
export function prefillLabel(
  identity: Pick<OauthAccountInfo, "organizationName" | "emailAddress">,
): string {
  const org = identity.organizationName?.trim();
  if (org) return org;
  const local = identity.emailAddress.split("@")[0] ?? identity.emailAddress;
  const titled = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return titled || identity.emailAddress;
}

const KNOWN_TIERS: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

/** Raw `organizationType` (e.g. "claude_max") -> a human label. Unknown
 * values are title-cased and passed through rather than hidden. */
export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "Unknown plan";
  if (KNOWN_TIERS[tier]) return KNOWN_TIERS[tier];
  const cleaned = tier.replace(/^claude_/, "");
  return cleaned
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ") || tier;
}

/** "83000" ms -> "1:23". */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function isLoginTimedOut(elapsedMs: number): boolean {
  return elapsedMs >= LOGIN_TIMEOUT_MS;
}

export type LoginOutcomeView =
  | { kind: "pending"; misdirected: string | null; credentialsNoProfile: boolean }
  | { kind: "ready"; identity: OauthAccountInfo }
  | { kind: "mismatch"; message: string }
  | { kind: "duplicate"; message: string };

/** Maps the backend's `LoginCheckOutcome` union to a view-ready shape with a
 * plain-English message for the two failure variants, so the modal never has
 * to synthesize error copy inline. */
export function describeLoginOutcome(outcome: LoginCheckOutcome): LoginOutcomeView {
  switch (outcome.status) {
    case "Pending":
      return {
        kind: "pending",
        misdirected: outcome.misdirected ?? null,
        credentialsNoProfile: outcome.credentials_no_profile,
      };
    case "Ready":
      return { kind: "ready", identity: outcome.identity };
    case "Mismatch":
      return {
        kind: "mismatch",
        message:
          `This profile was already logged in as ${outcome.existing_email}, but the ` +
          `terminal just logged into ${outcome.new_email}. Log into ` +
          `${outcome.existing_email} in that terminal, or cancel and pick a different ` +
          `account name.`,
      };
    case "Duplicate":
      return {
        kind: "duplicate",
        message: `Already added as "${outcome.existing_label}".`,
      };
  }
}

// ── Settings > Accounts identity surface (multi-account milestone 07) ──────
// `get_account_identity` reads live disk state (profile dir oauthAccount,
// credentials.json expiry, whether a cookie is saved) and a drift comparison
// against the registry record. These helpers turn that + the registry
// `Account` into a view-ready shape, kept pure/DOM-free like the rest of this
// file so the mapping is unit-testable (see tests/wizard-logic.test.mjs).

/** `tokenExpiresAt` arrives typed `bigint` by ts-rs (Rust `i64`) but Tauri's
 * IPC transport actually carries a plain JSON number - `Number(..)` is a
 * no-op either way (matches the `Number(bigint)` convention already used for
 * `DatasetInfo` fields in settings.ts). */
export function formatTokenExpiry(
  expiresAt: bigint | number | null | undefined,
  now: number = Date.now(),
): string {
  if (expiresAt == null) return "Token expiry unknown";
  const diffMs = Number(expiresAt) - now;
  if (diffMs <= 0) return "Token expired";
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `Token expires in ${days}d`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours >= 1) return `Token expires in ${hours}h`;
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));
  return `Token expires in ${minutes}m`;
}

/** Same `bigint`-vs-JSON-number caveat as `formatTokenExpiry` above applies to
 * `refreshTokenExpiresAt` (ai_todo 560). */
export function formatRefreshExpiry(
  refreshExpiresAt: bigint | number | null | undefined,
  now: number = Date.now(),
): string {
  if (refreshExpiresAt == null) return "Re-login window unknown";
  const diffMs = Number(refreshExpiresAt) - now;
  if (diffMs <= 0) return "Re-login required now";
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `Re-login needed in ${days}d`;
  const hours = Math.max(1, Math.floor(diffMs / 3_600_000));
  return `Re-login needed in ${hours}h`;
}

export interface IdentitySurfaceView {
  /** Live `oauthAccount.emailAddress` from the profile dir, or `null` when
   * the account has never completed a `/login` there. */
  loggedInAsEmail: string | null;
  tierLabel: string;
  tokenExpiryLabel: string;
  refreshExpiryLabel: string;
  hasCookie: boolean;
  /** Non-null (drift or "not logged in yet") = show the red warning row. */
  warningMessage: string | null;
}

/** Maps a registry `Account` + its live `AccountIdentity` (or `null` before
 * the fetch resolves / on error) to the identity-surface row content. Falls
 * back to the registry's own `email`/`subscription_tier` when the live read
 * hasn't come back yet, so the row never shows blank fields while loading. */
export function buildIdentitySurface(
  account: Pick<Account, "email" | "subscription_tier">,
  identity: AccountIdentity | null,
  now: number = Date.now(),
): IdentitySurfaceView {
  const oauth = identity?.oauthAccount ?? null;
  return {
    loggedInAsEmail: oauth?.emailAddress ?? null,
    tierLabel: tierLabel(oauth?.organizationType ?? account.subscription_tier),
    tokenExpiryLabel: formatTokenExpiry(identity?.tokenExpiresAt ?? null, now),
    refreshExpiryLabel: formatRefreshExpiry(identity?.refreshTokenExpiresAt ?? null, now),
    hasCookie: identity?.hasCookie ?? false,
    warningMessage: identity?.drift ? (identity.driftMessage ?? "Identity mismatch - re-verify this account.") : null,
  };
}
