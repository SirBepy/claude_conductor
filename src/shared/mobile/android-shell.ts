// The Android shell injects `window.ConductorPush` (see native-push.ts), so its
// presence tells the shell apart from a phone browser or a desktop browser tab,
// which `isRemote()` alone cannot.
export function isAndroidShell(): boolean {
  return typeof window !== "undefined" && !!(window as { ConductorPush?: unknown }).ConductorPush;
}
