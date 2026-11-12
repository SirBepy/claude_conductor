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
const CARD_CLASS = "draft-subchats-card";

/** Longest the row waits for the rail card before showing itself anyway. */
const RAIL_WAIT_MS = 4000;

const TIP ="Hand the jobs you name to hidden child chats that report back here. Switching it on moves the chat to Opus at high effort or better.";

/** What the chat was on before the switch moved it to the main-chat model, so
 *  switching back puts it right unless the user picked something else meanwhile. */
interface Applied {
  /** The draft this was captured for; a remount of the same draft keeps it. */
  config: SessionConfig;
  before: { model: string; effort: string };
  applied: { model: string; effort: string };
}

let _applied: Applied | null = null;

/** The pending reveal of the current mount; a later mount or unmount cancels it so it
 *  cannot show another draft's row early. */
let _revealTimer: ReturnType<typeof setTimeout> | null = null;

/** Every live copy of the switch in the pane: the row above the message box, the rail's
 *  card, or both. A card inside the dashboard's fading ghost (draft-dashboard.ts) is
 *  not one: it is a dead clone, and removing it would cut the fade short. */
function hostsOf(pane: ParentNode): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(`.${HOST_CLASS}, .${CARD_CLASS}`)].filter((el) => !el.closest(".pd-ghost"));
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
    _applied = { config, before, applied };
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

/** Repaints every copy of the switch from the config: its state, its tooltip, and
 *  whether the account the draft is on allows the mode at all. */
export function syncDraftSubchats(pane: ParentNode, config: SessionConfig): void {
  const hosts = hostsOf(pane);
  if (hosts.length === 0) return;
  const blocked = subchatsBlockedReason(config.accountId);
  // An account moved to API credit under a draft that had the mode on: the daemon
  // would refuse the spawn, so the switch goes off here instead.
  if (blocked && config.subchatsOn) setOn(config, false);
  const on = config.subchatsOn === true;
  for (const host of hosts) {
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.checked = on;
    input.disabled = !!blocked;
    host.classList.toggle("is-on", on);
    host.title = blocked ?? TIP;
  }
}

function wire(host: HTMLElement, pane: ParentNode, config: SessionConfig): void {
  host.querySelector("input")!.addEventListener("change", (e) => {
    setOn(config, (e.target as HTMLInputElement).checked);
    syncDraftSubchats(pane, config);
  });
  syncDraftSubchats(pane, config);
}

/** Puts the switch as a row just above the draft's message box. It is the home
 *  wherever the dashboard has no settings rail (the phone, a group, a rail that
 *  never loads); once the rail's card mounts it takes over. Call after the pane's
 *  markup exists; the dashboard's quick-action chips are inserted later and land
 *  between this row and the box. */
export function mountDraftSubchats(pane: HTMLElement, config: SessionConfig): void {
  unmountDraftSubchats(pane);
  // A remount of the same draft must not re-capture: its config already holds the
  // switched values, so "before" would become the main-chat model and the chip the
  // user changed would be overwritten.
  const sameDraft = _applied?.config === config;
  if (!sameDraft) _applied = null;
  // A draft opens with the mode already on (resolveNewChatConfig), but its chips
  // still show the project's model: move them to the main-chat model now, the way
  // the switch would, so what the chips show is what the first spawn uses and
  // switching off still puts the project's model back. A reopened draft whose
  // user switched it off carries `false` and is left alone.
  if (config.subchatsOn === true && !subchatsBlockedReason(config.accountId) && !sameDraft) setOn(config, true);
  insertRow(pane, config, true);
  // The dashboard's rail loads after its snapshot, so the row stays unseen until we know
  // the rail is not coming; this covers a rail that fails to fill or never mounts.
  _revealTimer = setTimeout(() => revealDraftSubchats(pane), RAIL_WAIT_MS);
}

/** Shows the row once the dashboard has no rail card to replace it. A no-op when the
 *  card already took over (the row is gone) or the row is already visible. */
export function revealDraftSubchats(pane: ParentNode): void {
  pane.querySelector(`.${HOST_CLASS}.is-pending`)?.classList.remove("is-pending");
}

function insertRow(pane: ParentNode, config: SessionConfig, pending = false): void {
  const shell = pane.querySelector(".composer-shell");
  if (!shell?.parentElement) return;
  const host = document.createElement("div");
  // Pending keeps the row out of the layout, so a rail card that retires it moments later
  // never flashes it above the message box.
  host.className = pending ? `${HOST_CLASS} is-pending` : HOST_CLASS;
  host.innerHTML = [
    `<i class="ph ph-tree-structure" aria-hidden="true"></i>`,
    `<span class="draft-subchats-label">Use subchats</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Use subchats"><span class="slider"></span></label>`,
  ].join("");
  shell.parentElement.insertBefore(host, shell);
  wire(host, pane, config);
}

/** Adds a "This chat" group under the dashboard rail's project settings, built from
 *  the rail's own group and line classes, and retires the row above the message box:
 *  the card is where per-chat choices live, with room for more. */
export function mountDraftSubchatsCard(pane: HTMLElement, railBody: HTMLElement, config: SessionConfig): void {
  const settings = railBody.querySelector(".view-project-settings") ?? railBody;
  settings.querySelector(`.${CARD_CLASS}`)?.remove();
  const card = document.createElement("div");
  card.className = `ps-group ${CARD_CLASS}`;
  card.innerHTML = [
    `<div class="ps-group-title">This chat</div>`,
    `<div class="ps-line">`,
    `<span class="ps-label">Use subchats</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Use subchats"><span class="slider"></span></label>`,
    `</div>`,
  ].join("");
  settings.append(card);
  pane.querySelector(`.${HOST_CLASS}`)?.remove();
  wire(card, pane, config);
}

/** Freezes the switch while the first send is in flight, so a flip cannot change
 *  what the spawn already took. Unlocking repaints from the config, which keeps
 *  an account-blocked switch disabled. */
export function lockDraftSubchats(pane: ParentNode, config: SessionConfig, locked: boolean): void {
  const hosts = hostsOf(pane);
  // The send took the dashboard and its rail card down before the spawn answered, and
  // nothing brings them back: a failed spawn gets the row, so the draft keeps a switch
  // for the choice its config still carries. `_applied` stays, so switching off restores.
  if (hosts.length === 0) {
    if (!locked) insertRow(pane, config);
    return;
  }
  if (locked) for (const host of hosts) host.querySelector<HTMLInputElement>("input")!.disabled = true;
  else syncDraftSubchats(pane, config);
}

export function unmountDraftSubchats(pane: ParentNode): void {
  if (_revealTimer) clearTimeout(_revealTimer);
  _revealTimer = null;
  for (const host of hostsOf(pane)) host.remove();
}
