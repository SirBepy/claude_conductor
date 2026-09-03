// Kebab (⋮) menu for the Jarvis singleton's detached window (Part B). Jarvis
// has no in-app pane - it only ever lives at `#detached?session=<id>`, which
// otherwise has zero header chrome (see `session-header.ts`'s
// `addKebabButton`, wired only when `Instance.jarvis` is true). Five actions:
// restart (kill+resume the same session id), clear context (kill+discard,
// lands on a NEW id), change character (reused verbatim from
// active-session-account.ts), open jarvis-home in VS Code/Explorer, and copy PID. No
// Auto-accept toggle here - Part A locks it permanently on.
//
// `buildChatMenuBlock` (chat-menu.ts) builds a much bigger "This chat" menu
// and its `appendSubMenu`/`makeSubParent`/`makeItem` helpers are private to
// that function - not reusable here. This is a minimal local dropdown reusing
// the same `session-more-menu`/`smore-item` CSS classes (sessions.css) so it
// looks identical to every other 3-dot menu in the app.

import { invoke } from "../../shared/ipc";
import { askConfirm } from "../../shared/confirm";
import { state, setActiveSession } from "./state";
import { positionDropdown, positionSubmenu } from "./position-dropdown";
import { changeCharacterForSession } from "./active-session-account";

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

/** Shared by restart and clear-context: invoke, then re-mount the pane on the
 *  returned session id. Clearing the active id first forces a full re-mount
 *  even when the id is unchanged (restart's case). */
async function invokeAndRemount(sessionId: string, command: string, failLabel: string): Promise<void> {
  try {
    const newId = await invoke<string>(command, { sessionId });
    const pane = document.querySelector<HTMLElement>("#session-pane");
    if (!pane) return;
    const m = await import("./active-session");
    setActiveSession(null);
    await m.selectSession(newId, pane);
  } catch (e) {
    console.error(`[jarvis-menu] ${failLabel} failed`, e);
    alert(`Failed to ${failLabel}: ${e}`);
  }
}

/** "Restart Jarvis": force-kills the daemon's live child and respawns it
 *  resuming the SAME session id (never a fork). */
async function restartJarvis(sessionId: string): Promise<void> {
  await invokeAndRemount(sessionId, "restart_jarvis_session", "restart Jarvis");
}

/** "Clear context": discards the whole transcript, lands on a NEW session id.
 *  Confirms first since a menu click carries no typed intent the way "/clear"
 *  does, and the wipe can't be undone. */
async function clearContext(sessionId: string): Promise<void> {
  const ok = await askConfirm(
    "Clear Jarvis's context? This permanently discards its whole conversation history and starts fresh.",
    { confirmLabel: "Clear", danger: true },
  );
  if (!ok) return;
  await invokeAndRemount(sessionId, "clear_jarvis_context", "clear Jarvis's context");
}

// headerStatusClass lives in active-session.ts, which statically imports
// `openJarvisKebabMenu` from this file - a dynamic import here avoids the cycle.
async function changeCharacter(sessionId: string): Promise<void> {
  const { headerStatusClass } = await import("./active-session");
  await changeCharacterForSession(sessionId, headerStatusClass);
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
