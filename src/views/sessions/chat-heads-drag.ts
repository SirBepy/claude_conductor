// Pointer half of the chat heads: drag a head to reorder the stack (a mouse drags at once;
// a finger long-presses first, then moves) and the phone's long-press hover card. A drop
// stores Joe's order in settings.json through chat-heads-model's `reorderStored`; nothing
// else ever moves a head.

import { updateSettings } from "../../shared/settings-update";
import { HEAD_ORDER_KEY, dropIndexFor, readHeadOrder, reorderStored } from "./chat-heads-model";

/** A finger rests this long before the head lifts (and the hover card shows if it does not move). */
export const LONG_PRESS_MS = 450;
/** A mouse starts a drag after this many pixels; a finger that moves this far BEFORE the long-press is scrolling. */
const MOVE_PX = 6;
const FINGER_SLOP_PX = 10;

export interface HeadDragDeps {
  /** Redraw the stack after a drop stored a new order. */
  render: () => void;
  /** The phone's long-press without a move: raise the hover card for this head. */
  onLongPress: (li: HTMLElement) => void;
}

const HEAD_SEL = "li.chat-head:not(.chat-head-control)[data-row-key]";

function heads(listEl: HTMLElement): HTMLElement[] {
  return [...listEl.querySelectorAll<HTMLElement>(HEAD_SEL)];
}

/** Save the order that results from dropping `moved` at `toIndex` of the visible stack. */
export function storeOrder(visible: string[], moved: string, toIndex: number): Promise<void> {
  // Computed from the fresh settings inside the callback, so another window's drag of
  // off-screen ids (hidden chats) is not overwritten from a stale cache.
  return updateSettings((fresh) => ({
    ...fresh,
    [HEAD_ORDER_KEY]: reorderStored(visible, moved, toIndex, readHeadOrder(fresh as Record<string, unknown>)),
  })).then(() => undefined);
}

/** True from the first drag move to the drop. A re-render in between re-appends every head,
 *  which removes the dragged one from the DOM and drops its pointer capture, so
 *  `renderSidebar` skips while this is set and the drop renders once. Read from the live
 *  gesture rather than kept as a flag, so a gesture that is replaced or dropped cannot leave
 *  it stuck on. A drag that gets no pointerup or pointercancel on the list still would. */
let dragInFlight: () => boolean = () => false;
export const headDragInFlight = (): boolean => dragInFlight();

/** Delegated, so it survives every reconcile. Returns a dispose function. */
export function attachHeadDrag(listEl: HTMLElement, deps: HeadDragDeps): () => void {
  let g: {
    li: HTMLElement;
    key: string;
    pointerId: number;
    touch: boolean;
    startX: number;
    startY: number;
    lifted: boolean;
    dragging: boolean;
    timer?: ReturnType<typeof setTimeout>;
    others: Array<{ id: string; cx: number; cy: number }>;
    visible: string[];
    target: number;
  } | null = null;
  const mine = (): boolean => !!g?.dragging;
  dragInFlight = mine;
  /** The click that ends a drag or a long-press must not open the chat. */
  let swallowClick = false;

  const clearMarks = (): void => {
    for (const el of listEl.querySelectorAll(".is-drop-before")) el.classList.remove("is-drop-before");
  };

  const measure = (): void => {
    if (!g) return;
    const all = heads(listEl);
    g.visible = all.map((el) => el.dataset.rowKey!);
    g.others = all.filter((el) => el !== g!.li).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.rowKey!, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
  };

  const startDrag = (): void => {
    if (!g) return;
    g.dragging = true;
    measure();
    g.li.classList.add("is-dragging");
    g.li.setPointerCapture?.(g.pointerId);
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const li = (e.target as HTMLElement).closest<HTMLElement>(HEAD_SEL);
    if (!li || !listEl.contains(li)) return;
    const touch = e.pointerType === "touch" || e.pointerType === "pen";
    g = {
      li, key: li.dataset.rowKey!, pointerId: e.pointerId, touch,
      startX: e.clientX, startY: e.clientY, lifted: false, dragging: false,
      others: [], visible: [], target: -1,
    };
    if (touch) {
      g.timer = setTimeout(() => { if (g) { g.lifted = true; swallowClick = true; } }, LONG_PRESS_MS);
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dist = Math.hypot(dx, dy);
    if (!g.dragging) {
      if (g.touch) {
        // Moved before the long-press fired: the finger is scrolling or just wobbling, not dragging.
        if (!g.lifted) { if (dist > FINGER_SLOP_PX) { clearTimeout(g.timer); g = null; } return; }
        if (dist < MOVE_PX) return;
      } else if (dist < MOVE_PX) return;
      startDrag();
    }
    g.li.style.transform = `translate(${dx}px, ${dy}px) scale(1.12)`;
    g.target = dropIndexFor(g.others, e.clientX, e.clientY);
    clearMarks();
    // The marker sits on the head that would follow the dropped one.
    const next = g.others[g.target];
    if (next) listEl.querySelector<HTMLElement>(`li[data-row-key="${CSS.escape(next.id)}"]`)?.classList.add("is-drop-before");
    e.preventDefault();
  };

  const end = (e: PointerEvent, cancelled: boolean): void => {
    if (!g || e.pointerId !== g.pointerId) return;
    const cur = g;
    g = null;
    clearTimeout(cur.timer);
    cur.li.style.transform = "";
    cur.li.classList.remove("is-dragging");
    clearMarks();
    // The click that follows a drop or a long-press arrives at once; one that never comes
    // (released off the head) must not eat Joe's next real click.
    if (cur.dragging || cur.lifted) setTimeout(() => { swallowClick = false; }, 60);
    if (cur.dragging) {
      swallowClick = true;
      if (!cancelled && cur.target >= 0) {
        void storeOrder(cur.visible, cur.key, cur.target)
          .then(deps.render)
          .catch((err) => {
            // The phone is not allowed to write settings, so a drop there is refused: snap back.
            console.error("[chat-heads] saving the order failed", err);
            deps.render();
          });
      } else deps.render();
    } else if (cur.lifted && !cancelled) {
      deps.onLongPress(cur.li);
    }
  };

  const onUp = (e: PointerEvent): void => end(e, false);
  const onCancel = (e: PointerEvent): void => end(e, true);
  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  // A long-press on the phone would otherwise raise the system context menu over the card.
  const onContext = (e: Event): void => { if (g?.lifted) e.preventDefault(); };

  listEl.addEventListener("pointerdown", onDown);
  listEl.addEventListener("pointermove", onMove);
  listEl.addEventListener("pointerup", onUp);
  listEl.addEventListener("pointercancel", onCancel);
  // Capture, so the swallow runs before the list's own click handler opens the chat.
  listEl.addEventListener("click", onClick, true);
  listEl.addEventListener("contextmenu", onContext, true);
  return () => {
    listEl.removeEventListener("pointerdown", onDown);
    listEl.removeEventListener("pointermove", onMove);
    listEl.removeEventListener("pointerup", onUp);
    listEl.removeEventListener("pointercancel", onCancel);
    listEl.removeEventListener("click", onClick, true);
    listEl.removeEventListener("contextmenu", onContext, true);
    if (g) clearTimeout(g.timer);
    if (dragInFlight === mine) dragInFlight = () => false;
  };
}
