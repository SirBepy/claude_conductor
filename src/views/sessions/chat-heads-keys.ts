// Keyboard half of the chat heads (docs/chat-heads-design.md): Ctrl+1..9 stays in
// shortcuts.ts; this owns the hold. Holding Ctrl alone for ~0.4s opens the stack and
// numbers the heads, and while Ctrl is held Up/Down walk a highlight through every head
// (looping). Releasing Ctrl opens the highlighted chat; Esc cancels. A Ctrl TAP (released
// before the hold, with no other key or click in between) toggles the stack open or closed.

import { stepHighlight } from "./chat-heads-model";

/** Long enough that a Ctrl+C or Ctrl+1 never flashes the numbers, short enough to feel held. */
export const HOLD_MS = 400;

export interface HeadKeyDeps {
  /** The stack's open flag and highlight, shared with the renderer. */
  ui: { open: boolean; numbers: boolean; highlight: number };
  /** How many heads the arrows can walk. */
  count: () => number;
  /** Redraw the stack and the number badges after `ui` changed. */
  render: () => void;
  /** Open the chat at this index of the stack. */
  openIndex: (index: number) => void;
}

export interface HeadKeys {
  /** Feed every modifier-hint change (`numbers` = Ctrl held alone). */
  hint(numbers: boolean): void;
  /** Feed every keydown while the view is mounted. Returns true when it consumed the key. */
  keydown(e: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey?: boolean; repeat?: boolean }): boolean;
  dispose(): void;
}

export function createHeadKeys(deps: HeadKeyDeps): HeadKeys {
  const { ui } = deps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  let cancelled = false;
  /** The numbers or a walk showed during this Ctrl press, so its release is a hold, not a tap. */
  let shown = false;
  /** A key or a click came between Ctrl down and up (Ctrl+C, Ctrl+click, Ctrl+Shift): not a tap. */
  let other = false;
  /** The last key down was Ctrl on its own. Releasing Shift while Ctrl stays down makes the modifier
   *  hint report "Ctrl alone" again with no Ctrl keydown behind it, which must not read as a tap. */
  let ctrlAlone = false;
  /** The stack was closed when Ctrl went down: the hold opened it, so the release closes it again. */
  let openedByHold = false;

  const show = (): void => {
    if (!ui.open) { ui.open = true; openedByHold = true; }
    ui.numbers = true;
    shown = true;
    deps.render();
  };

  const finish = (): void => {
    clearTimeout(timer);
    if (!shown && !other && !cancelled && ctrlAlone) {
      ui.open = !ui.open;
      deps.render();
      return;
    }
    const picked = !cancelled && ui.highlight >= 0 ? ui.highlight : -1;
    // openedByHold: Esc already cleared the numbers and highlight, but the stack the hold
    // opened is still drawn open, so closing it needs a render too.
    const wasShown = ui.numbers || ui.highlight >= 0 || openedByHold;
    ui.numbers = false;
    ui.highlight = -1;
    if (openedByHold) { ui.open = false; openedByHold = false; }
    if (wasShown) deps.render();
    if (picked >= 0) deps.openIndex(picked);
  };

  /** Alt-Tab or a click out of the window ends the hold without a Ctrl keyup the page can see.
   *  Capture phase: shortcuts.ts's own blur listener (registered earlier) resets the modifier
   *  hint, which calls `hint(false)`, so this must run before it to mark the hold cancelled. */
  const onBlur = (e: Event): void => {
    // blur does not bubble, but a capture listener on window also sees every element's blur
    // (the composer's, a row's): only the window's own blur ends the hold.
    if (held && e.target === e.currentTarget) cancelled = true;
  };
  /** Ctrl+click is a click, not a tap. Capture, so no handler's stopPropagation hides it. */
  const onPointer = (): void => { if (held) other = true; };
  if (typeof window !== "undefined") {
    window.addEventListener("blur", onBlur, true);
    window.addEventListener("pointerdown", onPointer, true);
  }

  return {
    hint(numbers) {
      if (numbers && !held) {
        held = true;
        cancelled = false;
        shown = false;
        other = false;
        timer = setTimeout(show, HOLD_MS);
      } else if (!numbers && held) {
        held = false;
        finish();
        cancelled = false;
        ctrlAlone = false;
      }
    },
    keydown(e) {
      const isCtrl = e.key === "Control" || e.key === "Meta";
      // Before the held check: the Ctrl keydown can reach here before or after the hint arms.
      if (!isCtrl) ctrlAlone = false;
      else if (!e.repeat && !e.shiftKey && !e.altKey) ctrlAlone = true;
      if (!held) return false;
      // Auto-repeat of Ctrl itself is not another key.
      if (!isCtrl) other = true;
      if (e.key === "Escape") {
        // Not consumed: Esc still closes whatever else listens for it.
        cancelled = true;
        ui.highlight = -1;
        clearTimeout(timer);
        if (ui.numbers) { ui.numbers = false; deps.render(); }
        return false;
      }
      // Shift (the favourites combo), Alt, or a Ctrl+digit shortcut that already opened its
      // own chat all end the hold without picking the highlighted head.
      if (e.shiftKey || e.altKey || /^[1-9]$/.test(e.key)) { cancelled = true; return false; }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
      const n = deps.count();
      if (n === 0) return false;
      clearTimeout(timer);
      cancelled = false;
      ui.highlight = stepHighlight(ui.highlight, e.key === "ArrowDown" ? 1 : -1, n);
      show();
      return true;
    },
    dispose() {
      clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("blur", onBlur, true);
        window.removeEventListener("pointerdown", onPointer, true);
      }
      if (openedByHold) { ui.open = false; openedByHold = false; }
      held = false;
      ui.numbers = false;
      ui.highlight = -1;
    },
  };
}
