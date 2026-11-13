// The "Use subchats" choice on a new-chat draft. A live chat flips the mode from
// its menu (chat-menu-items.ts), but a draft has no session to flip, and a flip
// after the first spawn only reaches the next respawn. So the draft carries the
// choice in its config and the first `start_session` hands it to the daemon.
import type { SessionConfig } from "../../shared/effort-presets";
import { state } from "./state";
import { savePendingSession } from "./pending-draft-storage";
import { mainChatLaunch, subchatsBlockedReason } from "./subchats-gate";
import { goesToLine, mainChatFor, type ProjectMainChat } from "./project-main-chats";
import { escapeHtml } from "../../shared/escape-html";
import "./draft-subchats.css";

const HOST_CLASS = "draft-subchats";
const CARD_CLASS = "draft-subchats-card";
// The same slot when the project has a main chat: "Goes to ..." and Plain chat instead.
const ROUTE_CLASS = "draft-main-route";
const ROUTE_CARD_CLASS = "draft-main-route-card";

/** Longest the row waits for the rail card before showing itself anyway. */
const RAIL_WAIT_MS = 4000;

const TIP ="Hand the jobs you name to hidden child chats that report back here. Switching it on raises the chat to high effort or better.";

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

/** Every live copy of the "Goes to" slot in the pane (see [hostsOf]). */
function routeHostsOf(pane: ParentNode): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(`.${ROUTE_CLASS}, .${ROUTE_CARD_CLASS}`)].filter((el) => !el.closest(".pd-ghost"));
}

/** Where this draft's first message goes: the project's main chat, unless the draft
 *  is a plain chat, aims at another machine, or the project has no open main chat.
 *  A draft opened with a message already in hand (`initialMessage`: the dashboard's
 *  card chats, `/pickup`) is a fresh chat by design, never a message into another chat:
 *  a card chat starts without auto-accept so text it embeds meets a permission prompt. */
export function draftRouteTarget(config: SessionConfig): ProjectMainChat | null {
  const path = state.pendingNewSession?.projectPath;
  if (!path || config.plainChat === true || config.machineId || config.initialMessage) return null;
  return mainChatFor(path, state.sessions);
}

/** "Plain chat instead" on: a chat of its own with no subchats, the project's model
 *  back on the chip. Off: the message goes to the main chat again, and the chip
 *  shows the main-chat model it will run on. */
function setPlain(config: SessionConfig, plain: boolean): void {
  writeConfig(config, { plainChat: plain });
  const want = !plain && !subchatsBlockedReason(config.accountId);
  // Only on a real change: a second setOn(true) would capture the main-chat model as
  // the one to restore.
  if ((config.subchatsOn === true) !== want) setOn(config, want);
}

function wireRoute(host: HTMLElement, pane: ParentNode, config: SessionConfig): void {
  host.querySelector("input")!.addEventListener("change", (e) => {
    setPlain(config, (e.target as HTMLInputElement).checked);
    syncDraftSubchats(pane, config);
  });
}

/** Repaints the "Goes to" slot: shown while the project has a main chat, and the
 *  "Use subchats" slot it replaces is hidden then. */
function syncRoute(pane: ParentNode, config: SessionConfig): ProjectMainChat | null {
  const path = state.pendingNewSession?.projectPath;
  // Same exceptions as `draftRouteTarget`, so the slot never promises a route the send will not take.
  const main = path && !config.machineId && !config.initialMessage ? mainChatFor(path, state.sessions) : null;
  const plain = config.plainChat === true;
  for (const host of hostsOf(pane)) host.hidden = !!main;
  for (const host of routeHostsOf(pane)) {
    host.hidden = !main;
    if (!main) continue;
    const { title, project } = goesToLine(main);
    const line = host.querySelector<HTMLElement>(".dmr-line")!;
    line.innerHTML = plain
      ? `A plain chat, not ${escapeHtml(project)}'s main chat`
      : `Goes to <strong>${escapeHtml(title)}</strong>, ${escapeHtml(project)}'s main chat`;
    host.querySelector<HTMLInputElement>("input")!.checked = plain;
    host.classList.toggle("is-on", !plain);
  }
  return main;
}

/** Repaints every copy of the switch from the config: its state, its tooltip, and
 *  whether the account the draft is on allows the mode at all. */
export function syncDraftSubchats(pane: ParentNode, config: SessionConfig): void {
  syncRoute(pane, config);
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
  // The route row goes first so the Use subchats row stays the one right above the box.
  insertRouteRow(pane, config, true);
  insertRow(pane, config, true);
  syncDraftSubchats(pane, config);
  // The dashboard's rail loads after its snapshot, so the row stays unseen until we know
  // the rail is not coming; this covers a rail that fails to fill or never mounts.
  _revealTimer = setTimeout(() => revealDraftSubchats(pane), RAIL_WAIT_MS);
}

/** Shows the row once the dashboard has no rail card to replace it. A no-op when the
 *  card already took over (the row is gone) or the row is already visible. */
export function revealDraftSubchats(pane: ParentNode): void {
  pane.querySelector(`.${HOST_CLASS}.is-pending`)?.classList.remove("is-pending");
  pane.querySelector(`.${ROUTE_CLASS}.is-pending`)?.classList.remove("is-pending");
}

function insertRouteRow(pane: ParentNode, config: SessionConfig, pending = false): void {
  const shell = pane.querySelector(".composer-shell");
  if (!shell?.parentElement) return;
  const host = document.createElement("div");
  host.className = pending ? `${ROUTE_CLASS} is-pending` : ROUTE_CLASS;
  host.hidden = true;
  host.innerHTML = [
    `<i class="ph ph-arrow-bend-down-right" aria-hidden="true"></i>`,
    `<span class="dmr-line"></span>`,
    `<span class="draft-subchats-label">Plain chat instead</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Plain chat instead"><span class="slider"></span></label>`,
  ].join("");
  shell.parentElement.insertBefore(host, shell);
  wireRoute(host, pane, config);
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

/** Puts the switch in the draft rail (titled "This chat", dashboard.ts), built from
 *  the rail's own group and line classes, above its line into the project's settings,
 *  and retires the row above the message box: the rail is where per-chat choices live. */
export function mountDraftSubchatsCard(pane: HTMLElement, railBody: HTMLElement, config: SessionConfig): void {
  const settings = railBody.querySelector(".view-project-settings") ?? railBody;
  // insertBefore(x, null) appends, for a rail without that line.
  const before = settings.querySelector(":scope > .ps-open-settings");
  settings.querySelector(`.${CARD_CLASS}`)?.remove();
  const card = document.createElement("div");
  card.className = `ps-group ${CARD_CLASS}`;
  card.innerHTML = [
    `<div class="ps-line">`,
    `<span class="ps-label">Use subchats</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Use subchats"><span class="slider"></span></label>`,
    `</div>`,
  ].join("");
  settings.insertBefore(card, before);
  pane.querySelector(`.${HOST_CLASS}`)?.remove();
  wire(card, pane, config);

  // The "Goes to" version of the same group, shown instead while the project has a
  // main chat. Its own element, so the Use subchats card keeps exactly one input.
  settings.querySelector(`.${ROUTE_CARD_CLASS}`)?.remove();
  const route = document.createElement("div");
  route.className = `ps-group ${ROUTE_CARD_CLASS}`;
  route.hidden = true;
  route.innerHTML = [
    `<div class="ps-line"><span class="ps-label dmr-line"></span></div>`,
    `<div class="ps-line">`,
    `<span class="ps-label">Plain chat instead</span>`,
    `<label class="switch"><input type="checkbox" aria-label="Plain chat instead"><span class="slider"></span></label>`,
    `</div>`,
  ].join("");
  settings.insertBefore(route, before);
  pane.querySelector(`.${ROUTE_CLASS}`)?.remove();
  wireRoute(route, pane, config);
  syncDraftSubchats(pane, config);
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
    if (!locked) {
      if (routeHostsOf(pane).length === 0) insertRouteRow(pane, config);
      insertRow(pane, config);
      syncDraftSubchats(pane, config);
    }
    return;
  }
  if (locked) for (const host of [...hosts, ...routeHostsOf(pane)]) host.querySelector<HTMLInputElement>("input")!.disabled = true;
  else {
    for (const host of routeHostsOf(pane)) host.querySelector<HTMLInputElement>("input")!.disabled = false;
    syncDraftSubchats(pane, config);
  }
}

export function unmountDraftSubchats(pane: ParentNode): void {
  if (_revealTimer) clearTimeout(_revealTimer);
  _revealTimer = null;
  for (const host of [...hostsOf(pane), ...routeHostsOf(pane)]) host.remove();
}

/** Makes the open draft a plain chat, always. A message built from third-party text (a
 *  dashboard card action typed into the draft) must start a chat of its own: neither a
 *  message into the project's main chat under that chat's own auto-accept, nor a new main
 *  chat that would become the project's. A draft that would not have routed is plain too,
 *  since it opens with the mode on and would otherwise spawn as the project's main chat. */
export function forceDraftPlain(): void {
  const pending = state.pendingNewSession;
  if (!pending || pending.firstMessageSent) return;
  setPlain(pending.config, true);
  const pane = document.getElementById("session-pane");
  if (pane) syncDraftSubchats(pane, pending.config);
}

/** Repaints the open draft, if any, after the project's main chat or its title
 *  changed under it: the pointer was re-read, or the chat closed or was renamed. */
export function resyncOpenDraft(): void {
  const pending = state.pendingNewSession;
  const pane = document.getElementById("session-pane");
  if (!pending || pending.firstMessageSent || !pane) return;
  syncDraftSubchats(pane, pending.config);
}
