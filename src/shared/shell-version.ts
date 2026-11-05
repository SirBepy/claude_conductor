/**
 * The installed Android shell's own version, for Settings > About on the phone.
 *
 * The page the phone shows is served by the PC, so it has no Tauri global and
 * cannot ask the APK anything. The shell (android/src/app.js `handoff`) puts its
 * version on the URL it opens as `?shellv=`; this module keeps it.
 */

export const SHELL_VERSION_KEY = "conductor_shell_version";

/** Reads `?shellv=` off the current URL, stores it, and removes it from the
 *  address. Stored (not held in memory) because the param is gone after the
 *  first load and an in-page reload must still know the version. The shell
 *  rewrites it on every launch, so an updated APK replaces the old value; an
 *  APK from before this existed never sends one, and the value stays absent. */
export function captureShellVersion(): void {
  if (typeof location === "undefined") return;
  try {
    const url = new URL(location.href);
    const raw = url.searchParams.get("shellv")?.trim();
    if (raw === undefined) return;
    if (raw) localStorage.setItem(SHELL_VERSION_KEY, raw);
    url.searchParams.delete("shellv");
    const query = url.searchParams.toString();
    history.replaceState(null, "", url.pathname + (query ? `?${query}` : "") + url.hash);
  } catch { /* storage or history unavailable: the version just stays unknown */ }
}

/** The shell version last reported by the APK, or null if it never sent one. */
export function readShellVersion(): string | null {
  try {
    return localStorage.getItem(SHELL_VERSION_KEY)?.trim() || null;
  } catch {
    return null;
  }
}
