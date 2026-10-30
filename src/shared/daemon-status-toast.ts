import { api } from "./api";
import { showToast } from "./toast";

/**
 * Toasts a daemon drop and its recovery. `daemon-status-changed` is an app-wide
 * event, so only the window that owns the app toasts (see `ownsAppToasts`)
 * shows them; the others still track the connection state so a window that
 * takes ownership later does not announce a recovery it never saw drop.
 */
export function wireDaemonStatusToasts(ownsToasts: boolean): void {
  let wasConnected = true;
  api.onDaemonStatus((s) => {
    if (!s.connected) {
      wasConnected = false;
      if (ownsToasts) showToast("Daemon disconnected - reconnecting...");
    } else if (!wasConnected) {
      wasConnected = true;
      if (ownsToasts) showToast("Daemon reconnected.");
    }
  });
}
