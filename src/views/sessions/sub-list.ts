// The main chat's header count and the list it opens: every sub of the chat,
// running first, then finished, each with its status and progress. It is also the
// phone's replacement for the sidebar hover card, which a finger cannot open.
// The data is mainChatInfo (the sidebar row's source), so a dot here and a dot
// there can never disagree.

import "./sub-list.css";
import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { fetchSubCards } from "../../shared/chat/subchat-cards";
import { mainChatInfo, type SubStatus } from "./main-chat";
import { isMirrored } from "./sessions-helpers";
import { CLOSES_WHEN_SUBS_FINISH } from "./sidebar-row-visuals";
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

/** `canMove` is false for a chat mirrored in from a paired machine: turning a sub
 *  into a chat is its host's decision and the host refuses it from a peer, so the
 *  button is not offered. */
function rowHtml(sub: SubStatus, inst: Instance | undefined, canMove: boolean): string {
  const name = escapeHtml(sub.name);
  return `<div class="sub-row" role="button" tabindex="0" data-sub-id="${escapeHtml(sub.id)}" data-kind="${sub.kind}" title="Read ${name}">
    <span class="sub-dot">${escapeHtml(subInitials(sub.name))}${ringHtml(subRingSpec(sub, inst))}</span>
    <span class="sub-text"><span class="sub-name">${name}</span><span class="sub-meta"><span class="sub-status">${escapeHtml(sub.progress)}</span>${sub.tier ? `<span class="sub-tier">${escapeHtml(sub.tier)}</span>` : ""}</span></span>
    ${sub.kind === "queued" || !canMove ? "" : `<button type="button" class="sub-move" data-move title="Move to sidebar" aria-label="Move ${name} to the sidebar"><i class="ph ph-arrow-square-out"></i></button>`}
  </div>`;
}

/** Finished subs, the one that finished last first. `finishedAt` holds the time of each
 *  sub's latest finish card (the log outlives a restart); a sub without one falls back
 *  to the instance's last busy/idle flip, and one with neither keeps the order it came
 *  in, newest started last, so it sorts after the ones that are dated. */
export function newestFinishedFirst(
  rows: readonly SubStatus[],
  byId: ReadonlyMap<string, Instance>,
  finishedAt: ReadonlyMap<string, number> = new Map(),
): SubStatus[] {
  const at = (s: SubStatus): number => {
    const card = finishedAt.get(s.id);
    if (card !== undefined) return card;
    const flip = Date.parse(byId.get(s.id)?.progress?.state_since ?? "");
    return Number.isNaN(flip) ? 0 : flip;
  };
  return rows
    .map((row, i) => ({ row, i, t: at(row) }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((e) => e.row);
}

/** The popover body. Asking subs sit with the running ones: they are not done. */
export function subListHtml(
  subs: readonly SubStatus[],
  sessions: readonly Instance[],
  finishedAt: ReadonlyMap<string, number> = new Map(),
  closesWhenSubsFinish = false,
  canMove = true,
): string {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const running = subs.filter((s) => s.kind !== "finished");
  const finished = newestFinishedFirst(subs.filter((s) => s.kind === "finished"), byId, finishedAt);
  const section = (label: string, rows: readonly SubStatus[]): string =>
    rows.length ? `<h5 class="sub-list-head">${label}</h5>${rows.map((s) => rowHtml(s, byId.get(s.id), canMove)).join("")}` : "";
  const note = closesWhenSubsFinish ? `<p class="sub-list-note">${escapeHtml(CLOSES_WHEN_SUBS_FINISH)}</p>` : "";
  return note + section("Running", running) + section("Finished", finished);
}

/** The count icon in a main chat's header and the list behind it. Owns its button:
 *  it exists only while the chat has a sub, so a chat that never used the mode
 *  shows nothing. */
export class SubListButton {
  private btn: HTMLButtonElement | null = null;
  private readonly shell = new PopoverShell();
  /** When each sub last finished, from the main chat's card log (see `newestFinishedFirst`). */
  private finishedAt: ReadonlyMap<string, number> = new Map();

  constructor(
    private readonly slot: HTMLElement,
    private readonly mainId: string,
    private readonly handlers: SubListHandlers,
    private readonly getSessions: () => readonly Instance[],
  ) {}

  /** Whether this button counts `mainId`'s subs. One module-level button follows the
   *  chat on screen, so a caller holding a button built for an earlier chat must not
   *  feed it the current chat's update. */
  belongsTo(mainId: string): boolean {
    return this.mainId === mainId;
  }

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
    const waiting = info.closesWhenSubsFinish;
    this.btn.innerHTML = `<i class="ph ph-tree-structure"></i>${n}${waiting ? '<i class="ph ph-hourglass-medium sub-close-wait"></i>' : ""}`;
    this.btn.title = `${n} subchat${n === 1 ? "" : "s"}${waiting ? `. ${CLOSES_WHEN_SUBS_FINISH}` : ""}`;
    this.btn.setAttribute("aria-label", this.btn.title);
    this.btn.classList.toggle("on", this.shell.isOpen);
    if (this.shell.isOpen) this.openList(info.subs, sessions, waiting);
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
    void this.openFromState();
  }

  /** The popover reads the latest list on each open, not the one `update` saw, and
   *  the finish times first, so Finished is in order from the first paint. */
  private async openFromState(): Promise<void> {
    const cards = await fetchSubCards(this.mainId);
    const times = new Map<string, number>();
    for (const c of cards) if (c.kind === "finish" && c.sub_id) times.set(c.sub_id, Math.max(times.get(c.sub_id) ?? 0, c.ts));
    this.finishedAt = times;
    // Closed again while the cards were coming: nothing to open.
    if (!this.btn?.classList.contains("on")) return;
    const sessions = this.getSessions();
    const main = sessions.find((s) => s.session_id === this.mainId);
    if (!main) return;
    const info = mainChatInfo(main, sessions);
    this.openList(info.subs, sessions, info.closesWhenSubsFinish);
  }

  private openList(subs: readonly SubStatus[], sessions: readonly Instance[], waiting = false): void {
    if (!this.btn) return;
    const main = sessions.find((s) => s.session_id === this.mainId);
    this.shell.open(this.btn, subListHtml(subs, sessions, this.finishedAt, waiting, !isMirrored(main)), {
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
