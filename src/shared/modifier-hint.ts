// What the held modifiers should reveal. Ctrl alone shows the sidebar's chat
// numbers; Ctrl+Shift hides them and, after a short hold, shows the favourite
// project slots. Kept free of DOM listeners so the timing rules are
// unit-testable; shortcuts.ts feeds it real key events.

export interface ModifierHint {
  numbers: boolean;
  favorites: boolean;
}

/** Ctrl+Shift+Arrow is also word selection in the composer. Showing the
 *  favourites only after a still hold keeps that from flashing the strip. */
export const FAVORITES_HINT_DELAY_MS = 300;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface ModifierHintTracker {
  keydown(e: KeyLike): void;
  keyup(e: KeyLike): void;
  reset(): void;
}

const isCtrlKey = (key: string) => key === "Control" || key === "Meta";
const isModifierKey = (key: string) => isCtrlKey(key) || key === "Shift" || key === "Alt";

export function createModifierHintTracker(
  onChange: (hint: ModifierHint) => void,
  delayMs = FAVORITES_HINT_DELAY_MS,
  timers: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): ModifierHintTracker {
  let hint: ModifierHint = { numbers: false, favorites: false };
  let timer: unknown = null;
  // Set once any other key is pressed during a Ctrl+Shift hold: that hold is
  // a shortcut or a text selection, not a request to see the favourites.
  // Cleared only when the combo is released.
  let consumed = false;

  const emit = (next: ModifierHint) => {
    if (next.numbers === hint.numbers && next.favorites === hint.favorites) return;
    hint = next;
    onChange(hint);
  };

  const stopTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  const update = (ctrl: boolean, shift: boolean) => {
    const combo = ctrl && shift;
    if (!combo) consumed = false;
    if (!combo || consumed) {
      stopTimer();
      emit({ numbers: ctrl && !shift, favorites: false });
      return;
    }
    emit({ numbers: false, favorites: hint.favorites });
    if (!hint.favorites && timer === null) {
      timer = timers.set(() => {
        timer = null;
        emit({ numbers: false, favorites: true });
      }, delayMs);
    }
  };

  return {
    keydown(e) {
      const ctrl = e.ctrlKey || e.metaKey || isCtrlKey(e.key);
      const shift = e.shiftKey || e.key === "Shift";
      if (!isModifierKey(e.key) && ctrl && shift) consumed = true;
      update(ctrl, shift);
    },
    keyup(e) {
      // The released key's own flag can still read true on some platforms.
      const ctrl = (e.ctrlKey || e.metaKey) && !isCtrlKey(e.key);
      const shift = e.shiftKey && e.key !== "Shift";
      update(ctrl, shift);
    },
    reset() {
      consumed = false;
      update(false, false);
    },
  };
}
