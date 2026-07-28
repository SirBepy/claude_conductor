// Typed bridge to the Rust backend. Replaces the deleted
// src/electron-api-shim.js. Every method here wraps a Tauri `invoke`
// call (via shared/ipc.ts) or an event subscription.
//
// Methods backing dropped MVP features (sync, piper-install, no-op update
// callbacks) are kept as stubs so callers don't crash.

import { invoke } from "./ipc";
import { isTauri } from "./transport";
import type { TokenRecord, AliasMap } from "./tokens";
import type { SettingsShape } from "./state";
import type {
  CharacterWhitelist,
  DatasetInfo,
  DatasetId,
  RetentionPolicy,
  Account,
  AccountIdentity,
  AccountsSetupPromptState,
  AddAccountSession,
  LoginCheckOutcome,
  OauthAccountInfo,
  AuthState,
} from "../types/ipc.generated";

export type { Account, AccountIdentity, AddAccountSession, LoginCheckOutcome, OauthAccountInfo, AuthState };

// ── Backend snapshot shape ────────────────────────────────────────────────

interface UsageWindow {
  utilization: number;
  resets_at?: string | null;
}
interface ExtraUsage {
  is_enabled?: boolean;
  used_credits?: number;
  monthly_limit?: number;
}
interface UsageSnapshot {
  captured_at: string;
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  extra_usage?: ExtraUsage | null;
}

// Per-model availability, from the count_tokens probe (probe_models_availability).
// `message` carries the API's reason when a model is disabled (else null).
// `authExpired` is true when a 401 survived a CLI-driven token-refresh retry
// on the backend - the account is genuinely logged out, not just "this model
// is disabled"; `available` is false in that case too (never fail-open).
export interface ModelAvailability {
  id: string;
  available: boolean;
  message: string | null;
  authExpired: boolean;
}

// Renderer-facing legacy shape (kept until views consume UsageSnapshot directly).
export interface UsageRecord {
  hour: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  extra_usage: ExtraUsage | null;
  [k: string]: unknown;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function toUsageRecord(snap: UsageSnapshot | null | undefined): UsageRecord | null {
  if (!snap || !snap.five_hour || !snap.seven_day) return null;
  const d = new Date(snap.captured_at);
  const hour = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
  return {
    hour,
    session_pct: Math.round(snap.five_hour.utilization),
    weekly_pct: Math.round(snap.seven_day.utilization),
    session_resets_at: snap.five_hour.resets_at || null,
    weekly_resets_at: snap.seven_day.resets_at || null,
    extra_usage: snap.extra_usage || null,
  };
}

function usageSnapshotMapToRecordMap(
  raw: Record<string, UsageSnapshot>,
): Record<string, UsageRecord> {
  const out: Record<string, UsageRecord> = {};
  for (const [accountId, snap] of Object.entries(raw)) {
    const rec = toUsageRecord(snap);
    if (rec) out[accountId] = rec;
  }
  return out;
}

async function fetchHistoryLegacy(): Promise<UsageRecord[]> {
  const raw = await invoke<UsageSnapshot[]>("get_history", { limit: null, accountId: null });
  return (raw || []).map(toUsageRecord).filter((r): r is UsageRecord => r !== null);
}

/** Per-account history fetch (multi-account milestone 05). `accountId: null`
 * (or omitted) mirrors the legacy aggregate query - every account's rows,
 * used before any account is registered. */
async function fetchHistoryForAccount(opts: { limit?: number; accountId?: string | null }): Promise<UsageRecord[]> {
  const raw = await invoke<UsageSnapshot[]>("get_history", {
    limit: opts.limit ?? null,
    accountId: opts.accountId ?? null,
  });
  return (raw || []).map(toUsageRecord).filter((r): r is UsageRecord => r !== null);
}

// ── Event subscription helper ─────────────────────────────────────────────

type Unlisten = () => void;

function listenEvent<T>(name: string, cb: (payload: T) => void): Unlisten {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return () => { /* no runtime */ };
  const p = ev.listen<T>(name, (e) => cb(e.payload));
  return () => { void p.then((u) => u()); };
}

// ── Typed payloads ────────────────────────────────────────────────────────

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | string;
  version?: string;
  [k: string]: unknown;
}

export interface AudioOutputDevice {
  name: string;
  is_default: boolean;
}

export interface HookRegistrationState {
  registered?: boolean;
  declined?: boolean;
  port?: number | null;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  subProcessed: number;
  subSkipped: number;
}

export interface InstanceTokenStats {
  tokens: number;
  turns: number;
  prompts?: number;
}

export type CharacterSlot =
  | "work_finished"
  | "question_asked"
  | "ready"
  | "select"
  | "annoyed"
  | "death";

export interface Character {
  id: string;
  label: string;
  version: number;
  icon: string;
  game?: string;
  game_label?: string;
  slots: { [key: string]: string[] };
}
export interface PiperStatus { [k: string]: unknown; }
export interface ProjectConfig { id: string; path: string; [k: string]: unknown; }
export interface ProjectGroup {
  id: string | null;
  path: string;
  name: string;
  parent_segment: string | null;
  avatar: { kind: string; value?: unknown };
  automation_enabled: boolean;
  tokens_7d: number;
  live: number;
  any_remote: boolean;
  any_automated: boolean;
  last_active_at: string | null;
}
export interface InstanceInfo { [k: string]: unknown; }
export interface AuthStatus { state?: string; [k: string]: unknown; }

// Remote-access (Settings > Remote access). Loose local interface, mirroring the
// app-process command's return shape; not a ts-rs generated type.
export interface RemoteAccessStatus {
  enabled: boolean;
  tailscale_up: boolean;
  serve_running: boolean;
  url: string | null;
}

export interface PairingQrResult {
  svg: string;
  url: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  created_at: number; // unix timestamp seconds
}

// ── Public API ────────────────────────────────────────────────────────────

export const api = {
  // --- Usage + history ---
  getUsageHistory: (): Promise<UsageRecord[]> => fetchHistoryLegacy(),
  getHistory: (opts: { limit?: number; accountId?: string | null } = {}): Promise<UsageRecord[]> =>
    fetchHistoryForAccount(opts),
  pollNow: (): Promise<unknown> => invoke("poll_now"),

  // --- Per-account usage (multi-account milestone 03/05) ---
  getUsageMap: async (): Promise<Record<string, UsageRecord>> => {
    try {
      const raw = (await invoke<Record<string, UsageSnapshot>>("get_usage_map")) || {};
      return usageSnapshotMapToRecordMap(raw);
    } catch (e) { console.error("get_usage_map failed", e); return {}; }
  },

  /** Click-to-refresh for the usage dials: a REAL claude.ai poll (not a cached
   * re-read), scoped to one account when `accountId` is given. On desktop
   * (Tauri) this calls the existing `poll_now` command directly, then re-reads
   * the map. On the remote/phone PWA there is no direct route to the app
   * process, so it goes through the daemon's `request_live_usage_refresh` RPC
   * instead, which forwards the request to the connected desktop app and
   * waits for a fresh snapshot to land (see daemon/methods/usage.rs). Throws
   * if the desktop app isn't reachable (remote) or the poll itself fails
   * (desktop) - callers show that as a failed-refresh state, not a silent
   * no-op. */
  refreshUsageLive: async (accountId?: string | null): Promise<Record<string, UsageRecord>> => {
    if (isTauri()) {
      await invoke("poll_now", { accountId: accountId ?? null });
      return api.getUsageMap();
    }
    const raw = await invoke<Record<string, UsageSnapshot>>("request_live_usage_refresh", {
      accountId: accountId ?? null,
    });
    return usageSnapshotMapToRecordMap(raw || {});
  },
  getAuthStateMap: async (): Promise<Record<string, AuthState>> => {
    try { return (await invoke<Record<string, AuthState>>("get_auth_state_map")) || {}; }
    catch (e) { console.error("get_auth_state_map failed", e); return {}; }
  },

  // --- Settings ---
  getSettings: (): Promise<SettingsShape | null> => invoke("get_settings"),
  saveSettings: (settings: SettingsShape): Promise<unknown> =>
    invoke("save_settings", { updated: settings }),
  /** Persist the floating overlay's parked position (physical px) so it
   * reopens where the user last dragged/flicked it. */
  saveOverlayPosition: (x: number, y: number): Promise<unknown> =>
    invoke("save_overlay_position", { x, y }),
  /** Surface the main dashboard window focused on a specific account (from an
   * overlay card click). */
  openDashboardAccount: (accountId: string): Promise<unknown> =>
    invoke("open_dashboard_account", { accountId }),
  fetchAvailableModels: (): Promise<string[]> => invoke("fetch_available_models"),
  probeModelsAvailability: (models: string[]): Promise<ModelAvailability[]> =>
    invoke("probe_models_availability", { models }),

  // --- Audio ---
  listAudioOutputDevices: async (): Promise<AudioOutputDevice[]> => {
    try { return (await invoke<AudioOutputDevice[]>("list_audio_output_devices")) || []; }
    catch (e) { console.error("list_audio_output_devices failed", e); return []; }
  },

  // --- Update state ---
  getUpdateState: (): Promise<UpdateState> => invoke("get_update_state"),
  downloadUpdate: (): void => { /* no-op stub for legacy callers */ },
  downloadAndInstall: (): Promise<unknown> => invoke("download_and_install_update"),
  installUpdate: (): Promise<unknown> => invoke("install_update"),
  checkForUpdates: (): Promise<unknown> => invoke("check_for_updates"),
  copyLogs: (): Promise<unknown> => invoke("copy_logs"),
  getAppVersion: (): Promise<string> => invoke("get_app_version"),
  getVersionInfo: (): Promise<{ version: string; build_date: string; installed_at: string | null }> =>
    invoke("get_version_info"),
  getPlatform: (): Promise<string> => invoke("get_platform"),
  openExternal: (url: string): Promise<unknown> => invoke("open_external", { url }),

  // --- Chats window ---
  openChatsForSession: async (sessionId: string, mode: "live" | "history"): Promise<void> => {
    try { await invoke("open_chats_for_session", { sessionId, mode }); }
    catch (e) { console.error("open_chats_for_session failed", e); throw e; }
  },
  takePendingChatOpen: async (): Promise<[string, string] | null> => {
    try { return (await invoke<[string, string] | null>("take_pending_chat_open")) ?? null; }
    catch (e) { console.error("take_pending_chat_open failed", e); return null; }
  },
  getSessionConfig: async (sessionId: string): Promise<{ model: string; effort: string } | null> => {
    try { return (await invoke<{ model: string; effort: string } | null>("get_session_config", { sessionId })) ?? null; }
    catch (e) { console.error("get_session_config failed", e); return null; }
  },

  // --- File system ---
  checkPathsExist: async (paths: string[]): Promise<Record<string, boolean>> => {
    try { return (await invoke<Record<string, boolean>>("check_paths_exist", { paths })) || {}; }
    catch (e) { console.error("check_paths_exist failed", e); return {}; }
  },
  openInExplorer: async (p: string): Promise<void> => {
    try { await invoke("open_in_explorer", { path: p }); }
    catch (e) { console.error("open_in_explorer failed", e); }
  },
  openInVSCode: async (p: string): Promise<void> => {
    try { await invoke("open_in_vscode", { path: p }); }
    catch (e) { console.error("open_in_vscode failed", e); }
  },

  // --- Sync (cut from MVP — stubs) ---
  syncRegister: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncLink: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncGenerateLinkCode: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncListDevices: async (): Promise<unknown[]> => [],
  syncPull: async (): Promise<null> => null,
  syncPush: async (): Promise<null> => null,

  // --- Token stats ---
  getTokenHistory: async (): Promise<TokenRecord[]> => {
    try { return (await invoke<TokenRecord[]>("get_token_history")) || []; }
    catch (e) { console.error("get_token_history failed", e); return []; }
  },
  getActiveSessions: async (): Promise<TokenRecord[]> => {
    try { return (await invoke<TokenRecord[]>("get_active_sessions")) || []; }
    catch (e) { console.error("get_active_sessions failed", e); return []; }
  },
  backfillTranscripts: async (): Promise<BackfillResult> => {
    try { return await invoke<BackfillResult>("backfill_transcripts"); }
    catch (e) {
      console.error("backfill_transcripts failed", e);
      return { processed: 0, skipped: 0, subProcessed: 0, subSkipped: 0 };
    }
  },

  // --- Characters ---
  listCharacters: (): Promise<Character[]> => invoke("list_characters"),
  assignCharacter: (projectId: string, characterId: string | null): Promise<void> =>
    invoke("assign_character", { projectId, characterId }),
  playCharacterSlot: (characterId: string, slot: CharacterSlot): Promise<void> =>
    invoke("play_character_slot", { characterId, slot }),
  characterAssetUrl: (characterId: string, file: string): Promise<string | null> =>
    invoke("character_asset_url", { characterId, file }),
  previewCharacterFile: (characterId: string, file: string): Promise<void> =>
    invoke("preview_character_file", { characterId, file }),
  stopCharacterPreview: (): Promise<void> => invoke("stop_character_preview"),
  onCharacterPreviewEnded: (cb: () => void): Unlisten =>
    listenEvent("character-preview-ended", cb),
  getCharactersDir: (): Promise<string> => invoke("get_characters_dir"),
  invalidateCharactersCache: (): Promise<void> => invoke("invalidate_characters_cache"),

  // --- Session characters ---
  ensureSessionCharacter: (sessionId: string): Promise<string | null> =>
    invoke("ensure_session_character", { sessionId }),
  setSessionCharacter: (sessionId: string, characterId: string | null): Promise<void> =>
    invoke("set_session_character", { sessionId, characterId }),
  rerollSessionCharacter: (sessionId: string): Promise<string | null> =>
    invoke("reroll_session_character", { sessionId }),
  listSessionCharacters: (): Promise<Record<string, string>> =>
    invoke("list_session_characters"),

  // --- Whitelist ---
  getProjectWhitelist: (projectId: string): Promise<CharacterWhitelist> =>
    invoke("get_project_whitelist", { projectId }),
  setProjectWhitelist: (projectId: string, whitelist: CharacterWhitelist): Promise<void> =>
    invoke("set_project_whitelist", { projectId, whitelist }),
  getDefaultWhitelist: (): Promise<CharacterWhitelist> =>
    invoke("get_default_whitelist"),
  setDefaultWhitelist: (whitelist: CharacterWhitelist): Promise<void> =>
    invoke("set_default_whitelist", { whitelist }),
  resolveWhitelistCharacters: (projectId: string): Promise<Character[]> =>
    invoke("resolve_whitelist_characters", { projectId }),

  // --- Piper TTS ---
  piperStatus: (): Promise<PiperStatus> => invoke("piper_status"),
  piperInstallVoice: (id: string): Promise<unknown> =>
    invoke("piper_install_voice", { id }),
  speakPreview: ({ text, voiceName }: { text: string; voiceName: string | null }): Promise<unknown> =>
    invoke("piper_speak_preview", { text, voiceName }),
  playSoundPreview: (filename: string): Promise<unknown> =>
    invoke("play_sound_preview", { filename }),
  piperInstallBinary: async (): Promise<{ ok: boolean; reason: string }> =>
    ({ ok: false, reason: "disabled in MVP" }),
  onPiperProgress: (_cb: (p: unknown) => void): Unlisten => () => { /* no-op */ },

  // --- Storage (Settings > Data) ---
  getStorageInfo: async (): Promise<DatasetInfo[]> => {
    try { return (await invoke<DatasetInfo[]>("get_storage_info")) || []; }
    catch (e) { console.error("get_storage_info failed", e); return []; }
  },
  setRetentionPolicy: async (dataset: DatasetId, policy: RetentionPolicy): Promise<void> => {
    try { await invoke("set_retention_policy", { dataset, policy }); }
    catch (e) { console.error("set_retention_policy failed", e); throw e; }
  },
  clearDataset: async (dataset: DatasetId): Promise<void> => {
    try { await invoke("clear_dataset", { dataset }); }
    catch (e) { console.error("clear_dataset failed", e); throw e; }
  },

  // --- Projects ---
  listProjects: (): Promise<ProjectConfig[]> => invoke("list_projects"),
  listProjectGroups: (): Promise<ProjectGroup[]> => invoke("list_project_groups"),
  // Project-face fallback detection (ai_todo 99): a project's own icon file, or
  // its detected tech-stack key. Both fail soft (null) so the list never breaks.
  getProjectTech: (root: string): Promise<string | null> => invoke("get_project_tech", { root }),
  getProjectIcon: (root: string): Promise<{ mime: string; base64: string } | null> =>
    invoke("get_project_icon", { root }),
  getProject: (id: string): Promise<ProjectConfig | null> =>
    invoke("get_project", { id }),
  ensureProject: (cwd: string): Promise<ProjectConfig> =>
    invoke("ensure_project", { cwd }),
  updateProject: async (id: string, patch: Partial<ProjectConfig>): Promise<void> => {
    try { await invoke("update_project", { id, patch }); }
    catch (e) { console.error("update_project failed", e); throw e; }
  },
  deleteProject: async (id: string): Promise<void> => {
    try { await invoke("delete_project", { id }); }
    catch (e) { console.error("delete_project failed", e); throw e; }
  },
  setProjectsSortBy: async (sortBy: string): Promise<void> => {
    try { await invoke("set_projects_sort_by", { sortBy }); }
    catch (e) { console.error("set_projects_sort_by failed", e); throw e; }
  },

  // --- Channels ---
  spawnChannel: async (projectId: string): Promise<void> => {
    try { await invoke("spawn_channel", { projectId }); }
    catch (e) { console.error("spawn_channel failed", e); throw e; }
  },
  stopChannel: async (projectId: string): Promise<void> => {
    try { await invoke("stop_channel", { projectId }); }
    catch (e) { console.error("stop_channel failed", e); throw e; }
  },
  restartChannel: async (projectId: string): Promise<void> => {
    try { await invoke("restart_channel", { projectId }); }
    catch (e) { console.error("restart_channel failed", e); throw e; }
  },
  showTerminal: async (projectId: string): Promise<void> => {
    try { await invoke("show_terminal", { projectId }); }
    catch (e) { console.error("show_terminal failed", e); throw e; }
  },
  hideTerminal: async (projectId: string): Promise<void> => {
    try { await invoke("hide_terminal", { projectId }); }
    catch (e) { console.error("hide_terminal failed", e); throw e; }
  },
  listChannels: (): Promise<unknown[]> => invoke("list_channels"),
  detectObsidianVaults: (): Promise<string[]> => invoke("detect_obsidian_vaults"),
  importLegacyObsidianConfig: (): Promise<unknown> =>
    invoke("import_legacy_obsidian_config"),
  confirmLegacyObsidianImport: (accept: boolean): Promise<unknown> =>
    invoke("confirm_legacy_obsidian_import", { accept }),

  // --- Instances ---
  listInstances: async (): Promise<InstanceInfo[]> => {
    try { return (await invoke<InstanceInfo[]>("list_instances")) || []; }
    catch (e) { console.error("list_instances failed", e); return []; }
  },
  listInstancesForProject: async (projectId: string): Promise<InstanceInfo[]> => {
    try { return (await invoke<InstanceInfo[]>("list_instances_for_project", { projectId })) || []; }
    catch (e) { console.error("list_instances_for_project failed", e); return []; }
  },
  phoneLink: async (sessionId: string): Promise<string | null> => {
    try { return await invoke<string | null>("phone_link", { sessionId }); }
    catch (e) { console.error("phone_link failed", e); return null; }
  },
  instanceTokenStats: async (sessionId: string): Promise<InstanceTokenStats> => {
    try { return await invoke<InstanceTokenStats>("instance_token_stats", { sessionId }); }
    catch (e) { console.error("instance_token_stats failed", e); return { tokens: 0, turns: 0 }; }
  },
  /** Forks a rate-limited session's transcript onto a different (non-exhausted)
   * account, sends its pending resume prompt immediately, ends the old session,
   * and drops its scheduled resume. Resolves with the NEW session id. */
  moveSessionToAccount: (sessionId: string, targetAccountId: string): Promise<string> =>
    invoke<string>("move_session_to_account", { sessionId, targetAccountId }),

  // --- Remote access (Settings > Remote access) ---
  setRemoteAccessEnabled: (enabled: boolean): Promise<void> =>
    invoke("set_remote_access_enabled", { enabled }),
  remoteAccessStatus: (): Promise<RemoteAccessStatus> =>
    invoke("remote_access_status"),
  remoteAccessQr: (): Promise<PairingQrResult> => invoke("remote_access_qr"),
  getRemoteAccessToken: (): Promise<string> => invoke("get_remote_access_token"),
  listRemoteDevices: (): Promise<RemoteDevice[]> => invoke("list_remote_devices"),
  revokeRemoteDevice: (id: string): Promise<boolean> =>
    invoke("revoke_remote_device", { id }),
  setRemoteKillSwitch: (enabled: boolean): Promise<void> =>
    invoke("set_remote_kill_switch", { enabled }),
  getRemoteKillSwitch: (): Promise<boolean> => invoke("get_remote_kill_switch"),

  // --- Hook registration ---
  getHookRegistrationState: async (): Promise<HookRegistrationState> => {
    try { return await invoke<HookRegistrationState>("get_hook_registration_state"); }
    catch (e) {
      console.error("get_hook_registration_state failed", e);
      return { registered: false, declined: false, port: null };
    }
  },
  registerHooksGlobally: async (): Promise<void> => {
    try { await invoke("register_hooks_globally"); }
    catch (e) { console.error("register_hooks_globally failed", e); throw e; }
  },
  skipHookRegistration: async (): Promise<void> => {
    try { await invoke("skip_hook_registration"); }
    catch (e) { console.error("skip_hook_registration failed", e); throw e; }
  },

  // --- Event subscriptions ---
  onUpdateStateChange: (cb: (s: UpdateState) => void): Unlisten =>
    listenEvent("update-state", cb),
  onHistoryUpdated: (cb: (h: UsageRecord[]) => void): Unlisten =>
    listenEvent("usage-updated", async () => {
      try { cb(await fetchHistoryLegacy()); }
      catch (e) { console.error("onHistoryUpdated refetch failed", e); }
    }),
  onTokenHistoryUpdated: (cb: (th: TokenRecord[]) => void): Unlisten =>
    listenEvent<TokenRecord[]>("token-history-updated", (payload) => {
      try { cb(payload || []); }
      catch (err) { console.error("onTokenHistoryUpdated handler threw", err); }
    }),
  onChannelsChanged: (cb: (payload: unknown) => void): Unlisten =>
    listenEvent("channels-changed", cb),
  onInstancesChanged: (cb: (list: unknown) => void): Unlisten =>
    listenEvent("instances-changed", (payload) => {
      try { cb(payload || []); }
      catch (err) { console.error("onInstancesChanged handler threw", err); }
    }),

  // --- Skill usage ---
  getSkillUsageWeek: async (): Promise<import("../types/ipc.generated").SkillUsageWeek> => {
    try { return await invoke<import("../types/ipc.generated").SkillUsageWeek>("get_skill_usage_week"); }
    catch (e) { console.error("get_skill_usage_week failed", e); return { entries: [], total_sessions: 0 }; }
  },
  getSkillUsageDetail: async (
    skill: string,
  ): Promise<import("../types/ipc.generated").SkillDetail> => {
    try { return await invoke<import("../types/ipc.generated").SkillDetail>("get_skill_usage_detail", { skill }); }
    catch (e) {
      console.error("get_skill_usage_detail failed", e);
      return { skill, invocations: { total: 0, manual: 0, skill: 0, auto: 0 }, events: [] };
    }
  },
  listInstalledSkills: async (): Promise<import("../types/ipc.generated").InstalledSkill[]> => {
    try { return (await invoke<import("../types/ipc.generated").InstalledSkill[]>("list_installed_skills")) || []; }
    catch (e) { console.error("list_installed_skills failed", e); return []; }
  },
  onSkillUsageChanged: (cb: () => void): Unlisten =>
    listenEvent("skill-usage-changed", () => cb()),
  onDaemonStatus: (cb: (status: { connected: boolean }) => void): Unlisten =>
    listenEvent<{ connected: boolean }>("daemon-status-changed", cb),

  // --- Accounts (multi-account milestone 01: add-account wizard) ---
  addAccountCreate: (label: string, slug: string | null): Promise<AddAccountSession> =>
    invoke("add_account_create", { label, slug }),
  /** Spawns the /login terminal for the wizard session; resolves with the
   * terminal window title. Browser-first flow: only called when the profile
   * dir has no credentials yet (or the user skipped the browser step). */
  addAccountStartCliLogin: (sessionId: string): Promise<string> =>
    invoke("add_account_start_cli_login", { sessionId }),
  addAccountCheckLogin: (sessionId: string): Promise<LoginCheckOutcome> =>
    invoke("add_account_check_login", { sessionId }),
  /** Browser-login step: captures the cookie AND derives the account identity
   * from it (GET /api/account). Resolves with that identity. */
  addAccountCaptureCookie: (sessionId: string): Promise<OauthAccountInfo> =>
    invoke("add_account_capture_cookie", { sessionId }),
  addAccountCancel: (sessionId: string): Promise<void> =>
    invoke("add_account_cancel", { sessionId }),
  addAccountFinalize: (
    sessionId: string,
    label: string,
    colour: string,
    icon: string,
  ): Promise<Account> =>
    invoke("add_account_finalize", { sessionId, label, colour, icon }),
  listAccounts: async (): Promise<Account[]> => {
    try { return (await invoke<Account[]>("list_accounts")) || []; }
    catch (e) { console.error("list_accounts failed", e); return []; }
  },
  removeAccount: (accountId: string): Promise<void> =>
    invoke("remove_account", { accountId }),
  logoutAccount: (accountId: string): Promise<void> =>
    invoke("logout_account", { accountId }),
  setDefaultAccount: (accountId: string | null): Promise<void> =>
    invoke("set_default_account", { accountId }),
  /** Rename/recolour/re-icon an existing account. Omitted fields are left
   * untouched (all three are optional so the edit panel can send only what
   * changed). */
  updateAccount: (
    accountId: string,
    updates: { label?: string; colour?: string; icon?: string },
  ): Promise<Account> =>
    invoke("update_account", {
      accountId,
      label: updates.label ?? null,
      colour: updates.colour ?? null,
      icon: updates.icon ?? null,
    }),
  getTerminalIdentity: async (): Promise<OauthAccountInfo | null> => {
    try { return (await invoke<OauthAccountInfo | null>("get_terminal_identity")) ?? null; }
    catch (e) { console.error("get_terminal_identity failed", e); return null; }
  },

  // --- Accounts (multi-account milestone 07: settings identity surface) ---
  getAccountIdentity: async (accountId: string): Promise<AccountIdentity | null> => {
    try { return await invoke<AccountIdentity>("get_account_identity", { accountId }); }
    catch (e) { console.error("get_account_identity failed", e); return null; }
  },
  reauthAccount: (accountId: string): Promise<void> =>
    invoke("reauth_account", { accountId }),
  recaptureAccountCookie: (accountId: string): Promise<void> =>
    invoke("recapture_account_cookie", { accountId }),

  // --- Accounts (multi-account milestone 08: legacy migration prompt) ---
  getAccountsSetupPromptState: async (): Promise<AccountsSetupPromptState> => {
    try { return await invoke<AccountsSetupPromptState>("get_accounts_setup_prompt_state"); }
    catch (e) { console.error("get_accounts_setup_prompt_state failed", e); return { shouldShow: false }; }
  },
  dismissAccountsSetupPrompt: (): Promise<void> =>
    invoke("dismiss_accounts_setup_prompt"),
};

export type Api = typeof api;

// Avoid `AliasMap` becoming a removed-import warning if a downstream view
// later imports it via re-export.
export type { AliasMap };
