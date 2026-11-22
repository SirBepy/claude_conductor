// The run section of the dashboard's Plan card (pc-1804 step 5): the plan the main chat holds with `run_plan`.
// One row per chain of lanes, each lane a pill with its state, then the steps after them
// (a review gate, the chat's own steps), whose "after ..." names open from "Then". Owns its DOM
// inside the Plan card's `.rn-host` (like the Answers, Subchats and Tests cards) and PATCHES it in
// place; the dashboard moves the host itself across a redraw of the Plan card, so it is never
// rebuilt while the run lives: a lane turning done changes its pill and the bar, so no enter animation replays and
// nothing under the pointer is rebuilt. Raises nothing: a place to look, not a Waiting item.

import "./run-card.css";
import { escapeHtml } from "../../../shared/escape-html";
import { markChatMenu } from "../../../shared/chat/chat-menu-target";
import {
  PHASE_LABEL, STEP_LABEL, endAfter,
  type RunChain, type RunState, type RunStep, type RunStepStatus,
} from "../../../shared/chat/dashboard/run-model";

export interface RunCardHost {
  /** Opens a lane's chat (the Subchats card's own opener). */
  openSub(subId: string): void;
  /** The finished run's x: hides it until the chat makes another one. */
  clear(): void;
}

/** A leaving element is removed when its transition ends, or after this if none arrives. */
const LEAVE_FALLBACK_MS = 400;

const ICONS: Readonly<Record<RunStepStatus, string>> = {
  waiting: "ph-hourglass-simple",
  ready: "ph-hand-pointing",
  running: "ph-circle-notch",
  done: "ph-check-circle",
  blocked: "ph-warning-circle",
  skipped: "ph-skip-forward",
};

const SHELL = `<div class="rn-top"><span class="rn-name"></span><span class="rn-chip"></span><span class="rn-count"></span>`
  + `<button type="button" class="rn-x" data-rn-act="clear" title="Clear" aria-label="Clear the finished run"><i class="ph ph-x"></i></button></div>`
  + `<div class="rn-bar" role="progressbar" aria-label="Steps done"><i></i></div>`
  + `<div class="rn-chains"></div>`
  // "Then" opens the row that names the lanes the steps behind the chains wait for.
  + `<div class="rn-end"><div class="rn-end-in"><div class="rn-end-row">`
  + `<button type="button" class="rn-end-l" data-rn-act="after" aria-expanded="false"><span>Then</span><i class="ph ph-caret-right" aria-hidden="true"></i></button>`
  + `<div class="rn-steps"></div></div>`
  + `<div class="rn-after-fold" inert><div class="rn-after"><span class="rn-after-w">after</span><span class="rn-refs"></span></div></div></div></div>`;

export class RunCard {
  private host: HTMLElement | null = null;
  private disposed = false;
  /** Pending fallback timers, cleared with the card so none fires on a disposed one. */
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly cb: RunCardHost) {}

  /** Draws `state` into `host`, patching what is there. */
  update(host: HTMLElement, state: RunState): void {
    if (this.host !== host) {
      this.host = host;
      host.innerHTML = SHELL;
      // Enters from its folded look once, here; a host moved across a redraw of the card is not new.
      host.classList.add("is-new");
      void host.offsetHeight;
      host.classList.remove("is-new");
      host.addEventListener("click", (e) => this.onClick(e));
      // The "after" names light up the lane they point at, by pointer or by keyboard focus.
      host.addEventListener("mouseover", (e) => this.lightRef(e.target, true));
      host.addEventListener("mouseout", (e) => this.lightRef(e.target, false));
      host.addEventListener("focusin", (e) => this.lightRef(e.target, true));
      host.addEventListener("focusout", (e) => this.lightRef(e.target, false));
    }
    const q = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
    host.dataset["phase"] = state.phase;
    setText(q(".rn-name"), state.title || "Run");
    q(".rn-name").title = state.goal;
    setText(q(".rn-chip"), PHASE_LABEL[state.phase]);
    setText(q(".rn-count"), `${state.done} of ${state.total}`);
    const bar = q(".rn-bar");
    bar.style.setProperty("--f", String(state.total > 0 ? state.done / state.total : 0));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(state.total));
    bar.setAttribute("aria-valuenow", String(state.done));
    this.syncChains(q(".rn-chains"), state.chains);
    const end = q(".rn-end");
    end.classList.toggle("is-on", state.end.length > 0);
    this.syncKeyed(q(".rn-steps"), state.end, (s) => s.id, (s) => this.buildStep(s, false), (el, s) => this.patchStep(el, s));
    const refs = endAfter(state.chains, state.end);
    this.syncRefs(q(".rn-refs"), refs);
    // With no lane to name, "Then" is a plain label and a row left open folds shut.
    q<HTMLButtonElement>(".rn-end-l").disabled = refs.length === 0;
    if (refs.length === 0) this.setAfterOpen(end, false);
  }

  /** Opens or folds the "after" row. Folded, its names leave the tab order and the accessibility tree. */
  private setAfterOpen(end: HTMLElement, open: boolean): void {
    end.classList.toggle("is-open", open);
    end.querySelector(".rn-end-l")?.setAttribute("aria-expanded", String(open));
    end.querySelector<HTMLElement>(".rn-after-fold")?.toggleAttribute("inert", !open);
    // Folded shut, the names are gone from the page, so none may stay lit.
    if (!open) this.lightOff();
  }

  /** The "after" names, rebuilt only when the lanes or their titles change, so a name under the
   *  pointer is never replaced by a state tick. */
  private syncRefs(parent: HTMLElement, refs: readonly { id: string; title: string }[]): void {
    const sig = refs.map((r) => `${r.id}\u0000${r.title}`).join("\u0001");
    if (parent.dataset["sig"] === sig) return;
    // The lane a rebuilt name pointed at must not stay lit.
    this.lightOff();
    parent.dataset["sig"] = sig;
    parent.replaceChildren(...refs.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rn-ref";
      b.dataset["rnRef"] = r.id;
      b.textContent = r.title;
      return b;
    }));
  }

  /** Lights (or clears) the lane an "after" name points at, and its row. */
  private lightRef(target: EventTarget | null, on: boolean): void {
    const ref = (target as HTMLElement | null)?.closest?.<HTMLElement>(".rn-ref");
    if (!ref || !this.host?.contains(ref)) return;
    const id = ref.dataset["rnRef"];
    const lane = Array.from(this.host.querySelectorAll<HTMLElement>(".rn-lane")).find((el) => el.dataset["key"] === id);
    lane?.classList.toggle("is-ref", on);
    lane?.closest(".rn-chain")?.classList.toggle("is-ref", on);
  }

  private lightOff(): void {
    this.host?.querySelectorAll(".is-ref").forEach((el) => el.classList.remove("is-ref"));
  }

  detach(): void {
    this.host = null;
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.host = null;
  }

  private later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const x = t.closest<HTMLElement>("[data-rn-act='clear']");
    if (x && this.host?.contains(x)) {
      // The section fades first (the host is removed by the next derive), so it never pops out.
      const card = this.host;
      if (card.classList.contains("is-leaving")) return;
      card.classList.add("is-leaving");
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (!this.disposed) this.cb.clear();
      };
      card.addEventListener("transitionend", (ev) => {
        if (ev.target === card && ev.propertyName === "opacity") finish();
      });
      this.later(finish, LEAVE_FALLBACK_MS);
      return;
    }
    const tog = t.closest<HTMLElement>("[data-rn-act='after']");
    if (tog && this.host?.contains(tog)) {
      const end = tog.closest<HTMLElement>(".rn-end");
      if (end) this.setAfterOpen(end, !end.classList.contains("is-open"));
      return;
    }
    const lane = t.closest<HTMLElement>("[data-rn-sub]");
    const sub = lane?.dataset["rnSub"];
    if (lane && sub && this.host?.contains(lane)) this.cb.openSub(sub);
  }

  /** Chain rows keyed by their first lane; each row folds open from 0fr and shut again. */
  private syncChains(parent: HTMLElement, chains: readonly RunChain[]): void {
    this.syncKeyed(
      parent, chains, (c) => c.key,
      () => {
        const el = document.createElement("div");
        el.className = "rn-chain";
        el.innerHTML = `<div class="rn-chain-in"></div>`;
        return el;
      },
      (el, c) => {
        const inner = el.querySelector<HTMLElement>(".rn-chain-in")!;
        this.syncKeyed(inner, c.lanes, (s) => s.id, (s) => this.buildStep(s, true), (lane, s) => this.patchStep(lane, s));
        // An arrow only where a lane really waits for the one before it: a fork's second branch
        // sits after its sibling in the row but waits for the same lane they share.
        const live = (Array.from(inner.children) as HTMLElement[]).filter((el) => !el.classList.contains("is-leaving"));
        c.lanes.forEach((s, i) => live[i]?.classList.toggle("is-branch", i > 0 && !s.after.includes(c.lanes[i - 1]!.id)));
      },
    );
  }

  /** Keeps `parent`'s children in the order of `items`: one the list already has is patched in
   *  place, a new one is built, enters from its folded state, and one that went folds away and is
   *  removed at the end of the transition. */
  private syncKeyed<T>(
    parent: HTMLElement, items: readonly T[], key: (t: T) => string,
    build: (t: T) => HTMLElement, patch: (el: HTMLElement, t: T) => void,
  ): void {
    const have = new Map<string, HTMLElement>();
    for (const el of Array.from(parent.children) as HTMLElement[]) {
      if (el.dataset["key"] !== undefined && !el.classList.contains("is-leaving")) have.set(el.dataset["key"], el);
    }
    const want = new Set(items.map(key));
    for (const [k, el] of have) {
      if (want.has(k)) continue;
      el.classList.add("is-leaving");
      const drop = (): void => el.remove();
      el.addEventListener("transitionend", (ev) => {
        if (ev.target === el && (ev.propertyName === "grid-template-columns" || ev.propertyName === "grid-template-rows")) drop();
      });
      this.later(drop, LEAVE_FALLBACK_MS);
      have.delete(k);
    }
    let prev: HTMLElement | null = null;
    for (const item of items) {
      const k = key(item);
      let el = have.get(k);
      const fresh = !el;
      if (!el) {
        el = build(item);
        el.dataset["key"] = k;
        el.classList.add("is-new");
      }
      patch(el, item);
      // Live nodes sit in item order, leaving ones stay where they were until they are gone.
      const at: Element | null = prev ? prev.nextElementSibling : parent.firstElementChild;
      if (at !== el) parent.insertBefore(el, at);
      if (fresh) {
        // One reflow so the first frame is the folded one and is-new then transitions it open.
        void el.offsetHeight;
        el.classList.remove("is-new");
      }
      prev = el;
    }
  }

  /** A lane pill (arrow before it) or an end step pill. A lane of a started sub is a button that
   *  opens its chat; a step of the main chat's own is plain text. */
  private buildStep(step: RunStep, lane: boolean): HTMLElement {
    const el = document.createElement("span");
    el.className = lane ? "rn-lane" : "rn-lane rn-end-step";
    const body = step.subId
      ? `<button type="button" class="rn-pill" data-rn-sub="${escapeHtml(step.subId)}">`
      : `<span class="rn-pill">`;
    const close = step.subId ? "</button>" : "</span>";
    el.innerHTML = `<span class="rn-lane-in">${lane ? `<i class="ph ph-caret-right rn-arrow" aria-hidden="true"></i>` : ""}`
      + `${body}<i class="ph rn-ic"></i><span class="rn-t"></span>${step.owner === "main" ? `<em class="rn-who">you</em>` : ""}${close}</span>`;
    if (step.subId) {
      const pill = el.querySelector<HTMLElement>(".rn-pill");
      if (pill) markChatMenu(pill, step.subId);
    }
    return el;
  }

  private patchStep(el: HTMLElement, step: RunStep): void {
    if (el.dataset["st"] !== step.status) {
      const first = el.dataset["st"] === undefined;
      el.dataset["st"] = step.status;
      const ic = el.querySelector<HTMLElement>(".rn-ic");
      if (ic) {
        ic.className = `ph ${ICONS[step.status]} rn-ic`;
        // One pop for a real change, none for the first draw.
        if (!first) {
          ic.classList.add("is-changed");
          ic.addEventListener("animationend", () => ic.classList.remove("is-changed"), { once: true });
        }
      }
    }
    const text = el.querySelector<HTMLElement>(".rn-t");
    if (text) setText(text, step.title);
    const pill = el.querySelector<HTMLElement>(".rn-pill");
    if (!pill) return;
    const parts = [STEP_LABEL[step.status]];
    if (step.sub && step.sub !== step.title) parts.unshift(step.sub);
    if (step.status === "blocked" && step.note) parts.push(step.note);
    const tip = `${step.title}\n${parts.join(" - ")}`;
    if (pill.title !== tip) pill.title = tip;
    const label = `${step.title}, ${STEP_LABEL[step.status].toLowerCase()}`;
    if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
