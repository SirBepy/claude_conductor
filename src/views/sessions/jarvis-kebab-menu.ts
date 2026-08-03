// Kebab (⋮) menu for the Jarvis singleton's detached window (Part B). Jarvis
// has no in-app pane - it only ever lives at `#detached?session=<id>`, which
// otherwise has zero header chrome (see `session-header.ts`'s
// `addKebabButton`, wired only when `Instance.jarvis` is true). Five actions:
// restart (kill+resume the same session id), clear context (kill+discard,
// lands on a NEW id), change character (reused verbatim from
// active-session.ts), open jarvis-home in VS Code/Explorer, and copy PID. No
// Auto-accept toggle here - Part A locks it permanently on.
//
// `buildChatMenuBlock` (chat-menu.ts) builds a much bigger "This chat" menu
// and its `appendSubMenu`/`makeSubParent`/`makeItem` helpers are private to
// that function - not reusable here. This is a minimal local dropdown reusing
// the same `session-more-menu`/`smore-item` CSS classes (sessions.css) so it
// looks identical to every other 3-dot menu in the app.

import { invoke } from "../../shared/ipc";
import { state, setActiveSession } from "./state";
import { positionDropdown, positionSubmenu } from "./position-dropdown";

let _menu: HTMLElement | null = null;
let _sub: HTMLElement | null = null;

function closeSub(): void {
  _sub?.remove();
  _sub = null;
}

function closeMenu(): void {
  closeSub();
  _menu?.remove();
  _menu = null;
}

document.addEventListener("click", (e) => {
  if (!_menu) return;
  const target = e.target as Node;
  if (_menu.contains(target) || _sub?.contains(target)) return;
  closeMenu();
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && _menu) closeMenu();
});

function makeItem(
  icon: string,
  label: string,
  onClick: () => void | Promise<void>,
  disabledReason?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "smore-item" + (disabledReason ? " is-disabled" : "");
  if (disabledReason) btn.title = disabledReason;
  btn.innerHTML = `<i class="ph ph-${icon}"></i>${label}`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (disabledReason) return;
    closeMenu();
    void onClick();
  });
  return btn;
}

/** "Restart Jarvis": force-kills the daemon's live child and respawns it
 *  resuming the SAME session id (never a fork). The id doesn't change, so
 *  `selectSession` would otherwise early-return on "already selected" -
 *  clearing the active id first forces the full re-mount (same precedent
 *  `active-session.ts`'s `mountRenderer` bail-out callback uses). */
async function restartJarvis(sessionId: string): Promise<void> {
  try {
    const newId = await invoke<string>("restart_jarvis_session", { sessionId });
    const pane = document.querySelector<HTMLElement>("#session-pane");
    if (!pane) return;
    const m = await import("./active-session");
    setActiveSession(null);
    await m.selectSession(newId, pane);
  } catch (e) {
    console.error("[jarvis-menu] restart failed", e);
    alert(`Failed to restart Jarvis: ${e}`);
  }
}

/** "Clear context": unlike Restart above, this discards the whole transcript
 *  and lands on a NEW session id, so (unlike restartJarvis) there's no
 *  "already selected" bail-out to route around - it's a normal fresh mount.
 *  Confirms first since a menu click carries no typed intent the way "/clear"
 *  does, and the wipe can't be undone. */
async function clearContext(sessionId: string): Promise<void> {
  if (!confirm("Clear Jarvis's context? This permanently discards its whole conversation history and starts fresh.")) return;
  try {
    const newId = await invoke<string>("clear_jarvis_context", { sessionId });
    const pane = document.querySelector<HTMLElement>("#session-pane");
    if (!pane) return;
    const m = await import("./active-session");
    setActiveSession(null);
    await m.selectSession(newId, pane);
  } catch (e) {
    console.error("[jarvis-menu] clear context failed", e);
    alert(`Failed to clear Jarvis's context: ${e}`);
  }
}

// Dynamic import of active-session.ts (not a static one) avoids a module
// cycle: active-session.ts statically imports `openJarvisKebabMenu` from
// this file to wire the header button.
async function changeCharacter(sessionId: string): Promise<void> {
  const m = await import("./active-session");
  await m.changeCharacterForSession(sessionId);
}

export function openJarvisKebabMenu(anchor: HTMLElement, sessionId: string): void {
  closeMenu();
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const cwd = sess?.cwd ? String(sess.cwd) : null;
  const pid = sess?.pid ?? null;

  const menu = document.createElement("div");
  menu.className = "session-more-menu";
  document.body.appendChild(menu);
  _menu = menu;

  menu.appendChild(makeItem("arrow-clockwise", "Restart Jarvis", () => restartJarvis(sessionId)));
  menu.appendChild(makeItem("eraser", "Clear context", () => clearContext(sessionId)));
  menu.appendChild(makeItem("user-switch", "Change character", () => changeCharacter(sessionId)));

  // "Open jarvis-home in ▸" submenu - same open-in machinery as chat-menu.ts's
  // "Open project in" block (open_in_vscode / open_in_explorer), pointed at
  // this session's cwd (Jarvis always spawns in `<data-dir>/jarvis-home`).
  const openParent = document.createElement("button");
  openParent.className = "smore-item smore-has-sub" + (cwd ? "" : " is-disabled");
  if (!cwd) openParent.title = "No project directory";
  openParent.innerHTML =
    `<i class="ph ph-folder-open"></i>Open jarvis-home in<i class="ph ph-caret-right smore-sub-caret"></i>`;
  openParent.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!cwd) return;
    if (_sub) { closeSub(); return; }
    const sub = document.createElement("div");
    sub.className = "session-more-menu";
    sub.appendChild(makeItem("code", "VS Code", async () => {
      try { await invoke<void>("open_in_vscode", { path: cwd }); }
      catch { /* code may not be installed */ }
    }));
    sub.appendChild(makeItem("folder-notch-open", "File Explorer", async () => {
      try { await invoke<void>("open_in_explorer", { path: cwd }); }
      catch (err) { alert(`Failed to open file explorer: ${err}`); }
    }));
    document.body.appendChild(sub);
    _sub = sub;
    positionSubmenu(sub, openParent);
  });
  menu.appendChild(openParent);

  menu.appendChild(makeItem(
    "copy",
    "Copy PID",
    () => { void navigator.clipboard.writeText(String(pid)); },
    pid ? undefined : "No active agent",
  ));

  positionDropdown(menu, anchor, { align: "right" });
}
