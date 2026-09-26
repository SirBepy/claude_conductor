// Custom Windows-only title bar: a dedicated 32px control strip (minimize/
// maximize/close) mounted above the app's existing .view-header, which stays
// completely unchanged. Windows desktop windows ship `decorations(false)`
// (see src-tauri/src/ipc/window/{mod,chats}.rs); this replaces the native
// chrome those windows no longer have. macOS/Linux keep native decorations
// and never mount this. The phone/PWA build (isRemote()) has no native
// window to replace either. Picked over the earlier "merge into
// .view-header" option because it keeps drag region and interactive header
// buttons (burger/⋮) in separate rows with no hit-testing overlap (Joe,
// 2026-09-25 /mockup session).
import "./window-titlebar.css";
import { isTauri } from "./transport";

// withGlobalTauri = true, so the window API lives on the global - same loose
// typing as overlay-drag.ts, which has no bundled @tauri-apps/api types.
interface TauriWindowApi {
  getCurrentWindow: () => TauriWindow;
}
interface TauriWindow {
  label: string;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
}

function tauriWindow(): TauriWindowApi | null {
  return (window as unknown as { __TAURI__?: { window?: TauriWindowApi } }).__TAURI__?.window ?? null;
}

// The only two window labels built with decorations(false) on Windows - see
// build_main_window/build_chats_window. Every other Tauri window this SPA can
// boot into (detached session, schedule, preview pop-out) keeps native
// decorations and must never get this bar.
const TITLEBAR_WINDOW_LABELS = new Set(["main", "session-chats"]);

function mount(appWin: TauriWindow): void {
  if (document.getElementById("win-titlebar")) return;
  const bar = document.createElement("div");
  bar.id = "win-titlebar";
  bar.className = "win-titlebar-controls";
  bar.setAttribute("data-tauri-drag-region", "");
  bar.innerHTML = `
    <button type="button" class="win-ctrl-btn" data-action="minimize" title="Minimize"><i class="ph ph-minus"></i></button>
    <button type="button" class="win-ctrl-btn" data-action="maximize" title="Maximize">
      <i class="ph ph-square icon-maximize"></i><span class="win-restore-icon icon-restore"></span>
    </button>
    <button type="button" class="win-ctrl-btn win-ctrl-close" data-action="close" title="Close"><i class="ph ph-x"></i></button>
  `;
  document.body.insertBefore(bar, document.body.firstChild);

  bar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "minimize") void appWin.minimize();
    else if (action === "maximize") void appWin.toggleMaximize();
    else if (action === "close") void appWin.close();
  });

  const syncMaximized = (): void => {
    void appWin.isMaximized().then((maxed) => bar.classList.toggle("maxed", maxed));
  };
  syncMaximized();
  void appWin.onResized(syncMaximized);
}

/** Call once at boot. No-op unless: Tauri + Windows + this window is "main" or "session-chats". */
export function initWindowTitlebar(): void {
  if (!isTauri()) return;
  if (!navigator.userAgent.includes("Windows")) return;
  const appWin = tauriWindow()?.getCurrentWindow();
  if (!appWin || !TITLEBAR_WINDOW_LABELS.has(appWin.label)) return;

  if (document.body) mount(appWin);
  else document.addEventListener("DOMContentLoaded", () => mount(appWin));
}
