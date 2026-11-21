// "Continue the plan?" (pc-1806 step 6): the part above a reopened main chat's composer that asks
// what to do with the subs the put-away paused. A part of the chat pane, not a daemon card: the
// daemon holds the paused subs (and the wakes queued behind them) until this is answered, and
// `put_away_paused` is the one source of what is waiting, so a restart or another window shows
// the same question.
//
// Yes: every paused sub resumes, staggered under the start cap by the daemon. No: a checklist of
// the paused subs drawn as the `after` tree. Ticking a sub stops it and ticks what waits for it
// (pre-ticked, each can be unticked); an unticked sub that waited for a stopped one runs without
// that wait. The rest resume and their `after` chains stay scheduled.

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import { showToast } from "../../shared/toast";
import type { Instance } from "../../types/ipc.generated";
import { isSubchatsOn } from "./permission-modal/gating";
import { readPaused } from "./reopen-main";
import {
  answeredToast, checklistRows, confirmLabel, NO_TICKS, priorWords, questionLine, releasedSubs, subLabel, toggle,
  type PausedSubView, type Ticks,
} from "./continue-plan-model";
import "./continue-plan.css";

const PART = "continue-plan";
/** Fallback for the exit: a transitionend that never comes (reduced motion, a hidden pane) must not leave the part behind. */
const EXIT_FALLBACK_MS = 400;

/** Whether the chat can have paused subs to ask about: a main-chat-mode chat on this PC that is not put away. */
export function asksContinuePlan(sess: Instance | undefined): sess is Instance {
  return !!sess && !sess.subchat_of && !sess.hidden_at && !sess.ended_at && !sess.machine && !isRemote()
    && isSubchatsOn(sess.session_id);
}

function slotOf(pane: ParentNode): HTMLElement | null {
  return pane.querySelector<HTMLElement>(".continue-plan-slot");
}

/** Takes the part out with its exit transition; the node stays until the transition ends. */
function leave(slot: HTMLElement): void {
  const part = slot.querySelector<HTMLElement>(`.${PART}`);
  if (!part) return;
  part.classList.remove("is-open");
  let gone = false;
  const done = (): void => {
    if (gone) return;
    gone = true;
    part.remove();
  };
  part.addEventListener("transitionend", (e) => { if (e.target === part) done(); });
  setTimeout(done, EXIT_FALLBACK_MS);
}

/** Draws (or removes) the part for `sess` from the daemon's record. `alive` says the pane still
 *  belongs to this chat, so a slow read after a chat switch never draws into another chat's pane. */
export async function syncContinuePlan(pane: HTMLElement, sess: Instance, alive: () => boolean): Promise<void> {
  if (!asksContinuePlan(sess)) return;
  const fam = await readPaused(sess.session_id);
  if (!alive()) return;
  const slot = slotOf(pane);
  if (!slot) return;
  const paused = fam && !fam.hidden ? fam.paused : [];
  const existing = slot.querySelector<HTMLElement>(`.${PART}`);
  if (paused.length === 0) {
    if (existing) leave(slot);
    return;
  }
  // The same question again (a re-select while it is on screen) is patched by leaving it alone: a
  // rebuild would replay the entrance and drop the ticks the user already made.
  if (existing && existing.dataset.subs === paused.map((s) => s.sub_id).join(",")) return;
  existing?.remove();
  mount(slot, sess.session_id, paused);
}

function mount(slot: HTMLElement, mainId: string, paused: PausedSubView[]): void {
  const part = document.createElement("section");
  part.className = PART;
  part.setAttribute("role", "group");
  part.setAttribute("aria-label", "Continue the plan?");
  part.dataset.subs = paused.map((s) => s.sub_id).join(",");
  part.innerHTML = [
    `<div class="cpl-inner"><div class="cpl-body">`,
    `<div class="cpl-head"><i class="ph-fill ph-play-circle cpl-icon"></i><strong class="cpl-title">Continue the plan?</strong>`,
    `<button type="button" class="cpl-close" aria-label="Ask me later" title="Ask me later"><i class="ph ph-x"></i></button></div>`,
    `<p class="cpl-line"></p>`,
    `<ul class="cpl-list" hidden></ul>`,
    `<div class="cpl-actions"></div>`,
    `</div></div>`,
  ].join("");
  slot.appendChild(part);

  let ticks: Ticks = NO_TICKS;
  let busy = false;
  const line = part.querySelector<HTMLElement>(".cpl-line")!;
  const list = part.querySelector<HTMLElement>(".cpl-list")!;
  const actions = part.querySelector<HTMLElement>(".cpl-actions")!;

  const button = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cpl-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => { if (!busy) onClick(); });
    return b;
  };

  const answer = async (end: string[]): Promise<void> => {
    busy = true;
    part.classList.add("is-busy");
    part.querySelectorAll("button, input").forEach((el) => ((el as HTMLButtonElement | HTMLInputElement).disabled = true));
    try {
      const r = await invoke<{ ended: number; resuming: number }>("resume_paused", { sessionId: mainId, end });
      showToast(answeredToast(r.ended, r.resuming));
      leave(slot);
    } catch (err) {
      console.error("[sessions] resume_paused failed", err);
      showToast(`Could not continue the plan: ${String(err)}`);
      busy = false;
      part.classList.remove("is-busy");
      part.querySelectorAll("button, input").forEach((el) => ((el as HTMLButtonElement | HTMLInputElement).disabled = false));
    }
  };

  const drawAsk = (): void => {
    line.textContent = questionLine(paused);
    list.hidden = true;
    actions.replaceChildren(
      button("cpl-yes", paused.length === 1 ? "Yes, resume it" : "Yes, resume them", () => { void answer([]); }),
      button("cpl-no", "No", () => drawPick()),
    );
  };

  /** Patches the checklist in place: a tick must not rebuild rows (the entrance would replay under the pointer). */
  const patchPick = (): void => {
    const released = new Set(releasedSubs(paused, ticks.ticked).map((s) => s.sub_id));
    for (const li of list.querySelectorAll<HTMLElement>(".cpl-row")) {
      const id = li.dataset.id!;
      const on = ticks.ticked.has(id);
      li.classList.toggle("is-ticked", on);
      li.classList.toggle("is-released", released.has(id));
      li.querySelector<HTMLInputElement>("input")!.checked = on;
      li.querySelector<HTMLElement>(".cpl-note")!.textContent = released.has(id) ? "runs without waiting" : "";
    }
    const confirm = actions.querySelector<HTMLButtonElement>(".cpl-confirm");
    if (confirm) confirm.textContent = confirmLabel(paused, ticks.ticked);
  };

  const drawPick = (): void => {
    ticks = NO_TICKS;
    line.textContent = "Tick what to stop. Ticking one also ticks what waits for it. The rest resume.";
    list.replaceChildren();
    for (const [i, row] of checklistRows(paused).entries()) {
      const li = document.createElement("li");
      li.className = "cpl-row";
      li.dataset.id = row.sub.sub_id;
      li.style.setProperty("--depth", String(row.depth));
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<label><input type="checkbox"><span class="cpl-name">${escapeHtml(subLabel(row.sub))}</span><span class="cpl-prior">${escapeHtml(priorWords(row.sub))}</span><span class="cpl-note"></span></label>`;
      li.querySelector("input")!.addEventListener("change", () => {
        if (busy) return;
        ticks = toggle(paused, ticks, row.sub.sub_id);
        patchPick();
      });
      list.appendChild(li);
    }
    list.hidden = false;
    actions.replaceChildren(
      button("cpl-confirm cpl-yes", confirmLabel(paused, ticks.ticked), () => { void answer([...ticks.ticked]); }),
      button("cpl-back", "Back", () => drawAsk()),
    );
    patchPick();
  };

  part.querySelector<HTMLButtonElement>(".cpl-close")!.addEventListener("click", () => {
    if (busy) return;
    leave(slot);
    // The daemon keeps the subs and their queued wakes held, so the way back is said out loud:
    // the pane is built again (and the question drawn again) when the chat is selected anew.
    showToast("The subs stay paused. Switch to another chat and back to be asked again.");
  });

  drawAsk();
  // One frame after insertion, so the entrance has a start state to move from.
  requestAnimationFrame(() => part.classList.add("is-open"));
}
