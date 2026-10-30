// The project dashboard inside a new-chat draft: the dashboard fills the empty
// message list, its quick-action chips sit right above the message box, and
// both come down as soon as the first message is sent.
import { invoke } from "../../../shared/ipc";
import { state } from "../state";
import { mountDashboard, type DashboardHandle } from "./dashboard";
import { fadeOutAndFold, freezeEntrance } from "./dash-motion";
import { targetForRepo } from "./format";
import type { DashboardListRow, DashboardTargetRef } from "./types";

// The list only changes when groups or projects do, so back-to-back drafts share one fetch.
const TARGETS_TTL_MS = 10_000;
let targetsCache: { at: number, rows: Promise<DashboardListRow[]> } | null = null;

function listTargets(): Promise<DashboardListRow[]> {
  if (targetsCache && Date.now() - targetsCache.at < TARGETS_TTL_MS) return targetsCache.rows;
  // A daemon without the method answers null rather than failing.
  const rows = invoke<DashboardListRow[] | null>("dashboard_list_targets").then((r) => r ?? []).catch((err) => {
    console.warn("[project-dashboard] dashboard_list_targets failed", err);
    targetsCache = null;
    return [];
  });
  targetsCache = { at: Date.now(), rows };
  return rows;
}

/** Drops the cached list after anything that changes which dashboard a repo
 *  resolves to (a group edited or deleted, a folder repointed or hidden). */
export function forgetTargets(): void {
  targetsCache = null;
}

/** The dashboard a repo opens (its group's when it has one). */
export async function resolveTarget(cwd: string, projectId: string | null = null): Promise<DashboardTargetRef> {
  return targetForRepo(await listTargets(), cwd, projectId);
}

let current: DashboardHandle | null = null;

/** Takes the draft's dashboard and chip row down. Safe to call when there is none. */
export function unmountDraftDashboard(pane: HTMLElement): void {
  current?.destroy();
  current = null;
  // A fading copy left by leaveDraftDashboard removes itself when its fold
  // ends; the send's header rebind lands mid-fade and must not cut it short.
  pane.querySelector(".pd-draft:not(.pd-ghost)")?.remove();
  pane.querySelector(".pd-qa-host.is-draft:not(.pd-ghost)")?.remove();
}

/** An iframe cloned with the tree reloads its srcdoc, which can blank or flash
 *  mid-fade. Each copy's frame becomes a block of the live frame's height
 *  (frames pair up by document order, the clone preserving it) that inherits
 *  the card's background; the live frame is the one the user last saw. */
function freezeHtmlFrames(live: HTMLElement, ghost: HTMLElement): void {
  const liveFrames = live.querySelectorAll<HTMLIFrameElement>("iframe.pd-html-frame");
  ghost.querySelectorAll("iframe.pd-html-frame").forEach((frame, i) => {
    const block = document.createElement("div");
    block.className = "pd-html-frame-ghost";
    block.style.height = `${liveFrames[i]?.offsetHeight ?? 0}px`;
    frame.replaceWith(block);
  });
}

/** The first send: the dashboard and its chips fade out and fold away instead
 *  of vanishing, so the message that follows slides up rather than jumps. The
 *  live dashboard comes down at once (no more events or fetches); what fades
 *  is a copy left in its place. */
export function leaveDraftDashboard(pane: HTMLElement): void {
  const parts = [pane.querySelector<HTMLElement>(".pd-draft:not(.pd-ghost)"), pane.querySelector<HTMLElement>(".pd-qa-host.is-draft:not(.pd-ghost)")];
  const ghosts = parts.flatMap((el) => {
    if (!el || !el.firstElementChild) return [];
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add("pd-ghost");
    freezeEntrance(el, ghost);
    freezeHtmlFrames(el, ghost);
    el.after(ghost);
    return [ghost];
  });
  unmountDraftDashboard(pane);
  for (const ghost of ghosts) fadeOutAndFold(ghost);
}

/** Mounts into a draft pane built by pending-pane-mount.ts. Must run after the
 *  renderer has attached (it clears .session-messages). No-op when a newer
 *  mount has taken the pane by the time the target resolves. */
export function mountDraftDashboard(pane: HTMLElement, project: { path: string }, myMount: number): void {
  if (state.mountId !== myMount) return;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return;
  unmountDraftDashboard(pane);
  const wrap = document.createElement("div");
  wrap.className = "pd-draft";
  messagesEl.prepend(wrap);

  void resolveTarget(project.path).then((ref) => {
    if (state.mountId !== myMount || !wrap.isConnected) return;
    const handle = mountDashboard(ref, {
      mode: "draft",
      pane,
      leave: () => { /* a draft is left by the normal chat switch */ },
      back: () => { /* no back from a draft */ },
      deselect: () => unmountDraftDashboard(pane),
    });
    current = handle;
    wrap.appendChild(handle.root);
    if (handle.rail) {
      // Widens the draft's column past the chat's 900px to make room for the rail (sessions.css).
      wrap.classList.add("has-rail");
      wrap.appendChild(handle.rail);
    }
    // Outside .composer-shell, whose border wraps only the thinking bar and the input.
    const shell = pane.querySelector(".composer-shell");
    shell?.parentElement?.insertBefore(handle.chips, shell);
  });
}
