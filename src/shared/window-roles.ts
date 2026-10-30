/**
 * Which window owns the app-wide duties that every window sharing the main
 * entry point would otherwise repeat or mask. The Chats window is the app's one
 * desktop window; pop-outs (Code, Files, Schedule, Preview, detached sessions)
 * run the same entry point beside it.
 */

export const CHATS_WINDOW_LABEL = "session-chats";

/**
 * Whether this window feeds the Rust renderer-crash watchdog. Chats only: the
 * ping timestamp is shared and unscoped, so a pop-out that also pinged would
 * keep it fresh forever and hide a frozen Chats renderer.
 */
export function runsRendererHeartbeat(windowLabel: string | undefined): boolean {
  return windowLabel === CHATS_WINDOW_LABEL;
}

/**
 * Whether this window shows the app-wide toasts (daemon disconnected/reconnected,
 * the settings-load notice). Those events reach every window that runs the boot
 * sequence, so exactly one must own them or one drop toasts repeatedly. On
 * desktop that is the Chats window; a browser or phone client has no Chats
 * window and is its own single owner.
 */
export function ownsAppToasts(chatsWindowMode: boolean, remote: boolean): boolean {
  return chatsWindowMode || remote;
}
