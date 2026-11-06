// The "Use subchats" choice on a new-chat draft. A live chat flips the mode from
// its menu (chat-menu-items.ts), but a draft has no session to flip, and a flip
// after the first spawn only reaches the next respawn. So the draft carries the
// choice in its config and the first `start_session` hands it to the daemon.
import type { SessionConfig } from "../../shared/effort-presets";
import { state } from "./state";
import { savePendingSession } from "./pending-draft-storage";
import { mainChatLaunch, subchatsBlockedReason } from "./subchats-gate";
import "./draft-subchats.css";

const HOST_CLASS = "draft-subchats";

const TIP = "Hand the jobs you name to hidden child chats that report back here. Switching it on moves the chat to Opus at high effort or better.";

/** What the chat was on before the switch moved it to the main-chat model, so
 *  switching back puts it right unless the user picked something else meanwhile. */
interface Applied {
  before: { model: string; effort: string };
  applied: { model: string; effort: string };
}

let _applied: Applied | null = null;

function hostOf(pane: ParentNode): HTMLElement | null {
  return pane.querySelector<HTMLElement>(`.${HOST_CLASS}`);
}

/** Writes `patch` into the draft's config and the persisted copy of it, the way an
 *  account pick does (pending-pane-mount.ts), so a reload keeps the choice. */
function writeConfig(config: SessionConfig, patch: Partial<SessionConfig>): void {
  Object.assign(config, patch);
  const pending = state.pendingNewSession;
  if (pending) {
    Object.assign(pending.config, patch);
    savePendingSession(pending);
  }
}

function setOn(config: SessionConfig, on: boolean): void {
  if (on) {
    const before = { model: config.model, effort: config.effort };
    const applied = mainChatLaunch(before.model, before.effort);
    _applied = { before, applied };
    writeConfig(config, { subchatsOn: true, ...applied });
    state.statusbar?.syncModelEffort(applied.model, applied.effort);
    return;
  }
  const restore = _applied && config.model === _applied.applied.model && config.effort === _applied.applied.effort
    ? _applied.before
    : null;
  _applied = null;
  writeConfig(config, { subchatsOn: false, ...restore });
  if (restore) state.statusbar?.syncModelEffort(restore.model, restore.effort);
}

/** Repaints the row from the config: the switch, its tooltip, and whether the
 *  account the draft is on allows the mode at all. */
export function syncDraftSubchats(pane: ParentNode, config: SessionConfig): void {
  const host = hostOf(pane);
  const input = host?.querySelector<HTMLInputElement>("input");
  if (!host || !input) return;
  const blocked = subchatsBlockedReason(config.accountId);
  // An account moved to API credit under a draft that had the mode on: the daemon
  // would refuse the spawn, so the switch goes off here instead.
  if (blocked && config.subchatsOn) setOn(config, false);
  const on = config.subchatsOn === true;
  input.checked = on;
  input.disabled = !!blocked;
  host.classList.toggle("is-on", on);
  host.title = blocked ?? TIP;
}

/** Puts the row just above the draft's message box. Call after the pane's markup
 *  exists; the dashboard's quick-action chips are inserted later and land between
 *  this row and the box. */
export function mountDraftSubchats(pane: HTMLElement, config: SessionConfig): void {
  unmountDraftSubchats(pane);
  const shell = pane.querySelector(".composer-shell");
  if (!shell?.parentElement) return;
  _applied = null;
  const host = document.createElement("div");
  host.className = HOST_CLASS;
  host.innerHTML = [
    `<i class="ph ph-tree-structure" aria-hidden="true"></i>`,
    `<span class="draft-subchats-label">Use subchats</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Use subchats"><span class="slider"></span></label>`,
  ].join("");
  shell.parentElement.insertBefore(host, shell);
  host.querySelector("input")!.addEventListener("change", (e) => {
    setOn(config, (e.target as HTMLInputElement).checked);
    syncDraftSubchats(pane, config);
  });
  syncDraftSubchats(pane, config);
}

/** Freezes the switch while the first send is in flight, so a flip cannot change
 *  what the spawn already took. Unlocking repaints from the config, which keeps
 *  an account-blocked switch disabled. */
export function lockDraftSubchats(pane: ParentNode, config: SessionConfig, locked: boolean): void {
  const input = hostOf(pane)?.querySelector<HTMLInputElement>("input");
  if (!input) return;
  if (locked) input.disabled = true;
  else syncDraftSubchats(pane, config);
}

export function unmountDraftSubchats(pane: ParentNode): void {
  hostOf(pane)?.remove();
}
