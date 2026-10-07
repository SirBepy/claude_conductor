// What the held modifiers should reveal. Ctrl alone shows the sidebar's chat
// numbers; Ctrl+Shift hides them and shows the favourite project slots at
// once. Kept free of DOM listeners so the rules are unit-testable;
// shortcuts.ts feeds it real key events.

export interface ModifierHint {
  numbers: boolean;
  favorites: boolean;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface ModifierHintTracker {
  keydown(e: KeyLike): void;
  keyup(e: KeyLike): void;
  reset(): void;
}

const isCtrlKey = (key: string) => key === "Control" || key === "Meta";
const isModifierKey = (key: string) => isCtrlKey(key) || key === "Shift" || key === "Alt";

export function createModifierHintTracker(onChange: (hint: ModifierHint) => void): ModifierHintTracker {
  let hint: ModifierHint = { numbers: false, favorites: false };
  // Set once any other key is pressed during a Ctrl+Shift hold: that hold is
  // a shortcut or a Ctrl+Shift+Arrow word selection, not a request to see the
  // favourites, so the strip goes away. Cleared only when the combo is released.
  let consumed = false;

  const emit = (next: ModifierHint) => {
    if (next.numbers === hint.numbers && next.favorites === hint.favorites) return;
    hint = next;
    onChange(hint);
  };

  const update = (ctrl: boolean, shift: boolean) => {
    const combo = ctrl && shift;
    if (!combo) consumed = false;
    emit({ numbers: ctrl && !shift, favorites: combo && !consumed });
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
