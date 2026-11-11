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
import { isRemote } from "../../shared/transport";
import { CLOSES_WHEN_SUBS_FINISH } from "./sidebar-row-visuals";
import { planProgress, ringHtml, type RingSpec } from "./sidebar-ring";
import { PopoverShell } from "./statusbar-popover-shell";
import { isFolded } from "../../shared/chat/dashboard/subs-model";

export interface SubListHandlers {
  /** Read this sub in place. */
  open(subId: string): void;
  /** Open this sub in a new window. */
  popOut(subId: string): void;
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

/** `canPopOut` is false where a window cannot be opened: the phone, which has no
 *  second window. The button never moves the sub; "Pin to sidemenu" is in the chat menu. */
function rowHtml(sub: SubStatus, inst: Instance | undefined, canPopOut: boolean): string {
  const name = escapeHtml(sub.name);
  return `<div class="sub-row" role="button" tabindex="0" data-sub-id="${escapeHtml(sub.id)}" data-kind="${sub.kind}" title="Read ${name}">
    <span class="sub-dot">${escapeHtml(subInitials(sub.name))}${ringHtml(subRingSpec(sub, inst))}</span>
    <span class="sub-text"><span class="sub-name">${name}</span><span class="sub-meta"><span class="sub-status">${escapeHtml(sub.progress)}</span>${sub.tier ? `<span class="sub-tier">${escapeHtml(sub.tier)}</span>` : ""}</span></span>
    ${sub.kind === "queued" || !canPopOut ? "" : `<button type="button" class="sub-move" data-popout title="Open in new window" aria-label="Open ${name} in a new window"><i class="ph ph-arrow-square-out"></i></button>`}
  </div>`;
}

/** When a sub finished, or null when nothing dates it: the finish card, else the instance's last busy/idle flip. */
function finishTime(s: SubStatus, byId: ReadonlyMap<string, Instance>, finishedAt: ReadonlyMap<string, number>): number | null {
  const card = finishedAt.get(s.id);
  if (card !== undefined) return card;
  const flip = Date.parse(byId.get(s.id)?.progress?.state_since ?? "");
  return Number.isNaN(flip) ? null : flip;
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
  return rows
    .map((row, i) => ({ row, i, t: finishTime(row, byId, finishedAt) ?? 0 }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((e) => e.row);
}

/** The popover body. Asking subs sit with the running ones: they are not done. A
 *  queued sub has no claude process yet, so it gets its own group: filing it under
 *  Running said "working" about a sub that is only waiting for a slot or another sub.
 *  A finished sub older than the dashboard card's hour folds under "+N earlier" (a
 *  display rule: the sub stays resumable). `now` is what the hour is measured against;
 *  `showEarlier` lists the folded ones under the "+N earlier" row. */
export function subListHtml(
  subs: readonly SubStatus[],
  sessions: readonly Instance[],
  canPopOut = true,
  finishedAt: ReadonlyMap<string, number> = new Map(),
  closesWhenSubsFinish = false,
  now = Date.now(),
  showEarlier = false,
): string {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const running = subs.filter((s) => s.kind !== "finished" && s.kind !== "queued");
  const queued = subs.filter((s) => s.kind === "queued");
  const finished = newestFinishedFirst(subs.filter((s) => s.kind === "finished"), byId, finishedAt);
  const folded = (s: SubStatus): boolean => isFolded({ kind: s.kind, closing: s.closing, finishedAt: finishTime(s, byId, finishedAt) }, now);
  const recent = finished.filter((s) => !folded(s));
  const earlier = finished.filter(folded);
  const rows = (list: readonly SubStatus[]): string => list.map((s) => rowHtml(s, byId.get(s.id), canPopOut)).join("");
  const section = (label: string, list: readonly SubStatus[], tail = ""): string =>
    list.length || tail ? `<h5 class="sub-list-head">${label}</h5>${rows(list)}${tail}` : "";
  const earlierRow = earlier.length
    ? `<button type="button" class="sub-earlier" data-earlier aria-expanded="${showEarlier}">${showEarlier ? "Hide earlier" : `+${earlier.length} earlier`}</button>${showEarlier ? rows(earlier) : ""}`
    : "";
  const note = closesWhenSubsFinish ? `<p class="sub-list-note">${escapeHtml(CLOSES_WHEN_SUBS_FINISH)}</p>` : "";
  return note + section("Running", running) + section("Queued", queued) + section("Finished", recent, earlierRow);
}

/** The count icon in a main chat's header and the list behind it. Owns its button:
 *  it exists only while the chat has a sub, so a chat that never used the mode
 *  shows nothing. */
export class SubListButton {
  private btn: HTMLButtonElement | null = null;
  private readonly shell = new PopoverShell();
  /** When each sub last finished, from the main chat's card log (see `newestFinishedFirst`). */
  private finishedAt: ReadonlyMap<string, number> = new Map();
  /** Whether "+N earlier" is expanded. Per open: a closed list starts folded again. */
  private earlierOpen = false;

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
    this.shell.open(this.btn, subListHtml(subs, sessions, !isRemote(), this.finishedAt, waiting, Date.now(), this.earlierOpen), {
      className: "sub-list-popover",
      onClose: () => { this.earlierOpen = false; this.btn?.classList.remove("on"); },
      wire: (el) => {
        el.querySelector<HTMLElement>("[data-earlier]")?.addEventListener("click", () => {
          this.earlierOpen = !this.earlierOpen;
          this.openList(subs, sessions, waiting);
        });
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
          row.querySelector<HTMLElement>("[data-popout]")?.addEventListener("click", (e) => {
            e.stopPropagation();
            this.shell.close();
            this.handlers.popOut(id);
          });
        });
      },
    });
  }
}
