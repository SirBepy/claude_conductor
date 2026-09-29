// Stale-safe settings writer (todo 1004). `save_settings` now rejects a save
// built from an out-of-date snapshot instead of blind-overwriting or merging
// a fixed field allowlist - see src-tauri/src/settings/store.rs::reconcile_save.
// Every call site that used to build a `Settings` object from the frontend's
// own cache (`state.ts`'s `currentSettings`, which a concurrent daemon-owned
// write can leave behind) should go through `updateSettings` instead, so its
// own edit is always applied on top of the CURRENT backend state, not a
// stale one.

import { invoke } from "./ipc";
import { setSettings } from "./state";
import type { SettingsShape } from "./state";

const SETTINGS_STALE = "SETTINGS_STALE";
const MAX_ATTEMPTS = 3;

/** Same sentinel-matching shape as `isSessionBusyError` (session-busy.ts) -
 *  a Tauri command's `Err(String)` rejects the invoke promise with that raw
 *  string, not necessarily wrapped in an `Error`. */
function isStaleSettingsError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err) === SETTINGS_STALE;
}

/**
 * Reads settings fresh from the backend (`get_settings`, never the frontend's
 * possibly-stale `currentSettings` cache), applies `mutate` to that fresh
 * copy, and saves the result. `mutate` may return a new object or mutate and
 * return nothing (the fresh copy is then used as-is).
 *
 * `save_settings` rejects with `SETTINGS_STALE` when another writer (a
 * daemon-owned field, or a concurrent save) landed after this read - on that
 * error this re-reads and reruns `mutate` from scratch against the new
 * current state, up to `MAX_ATTEMPTS` total tries, so only the caller's own
 * edit is ever reapplied, never a half-applied previous attempt layered on
 * top of an already-stale base. Any other error propagates immediately.
 *
 * On success, updates the frontend's settings cache (`state.ts`'s
 * `setSettings`/`currentSettings`) the same way a successful save always has,
 * so a `getSettings()` read right after sees the saved value. `extra` and
 * every field `mutate` doesn't touch round-trip untouched, since `mutate`
 * runs on the full fresh object, not a subset.
 */
export async function updateSettings(
  mutate: (settings: SettingsShape) => SettingsShape | void,
): Promise<SettingsShape> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fresh = await invoke<SettingsShape>("get_settings");
    const result = mutate(fresh);
    const candidate = result ?? fresh;
    try {
      await invoke("save_settings", { updated: candidate });
      setSettings(candidate);
      return candidate;
    } catch (err) {
      if (!isStaleSettingsError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
