// The main chat's header count and the list it opens: every sub of the chat,
// running first, then finished, each with its status and progress. It is also the
// phone's replacement for the sidebar hover card, which a finger cannot open.
// The data is mainChatInfo (the sidebar row's source), so a dot here and a dot
// there can never disagree.

import "./sub-list.css";
import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { mainChatInfo, type SubStatus } from "./main-chat";
import { planProgress, ringHtml, type RingSpec } from "./sidebar-ring";
import { PopoverShell } from "./statusbar-popover-shell";

export interface SubListHandlers {
  /** Read this sub in place. */
  open(subId: string): void;
  /** Turn this sub into an ordinary chat. */
  move(subId: string): void;
}

/** Up to two letters standing in for an avatar: a sub has no character, and the
 *  ring around the circle already carries the state. */
export function subInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/** Red asks for Joe, a plan draws its arc, a plan-less worker breathes, a finished
 *  sub is a solid green ring: the sidebar ring's own vocabulary. */
export function subRingSpec(sub: SubStatus, inst: Instance | undefined): RingSpec {
  if (sub.kind === "asking") return { kind: "solid", tone: "question", pulse: true };
  if (sub.kind === "finished") return { kind: "solid", tone: inst?.closing ? "closing" : "done" };
  // Queued is yellow like working, but it has not started: no glow, no arc.
  if (sub.kind === "queued") return { kind: "solid", tone: "working" };
  const plan = planProgress(inst?.progress?.plan);
  return plan ? { kind: "plan", done: plan.done, total: plan.total } : { kind: "solid", tone: "working", glow: true };
}

function rowHtml(sub: SubStatus, inst: Instance | undefined): string {
  const name = escapeHtml(sub.name);
  return `<div class="sub-row" role="button" tabindex="0" data-sub-id="${escapeHtml(sub.id)}" data-kind="${sub.kind}" title="Read ${name}">
    <span class="sub-dot">${escapeHtml(subInitials(sub.name))}${ringHtml(subRingSpec(sub, inst))}</span>
    <span class="sub-text"><span class="sub-name">${name}</span><span class="sub-status">${escapeHtml(sub.progress)}</span></span>
    ${sub.kind === "queued" ? "" : `<button type="button" class="sub-move" data-move title="Move to sidebar" aria-label="Move ${name} to the sidebar"><i class="ph ph-arrow-square-out"></i></button>`}
  </div>`;
}

/** The popover body. Asking subs sit with the running ones: they are not done. */
export function subListHtml(subs: readonly SubStatus[], sessions: readonly Instance[]): string {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const running = subs.filter((s) => s.kind !== "finished");
  const finished = subs.filter((s) => s.kind === "finished");
  const section = (label: string, rows: readonly SubStatus[]): string =>
    rows.length ? `<h5 class="sub-list-head">${label}</h5>${rows.map((s) => rowHtml(s, byId.get(s.id))).join("")}` : "";
  return section("Running", running) + section("Finished", finished);
}

/** The count icon in a main chat's header and the list behind it. Owns its button:
 *  it exists only while the chat has a sub, so a chat that never used the mode
 *  shows nothing. */
export class SubListButton {
  private btn: HTMLButtonElement | null = null;
  private readonly shell = new PopoverShell();

  constructor(
    private readonly slot: HTMLElement,
    private readonly mainId: string,
    private readonly handlers: SubListHandlers,
    private readonly getSessions: () => readonly Instance[],
  ) {}

  /** Re-reads the subs from `sessions`: adds, updates or drops the button, and
   *  repaints the list in place when it is open. */
  update(sessions: readonly Instance[]): void {
    const main = sessions.find((s) => s.session_id === this.mainId);
    const info = main ? mainChatInfo(main, sessions) : null;
    if (!info || info.subs.length === 0) {
      this.btn?.remove();
      this.btn = null;
      this.shell.close();
      return;
    }
    if (!this.btn) this.btn = this.createButton();
    const n = info.subs.length;
    this.btn.innerHTML = `<i class="ph ph-tree-structure"></i>${n}`;
    this.btn.title = `${n} subchat${n === 1 ? "" : "s"}`;
    this.btn.setAttribute("aria-label", this.btn.title);
    this.btn.classList.toggle("on", this.shell.isOpen);
    if (this.shell.isOpen) this.openList(info.subs, sessions);
  }

  destroy(): void {
    this.shell.close();
    this.btn?.remove();
    this.btn = null;
  }

  private createButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-count-btn";
    btn.addEventListener("click", () => this.toggle());
    // Before any other trail child: on the phone the live ⋮ is appended after it.
    this.slot.prepend(btn);
    return btn;
  }

  private toggle(): void {
    if (this.shell.isOpen) {
      this.shell.close();
      this.btn?.classList.remove("on");
      return;
    }
    this.btn?.classList.add("on");
    this.openFromState();
  }

  /** The popover reads the latest list on each open, not the one `update` saw. */
  private openFromState(): void {
    const sessions = this.getSessions();
    const main = sessions.find((s) => s.session_id === this.mainId);
    if (!main) return;
    this.openList(mainChatInfo(main, sessions).subs, sessions);
  }

  private openList(subs: readonly SubStatus[], sessions: readonly Instance[]): void {
    if (!this.btn) return;
    this.shell.open(this.btn, subListHtml(subs, sessions), {
      className: "sub-list-popover",
      onClose: () => this.btn?.classList.remove("on"),
      wire: (el) => {
        el.querySelectorAll<HTMLElement>(".sub-row").forEach((row) => {
          const id = row.dataset.subId!;
          const activate = (): void => {
            this.shell.close();
            this.handlers.open(id);
          };
          row.addEventListener("click", activate);
          row.addEventListener("keydown", (e) => {
            if (e.target === row && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              activate();
            }
          });
          row.querySelector<HTMLElement>("[data-move]")?.addEventListener("click", (e) => {
            e.stopPropagation();
            this.shell.close();
            this.handlers.move(id);
          });
        });
      },
    });
  }
}
