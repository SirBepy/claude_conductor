// Pointer half of the chat heads: drag a head to reorder the stack (a mouse drags at once;
// a finger long-presses first, then moves) and the phone's long-press hover card. The lifted
// head follows the pointer while its neighbours slide aside live into the slots it would
// leave; the drop settles into its slot with a transition, and a drop the backend refuses (a
// lost link, say) slides back. A drop stores Joe's order in settings.json through
// chat-heads-model's `reorderStored` (the phone through `set_chat_heads_order`, since it may
// not write settings); nothing else ever moves a head.

import { invoke } from "../../shared/ipc";
import { setSettings } from "../../shared/state";
import type { SettingsShape } from "../../shared/state";
import { isRemote } from "../../shared/transport";
import { updateSettings } from "../../shared/settings-update";
import { HEAD_ORDER_KEY, dropIndexFor, readHeadOrder, reorderStored } from "./chat-heads-model";
import { holdFlipOnce } from "./sidebar-anim";
import { hideHoverCard } from "./sidebar-hover-card";

/** A finger rests this long before the head lifts (and the hover card shows if it does not move). */
export const LONG_PRESS_MS = 450;
/** A mouse starts a drag after this many pixels; a finger that moves this far BEFORE the long-press is scrolling. */
const MOVE_PX = 6;
const FINGER_SLOP_PX = 10;
/** The drop's slide into its slot; matches `--head-lay` in chat-heads.css. */
export const SETTLE_MS = 320;
/** A save slower than this no longer holds the drop: the heads land and the stack renders
 *  again when the save arrives (a hung phone link must not freeze every head update). */
const SAVE_WAIT_MS = 1500;

export interface HeadDragDeps {
  /** Redraw the stack after a drop stored a new order. */
  render: () => void;
  /** The phone's long-press without a move: raise the hover card for this head. */
  onLongPress: (li: HTMLElement) => void;
}

const HEAD_SEL = "li.chat-head:not(.chat-head-control)[data-row-key]";

/** Heads in the stack. One leaving is pinned out of flow, so it is no part of a drag; one still
 *  entering sits in its slot (layout offsets ignore its animation) and only its pointer rect is off. */
function heads(listEl: HTMLElement): HTMLElement[] {
  return [...listEl.querySelectorAll<HTMLElement>(HEAD_SEL)].filter((el) => !el.classList.contains("row-exiting"));
}

/** Save the order that results from dropping `moved` at `toIndex` of the visible stack. */
export async function storeOrder(visible: string[], moved: string, toIndex: number): Promise<void> {
  if (isRemote()) {
    // The phone is refused `save_settings`; `set_chat_heads_order` is its one narrow write
    // of this key. Computed from freshly read settings, like the desktop path below.
    const fresh = await invoke<SettingsShape>("get_settings");
    const order = reorderStored(visible, moved, toIndex, readHeadOrder(fresh as Record<string, unknown>));
    await invoke("set_chat_heads_order", { order });
    setSettings({ ...fresh, [HEAD_ORDER_KEY]: order });
    return;
  }
  // Computed from the fresh settings inside the callback, so another window's drag of
  // off-screen ids (hidden chats) is not overwritten from a stale cache.
  return updateSettings((fresh) => ({
    ...fresh,
    [HEAD_ORDER_KEY]: reorderStored(visible, moved, toIndex, readHeadOrder(fresh as Record<string, unknown>)),
  })).then(() => undefined);
}

/** True from the first drag move until the drop has finished sliding into its slot. A
 *  re-render in between re-appends every head, which removes the dragged one from the DOM and
 *  drops its pointer capture (and would cut the slide short), so `renderSidebar` skips while
 *  this is set and the drop renders once. Read from the live gesture rather than kept as a
 *  flag, so a gesture that is replaced or dropped cannot leave it stuck on. A drag that gets
 *  no pointerup or pointercancel on the list still would. */
let dragInFlight: () => boolean = () => false;
export const headDragInFlight = (): boolean => dragInFlight();

interface Gesture {
  li: HTMLElement;
  key: string;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  lifted: boolean;
  dragging: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** The other heads' centres, for the drop index. */
  others: Array<{ id: string; cx: number; cy: number }>;
  visible: string[];
  /** Every head in stack order, the dragged one included, and where each one sits. */
  nodes: HTMLElement[];
  slots: Array<{ x: number; y: number }>;
  from: number;
  /** Index among the other heads the dragged head would land at. */
  target: number;
  /** The target the neighbours are currently shifted for. */
  shownFor: number;
}

/** A drop sliding into its slot, before the one render that adopts the new order. */
interface Settle {
  done: boolean;
  cur: Gesture;
  timer?: ReturnType<typeof setTimeout>;
  /** The new order is stored. */
  saved: boolean;
  /** The drop landed before the save did, so the save's arrival owes a render. */
  late: boolean;
}

/** Delegated, so it survives every reconcile. Returns a dispose function. */
export function attachHeadDrag(listEl: HTMLElement, deps: HeadDragDeps): () => void {
  let g: Gesture | null = null;
  let settle: Settle | null = null;
  const mine = (): boolean => !!g?.dragging || settle !== null;
  dragInFlight = mine;
  /** The click that ends a drag or a long-press must not open the chat. */
  let swallowClick = false;

  const measure = (cur: Gesture): void => {
    cur.nodes = heads(listEl);
    cur.visible = cur.nodes.map((el) => el.dataset.rowKey!);
    cur.from = cur.nodes.indexOf(cur.li);
    // Layout positions, not rects: a head's own step (`translate`) and any slide in flight
    // are not part of the slot it sits in.
    cur.slots = cur.nodes.map((el) => ({ x: el.offsetLeft, y: el.offsetTop }));
    cur.others = cur.nodes.filter((el) => el !== cur.li).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.rowKey!, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
  };

  /** Slides every head to the slot it takes when the dragged one lands at `index`. The dragged
   *  head itself follows the pointer until the drop, so it is only placed when `withDragged`. */
  const placeAt = (cur: Gesture, index: number, withDragged: boolean): void => {
    const order = cur.nodes.filter((n) => n !== cur.li);
    order.splice(index, 0, cur.li);
    order.forEach((n, slot) => {
      if (n === cur.li && !withDragged) return;
      const own = cur.slots[cur.nodes.indexOf(n)]!;
      const to = cur.slots[slot]!;
      const dx = to.x - own.x;
      const dy = to.y - own.y;
      n.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    });
    cur.shownFor = index;
  };

  /** Back to rest: no inline transform or transition, no drag classes. */
  const resetHeads = (cur: Gesture): void => {
    for (const n of cur.nodes) { n.style.transition = "none"; n.style.transform = ""; }
    cur.li.classList.remove("is-dragging", "is-settling");
    listEl.classList.remove("is-reordering");
    void listEl.offsetWidth;
    for (const n of cur.nodes) n.style.transition = "";
  };

  const finalize = (s: Settle, cur: Gesture): void => {
    if (s.done) return;
    s.done = true;
    if (!s.saved) s.late = true;
    clearTimeout(s.timer);
    if (settle === s) settle = null;
    resetHeads(cur);
    // Every head already sits in its slot, so the reorder this render makes must not slide them again.
    holdFlipOnce();
    deps.render();
  };

  /** The dragged head and its neighbours slide into the slots for `index`. `store` is the write
   *  of the new order: when it fails the heads slide back to where they were. */
  const startSettle = (cur: Gesture, index: number, store: Promise<void> | null): void => {
    const s: Settle = { done: false, cur, saved: store === null, late: false };
    settle = s;
    cur.li.classList.remove("is-dragging");
    cur.li.classList.add("is-settling");
    placeAt(cur, index, true);
    const slid = new Promise<void>((resolve) => { s.timer = setTimeout(resolve, SETTLE_MS); });
    const patience = new Promise<void>((resolve) => setTimeout(resolve, SAVE_WAIT_MS));
    void store?.then(() => {
      s.saved = true;
      if (s.late && !mine()) deps.render();
    }, () => { /* the rejection is handled below */ });
    void Promise.all([slid, store ? Promise.race([store, patience]) : null]).then(
      () => finalize(s, cur),
      (err) => {
        // The phone is not allowed to write settings, so a drop there is refused: slide back.
        console.error("[chat-heads] saving the order failed", err);
        if (s.done) return;
        placeAt(cur, cur.from, true);
        clearTimeout(s.timer);
        s.timer = setTimeout(() => finalize(s, cur), SETTLE_MS);
      },
    );
  };

  const startDrag = (): void => {
    if (!g) return;
    g.dragging = true;
    measure(g);
    g.shownFor = g.from;
    listEl.classList.add("is-reordering");
    g.li.classList.add("is-dragging");
    g.li.setPointerCapture?.(g.pointerId);
    hideHoverCard();
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const li = (e.target as HTMLElement).closest<HTMLElement>(HEAD_SEL);
    if (!li || !listEl.contains(li)) return;
    // A second pointer (another finger) while a drag runs must not replace its gesture. A
    // drag whose head left the DOM or lost its capture never gets its pointerup, so it is dead
    // and this press starts over instead of being locked out for good.
    if (g?.dragging) {
      const alive = g.li.isConnected && (!g.li.hasPointerCapture || g.li.hasPointerCapture(g.pointerId));
      if (alive) return;
      resetHeads(g);
      g = null;
      swallowClick = false;
      // Every render was skipped while it looked live, so catch the stack up.
      deps.render();
    }
    // A head still flying in or out is not a target.
    if (li.classList.contains("row-entering") || li.classList.contains("row-exiting")) return;
    if (g) {
      clearTimeout(g.timer);
      // The replaced finger's long-press must not leave the next tap's click swallowed.
      if (g.lifted) swallowClick = false;
    }
    // A new gesture while the last drop is still sliding lets that one land at once.
    if (settle) finalize(settle, settle.cur);
    const touch = e.pointerType === "touch" || e.pointerType === "pen";
    g = {
      li, key: li.dataset.rowKey!, pointerId: e.pointerId, touch,
      startX: e.clientX, startY: e.clientY, lifted: false, dragging: false,
      others: [], visible: [], nodes: [], slots: [], from: -1, target: -1, shownFor: -1,
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
    // The lift (scale and shadow) is CSS on .is-dragging; only the pointer's travel is set here.
    g.li.style.transform = `translate(${dx}px, ${dy}px)`;
    g.target = dropIndexFor(g.others, e.clientX, e.clientY);
    if (g.target !== g.shownFor) placeAt(g, g.target, false);
    e.preventDefault();
  };

  const end = (e: PointerEvent, cancelled: boolean): void => {
    if (!g || e.pointerId !== g.pointerId) return;
    const cur = g;
    g = null;
    clearTimeout(cur.timer);
    // The click that follows a drop or a long-press arrives at once; one that never comes
    // (released off the head) must not eat Joe's next real click.
    if (cur.dragging || cur.lifted) setTimeout(() => { swallowClick = false; }, 60);
    if (cur.dragging) {
      swallowClick = true;
      const moved = !cancelled && cur.target >= 0 && cur.target !== cur.from;
      startSettle(cur, moved ? cur.target : cur.from, moved ? storeOrder(cur.visible, cur.key, cur.target) : null);
    } else if (cur.lifted && !cancelled) {
      deps.onLongPress(cur.li);
    }
  };

  const onUp = (e: PointerEvent): void => end(e, false);
  const onCancel = (e: PointerEvent): void => end(e, true);
  // The heads slide under a resting pointer during a drag and each one that does would arm its
  // hover card; swallowed in the capture phase, before the card's own listener on this list.
  const onOver = (e: Event): void => { if (mine()) e.stopPropagation(); };
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
  listEl.addEventListener("mouseover", onOver, true);
  listEl.addEventListener("contextmenu", onContext, true);
  return () => {
    listEl.removeEventListener("pointerdown", onDown);
    listEl.removeEventListener("pointermove", onMove);
    listEl.removeEventListener("pointerup", onUp);
    listEl.removeEventListener("pointercancel", onCancel);
    listEl.removeEventListener("click", onClick, true);
    listEl.removeEventListener("mouseover", onOver, true);
    listEl.removeEventListener("contextmenu", onContext, true);
    if (g) clearTimeout(g.timer);
    if (settle) clearTimeout(settle.timer);
    if (dragInFlight === mine) dragInFlight = () => false;
  };
}
