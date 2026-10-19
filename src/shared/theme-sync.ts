// Theme + animated-background painting shared by every window that renders
// the SPA (main, Chats, detached single-chat, Code pop-out).

import { applyBackgroundFx } from "./background-fx";
import type { SettingsShape } from "./state";

/** Paints a settings object's theme and background onto this window. The
 * theme is stored flat ("nord" | "nord-light"); the DOM carries it as the
 * styleguide's 2D pair, data-theme=<palette> + data-mode=light|dark. */
export function applyAppearance(s: SettingsShape): void {
  const fullId = (s.theme as string) || "void";
  const isLight = fullId.endsWith("-light");
  const el = document.documentElement;
  el.dataset.theme = isLight ? fullId.slice(0, -"-light".length) : fullId;
  el.dataset.mode = isLight ? "light" : "dark";
  applyBackgroundFx(
    !!s.backgroundEnabled,
    s.backgroundVariant === "gradient" ? "gradient" : "pattern",
  );
}

/** Each Tauri window is its own webview realm, so a theme picked in the main
 * window's Settings reaches the others only through the app-wide
 * `settings-changed` event, whose payload is the full saved Settings. A no-op
 * without the Tauri runtime (the phone, where Settings can't change the theme).
 * Returns the unlisten function. */
export function followAppearanceChanges(): () => void {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  const p = listen<SettingsShape>("settings-changed", (e) => {
    if (e.payload) applyAppearance(e.payload);
  });
  return () => { void p.then((u) => u()); };
}
