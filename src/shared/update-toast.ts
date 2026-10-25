import { api } from "./api";
import { isRemote } from "./transport";
import { showToast } from "./toast";

// Persisted so "what's new" shows exactly once after the app restarts into a
// new version; in-memory would re-toast on every launch.
const LAST_SEEN_KEY = "lastSeenAppVersion";
const TTL_MS = 10000;

function releaseUrl(version: string): string {
  return `https://github.com/SirBepy/claude_conductor/releases/tag/tauri-v${version}`;
}

function openChangelog(version: string): void {
  void api.openExternal(releaseUrl(version)).catch((e) => console.warn("[update-toast] open failed", e));
}

/** Toasts "Updated to vX, restart to apply" when an install lands (the
 * updater reports `downloaded` once the installer has run), and "Updated to vX"
 * on the first launch after the version changed. Skipped on the phone, where
 * the version is the PC's and the toast would be about a restart it can't do.
 * A fresh install (nothing recorded) only records the version. */
export function setupUpdateToast(): void {
  if (isRemote()) return;

  void api.getAppVersion().then((running) => {
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_SEEN_KEY); } catch { /* storage blocked */ }
    try { localStorage.setItem(LAST_SEEN_KEY, running); } catch { /* storage blocked */ }
    if (last && last !== running) {
      showToast(`Updated to v${running}`, { ttlMs: TTL_MS, onClick: () => openChangelog(running) });
    }
  }).catch((e) => console.warn("[update-toast] version check failed", e));

  let toasted: string | null = null;
  api.onUpdateStateChange((s) => {
    if (s.state !== "downloaded" || !s.version || toasted === s.version) return;
    toasted = s.version;
    const v = s.version;
    showToast(`Updated to v${v}, restart to apply`, { ttlMs: TTL_MS, onClick: () => openChangelog(v) });
  });
}
