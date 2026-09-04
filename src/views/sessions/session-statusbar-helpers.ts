import { invoke } from "../../shared/ipc";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus, ChatDrain } from "../../types/ipc.generated";
import { modelLabel } from "../../shared/model-name";
import {
  type ChipType, DEFAULT_ROWS, DEFAULT_MOBILE_ROWS, MAX_ROWS, MOBILE_MAX_ROWS,
  isKnownChip, TOOL_CHIP_TOOLS,
} from "./statusline-catalog";
import { isMobileViewport } from "../../shared/mobile-viewport";

// ── Rows model (the builder) ────────────────────────────────────────────────
// statuslineRows supersedes the flat statuslineFields. statuslineHideZero is a
// single global toggle for count/tool chips. Legacy settings are migrated once.

/** Desktop and phone keep independent layouts (Joe, 2026-08-19: the phone
 *  inheriting the desktop set is what made it wrap and clip). `mobile` falls
 *  back to its own default, never to the desktop rows. */
export type StatuslineProfile = "desktop" | "mobile";

const PROFILE_KEY: Record<StatuslineProfile, string> = {
  desktop: "statuslineRows",
  mobile: "statuslineRowsMobile",
};

export function profileMaxRows(p: StatuslineProfile): number {
  return p === "mobile" ? MOBILE_MAX_ROWS : MAX_ROWS;
}

export function profileDefaultRows(p: StatuslineProfile): ChipType[][] {
  return (p === "mobile" ? DEFAULT_MOBILE_ROWS : DEFAULT_ROWS).map((r) => [...r]);
}

/** Which profile the CURRENT viewport renders. The builder overrides this to
 *  edit whichever profile the dev has selected. */
export function activeProfile(): StatuslineProfile {
  return isMobileViewport() ? "mobile" : "desktop";
}

// Legacy statuslineFields used "context"; the catalog splits it into
// context_pct / context_tokens. Everything else is a 1:1 id.
const LEGACY_FIELD_REMAP: Record<string, ChipType> = { context: "context_pct" };

/** Build a rows layout from the pre-builder flat settings. Row 1 = enabled
 *  fields (canonical order), row 2 = tool chips not hidden. Exported for tests. */
export function migrateLegacyFields(fields: string[], hiddenTools: string[]): ChipType[][] {
  const ORDER = ["model", "effort", "branch", "repo", "folder", "context", "thinking", "duration", "messages", "turns"];
  const row1 = ORDER
    .filter((f) => fields.includes(f))
    .map((f) => LEGACY_FIELD_REMAP[f] ?? (f as ChipType))
    .filter((c) => isKnownChip(c));
  const row2: ChipType[] = TOOL_CHIP_TOOLS
    .filter((t) => !hiddenTools.includes(t))
    .map((t) => `tool:${t}` as ChipType);
  const rows: ChipType[][] = [];
  if (row1.length) rows.push(row1);
  if (row2.length) rows.push(row2);
  return rows.length ? rows : DEFAULT_ROWS.map((r) => [...r]);
}

function sanitizeRows(raw: unknown, maxRows: number): ChipType[][] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.filter((c): c is string => typeof c === "string" && isKnownChip(c)) as ChipType[])
    .slice(0, maxRows);
  const trimmed = rows.filter((r) => r.length > 0);
  return trimmed.length ? trimmed : null;
}

/** Set once the saved rows have been replaced by the merged-chip layout. */
const V2_FLAG = "statuslineRowsV2Applied";

/**
 * Replaces both profiles' saved rows with the current defaults, once per
 * install: the merged `git` and `overflow` chips subsume six chips a saved
 * layout still lists individually. Lives here rather than in loadStatuslineRows
 * so that a load stays a pure read.
 */
export async function migrateStatuslineToV2(): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    if (s[V2_FLAG] === true) return;
    await invoke("save_settings", {
      updated: {
        ...s,
        statuslineRows: profileDefaultRows("desktop"),
        statuslineRowsMobile: profileDefaultRows("mobile"),
        [V2_FLAG]: true,
      },
    });
  } catch (e) {
    console.error("[statusbar] statusline v2 migration failed", e);
  }
}

export async function loadStatuslineRows(profile: StatuslineProfile = activeProfile()): Promise<ChipType[][]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const fromRows = sanitizeRows(s[PROFILE_KEY[profile]], profileMaxRows(profile));
    if (fromRows) return fromRows;
    // One-time migration from the pre-builder settings. Desktop only: the
    // mobile profile postdates it, so there is nothing legacy to carry over.
    const legacyFields = profile === "desktop" && Array.isArray(s["statuslineFields"])
      ? (s["statuslineFields"] as string[])
      : null;
    if (legacyFields) {
      const hidden = Array.isArray(s["tallyHiddenTools"]) ? (s["tallyHiddenTools"] as string[]) : [];
      const migrated = migrateLegacyFields(legacyFields, hidden);
      await invoke("save_settings", { updated: { ...s, statuslineRows: migrated } });
      return migrated;
    }
  } catch { /* ignore */ }
  return profileDefaultRows(profile);
}

export async function saveStatuslineRows(
  rows: ChipType[][],
  profile: StatuslineProfile = activeProfile(),
): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const max = profileMaxRows(profile);
    const clean = (sanitizeRows(rows, max) ?? []).slice(0, max);
    await invoke("save_settings", { updated: { ...s, [PROFILE_KEY[profile]]: clean } });
  } catch (e) {
    console.error("[statusbar] save rows failed", e);
  }
}

export async function loadStatuslineHideZero(): Promise<boolean> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    if (typeof s["statuslineHideZero"] === "boolean") return s["statuslineHideZero"] as boolean;
  } catch { /* ignore */ }
  return true; // default on
}

export async function saveStatuslineHideZero(hide: boolean): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...s, statuslineHideZero: hide } });
  } catch (e) {
    console.error("[statusbar] save hideZero failed", e);
  }
}

export const shortModelName = modelLabel;

export function formatDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Switching between chats re-creates the statusbar each time. These caches
// avoid the visible "empty bar → chips pop in" flash by keeping the last
// known values around for re-use on the next mount, while still firing a
// background refresh (stale-while-revalidate for git).
export const gitInfoCache = new Map<string, GitInfo>();
const gitInflight = new Map<string, Promise<GitInfo>>();
export const metaCache = new Map<string, SessionMeta>();

/** messages (= user prompts sent) and agent turns, parsed from the session
 *  transcript by the `instance_token_stats` IPC - the SAME source Project
 *  Detail > Chats uses, so the numbers always match. */
export interface SessionCounts { prompts: number; turns: number; }
export const countsCache = new Map<string, SessionCounts>();

/** Last known daemon-computed context occupancy per session, fetched via the
 *  `context_status` IPC (the source of truth for the context chip). Cached so a
 *  re-mounted statusbar shows the last value instead of flashing the frontend
 *  fallback while the async refetch is in flight. */
export const ctxStatusCache = new Map<string, ContextStatus>();

/** Last known per-chat token-drain breakdown (this chat's share of a 5h session
 *  + weekly, plus the per-message rundown), fetched via the `chat_drain` IPC.
 *  Cached so a re-mounted statusbar shows the last value instead of flashing the
 *  placeholder while the async refetch is in flight. */
export const drainCache = new Map<string, ChatDrain>();

export function fetchGitInfo(cwd: string): Promise<GitInfo> {
  let p = gitInflight.get(cwd);
  if (!p) {
    p = invoke<GitInfo>("get_git_info", { cwd })
      .then((info) => { gitInfoCache.set(cwd, info); gitInflight.delete(cwd); return info; })
      .catch((e) => { gitInflight.delete(cwd); throw e; });
    gitInflight.set(cwd, p);
  }
  return p;
}

export interface StatusbarOptions {
  cwd?: string | null;
  effort?: string;
  sessionId?: string | null;
  readOnly?: boolean;
  sessionModel?: string | null;
  /** Global hide-at-zero for count/tool chips (statuslineHideZero). Default true. */
  hideZero?: boolean;
  /** Called instead of set_session_effort IPC when effort changes (e.g. pending sessions). */
  onEffortChange?: (effort: string) => void;
  /** When set, the model chip is editable (draft/pending sessions, before a real
   *  agent process is spawned) instead of showing the "locked" popover. */
  onModelChange?: (model: string) => void;
  /** Account this session is running under, for the `account` chip. */
  accountId?: string | null;
  /** Called when the `account` chip is clicked, to open the change-account picker. */
  onAccountClick?: () => void;
  /** Fired per render with the live model + effort. The statusbar owns both (the
   *  popovers commit into it), so pushing keeps the header from going stale. */
  onConfig?: (model: string | null, effort: string) => void;
}
