// Pointer-driven reordering for the Backlog list: a row moves within or between
// groups (dropping on the unplanned group unplans it), a plan heading moves its
// whole group. Pointer events rather than HTML5 drag and drop: the webview's
// native DnD shows a ghost we cannot style and swallows the move events the
// drop line needs.

import type { DropSpot } from "./backlog-model";

export interface DragHost {
  /** The scroller holding the `.bl-group` sections. */
  list: HTMLElement;
  /** False on the phone, for a peer's chat, or while a write is in flight. */
  enabled(): boolean;
  onRowDrop(id: string, spot: DropSpot): void;
  onGroupDrop(name: string, before: string | null): void;
}

/** Movement under this is a click, so a tap on a row still selects it. */
const THRESHOLD = 5;
/** Distance from the list's top or bottom edge where a drag starts scrolling. */
const EDGE = 28;

type Grab =
  | { kind: "row"; el: HTMLElement; id: string }
  | { kind: "group"; el: HTMLElement; name: string };

export function attachBacklogDrag(host: DragHost): () => void {
  const { list } = host;
  let grab: Grab | null = null;
  let started = false;
  let x0 = 0;
  let y0 = 0;
  let ghost: HTMLElement | null = null;
  let spot: DropSpot | { before: string | null } | null = null;
  let swallowClick = false;

  const clearMarks = (): void => {
    list.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop").forEach((el) => {
      el.classList.remove("is-drop-before", "is-drop-after", "is-drop");
    });
  };

  const sections = (planned: boolean | null): HTMLElement[] =>
    [...list.querySelectorAll<HTMLElement>(".bl-group")].filter((s) => planned === null || (s.dataset.planned === "true") === planned);

  const rowSpot = (y: number, dragId: string): DropSpot => {
    const all = sections(null);
    if (all.length === 0) return { group: null, beforeId: null };
    // Above the first or below the last section snaps to it; between sections
    // (the gap is padding) the nearer one wins by the midpoint test.
    const hit = all.find((s) => y < s.getBoundingClientRect().bottom) ?? all[all.length - 1]!;
    const group = hit.dataset.planned === "true" ? hit.dataset.group ?? "" : null;
    const rows = [...hit.querySelectorAll<HTMLElement>(".bl-row")].filter((r) => r.dataset.blId !== dragId);
    const before = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    clearMarks();
    if (before) before.classList.add("is-drop-before");
    else hit.querySelector(".bl-group-end")?.classList.add("is-drop");
    return { group, beforeId: before?.dataset.blId ?? null };
  };

  const groupSpot = (y: number, dragName: string): { before: string | null } => {
    const planned = sections(true).filter((s) => s.dataset.group !== dragName);
    const before = planned.find((s) => {
      const b = s.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    clearMarks();
    if (before) before.classList.add("is-drop-before");
    else planned[planned.length - 1]?.classList.add("is-drop-after");
    return { before: before?.dataset.group ?? null };
  };

  const autoscroll = (y: number): void => {
    const b = list.getBoundingClientRect();
    if (y < b.top + EDGE) list.scrollTop -= 10;
    else if (y > b.bottom - EDGE) list.scrollTop += 10;
  };

  const begin = (): void => {
    if (!grab) return;
    started = true;
    // A heading drags as its heading alone: the whole group would cover the list.
    const src = grab.kind === "group" ? grab.el.querySelector<HTMLElement>(".bl-group-h")! : grab.el;
    ghost = src.cloneNode(true) as HTMLElement;
    const r = src.getBoundingClientRect();
    ghost.classList.add("bl-ghost");
    ghost.removeAttribute("data-bl-id");
    ghost.style.width = `${r.width}px`;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.appendChild(ghost);
    grab.el.classList.add("is-dragging");
    list.classList.add("is-reordering");
  };

  const move = (ev: PointerEvent): void => {
    if (!grab) return;
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
      begin();
    }
    if (ghost) ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
    autoscroll(ev.clientY);
    spot = grab.kind === "row" ? rowSpot(ev.clientY, grab.id) : groupSpot(ev.clientY, grab.name);
  };

  const finish = (drop: boolean): void => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", onKey, true);
    const g = grab;
    const s = spot;
    ghost?.remove();
    ghost = null;
    g?.el.classList.remove("is-dragging");
    list.classList.remove("is-reordering");
    clearMarks();
    const wasDrag = started;
    grab = null;
    started = false;
    spot = null;
    if (wasDrag) {
      // The click that follows a drag's pointerup would select the row it ended on.
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    }
    if (!drop || !wasDrag || !g || !s) return;
    if (g.kind === "row") host.onRowDrop(g.id, s as DropSpot);
    else host.onGroupDrop(g.name, (s as { before: string | null }).before);
  };

  const up = (): void => finish(true);
  const cancel = (): void => finish(false);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  const down = (ev: PointerEvent): void => {
    if (ev.button !== 0 || grab || !host.enabled()) return;
    const t = ev.target as HTMLElement;
    const headEl = t.closest<HTMLElement>("[data-bl-group-grab]");
    const rowEl = t.closest<HTMLElement>(".bl-row");
    if (headEl) {
      const name = headEl.closest<HTMLElement>(".bl-group")?.dataset.group;
      if (name == null) return;
      grab = { kind: "group", el: headEl.closest<HTMLElement>(".bl-group")!, name };
    } else if (rowEl?.dataset.blId) {
      grab = { kind: "row", el: rowEl, id: rowEl.dataset.blId };
    } else {
      return;
    }
    x0 = ev.clientX;
    y0 = ev.clientY;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", onKey, true);
  };

  const onClickCapture = (ev: MouseEvent): void => {
    if (!swallowClick) return;
    ev.stopPropagation();
    ev.preventDefault();
    swallowClick = false;
  };

  list.addEventListener("pointerdown", down);
  list.addEventListener("click", onClickCapture, true);
  return () => {
    list.removeEventListener("pointerdown", down);
    list.removeEventListener("click", onClickCapture, true);
    if (grab) finish(false);
  };
}
