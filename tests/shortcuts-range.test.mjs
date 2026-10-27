// Numbered shortcut families (Open chat 1-9, New chat: favorite 1-9) edit as
// one row: rebind writes modifiers+N to all nine slots.
import { describe, it, expect, beforeEach } from "vitest";
import {
  getBinding,
  getRangeModifiers,
  hasOverride,
  rangeHasOverride,
  rangeIds,
  resetBinding,
  resetRange,
  resolveCombo,
  findConflict,
  setBinding,
  setRangeFromCombo,
} from "../src/shared/shortcuts.ts";

const OPEN = "open-chat-";
const FAV = "new-chat-favorite-";

beforeEach(() => {
  resetRange(OPEN);
  resetRange(FAV);
  setBinding("new-chat", "ctrl+n");
});

describe("range rebind", () => {
  it("writes the captured modifiers plus each digit to all 9 slots", () => {
    expect(setRangeFromCombo(OPEN, "shift+alt+x")).toEqual({ ok: true });
    rangeIds(OPEN).forEach((id, i) => expect(getBinding(id)).toBe(`shift+alt+${i + 1}`));
    expect(getRangeModifiers(OPEN)).toBe("shift+alt");
    expect(rangeHasOverride(OPEN)).toBe(true);
  });

  it("ignores the captured key, keeping several modifiers in order", () => {
    setRangeFromCombo(FAV, "ctrl+alt+q");
    expect(getBinding(`${FAV}9`)).toBe("ctrl+alt+9");
  });

  it("is blocked, with nothing written, when any slot collides outside the range", () => {
    // ctrl+shift+1..9 are the favorite slots' defaults; Open chat may not take them.
    const res = setRangeFromCombo(OPEN, "ctrl+shift+x");
    expect(res.ok).toBe(false);
    expect(res.conflict.id.startsWith(FAV)).toBe(true);
    expect(rangeHasOverride(OPEN)).toBe(false);
  });

  it("blocks a collision on a single slot, even when the other eight are free", () => {
    setBinding("new-chat", "shift+alt+5");
    const res = setRangeFromCombo(OPEN, "shift+alt+x");
    expect(res.ok).toBe(false);
    expect(res.conflict.id).toBe("new-chat");
    expect(getBinding("open-chat-1")).toBe("ctrl+1");
  });

  it("refuses a combo with no modifier", () => {
    expect(setRangeFromCombo(OPEN, "x")).toEqual({ ok: false, conflict: null });
    expect(rangeHasOverride(OPEN)).toBe(false);
  });

  it("does not conflict with its own current slots", () => {
    expect(setRangeFromCombo(OPEN, "ctrl+x")).toEqual({ ok: true });
  });

  it("reads slot 1's modifiers when legacy per-slot overrides disagree, and overwrites all", () => {
    setBinding("open-chat-3", "shift+alt+3");
    expect(getRangeModifiers(OPEN)).toBe("ctrl");
    setRangeFromCombo(OPEN, "shift+alt+x");
    expect(getBinding("open-chat-3")).toBe("shift+alt+3");
    expect(getBinding("open-chat-1")).toBe("shift+alt+1");
  });
});

describe("range reset", () => {
  it("clears all 9 overrides", () => {
    setRangeFromCombo(OPEN, "shift+alt+x");
    resetRange(OPEN);
    rangeIds(OPEN).forEach((id, i) => {
      expect(hasOverride(id)).toBe(false);
      expect(getBinding(id)).toBe(`ctrl+${i + 1}`);
    });
  });

  it("is reported as an override when only one slot differs", () => {
    setBinding("open-chat-7", "shift+alt+7");
    expect(rangeHasOverride(OPEN)).toBe(true);
    resetRange(OPEN);
    expect(rangeHasOverride(OPEN)).toBe(false);
  });
});

describe("a default added after the user rebound a range onto it", () => {
  it("resolves each Alt digit to exactly one action, the user's rebound slot", () => {
    // Stored before the set-model-N defaults existed: the Open chat range on Alt.
    rangeIds(OPEN).forEach((id, i) => setBinding(id, `alt+${i + 1}`));
    for (let n = 1; n <= 4; n++) {
      expect(resolveCombo(`alt+${n}`)?.id).toBe(`open-chat-${n}`);
      expect(findConflict(`alt+${n}`)?.id).toBe(`open-chat-${n}`);
      expect(getBinding(`set-model-${n}`)).toBe("");
    }
  });

  it("leaves model slots the range does not claim on their defaults", () => {
    setBinding("open-chat-1", "alt+1");
    expect(resolveCombo("alt+1")?.id).toBe("open-chat-1");
    expect(getBinding("set-model-1")).toBe("");
    expect(getBinding("set-model-2")).toBe("alt+2");
    expect(resolveCombo("alt+2")?.id).toBe("set-model-2");
  });

  it("gives the keys back to the model slot once the range is reset", () => {
    setBinding("open-chat-1", "alt+1");
    resetRange(OPEN);
    expect(getBinding("set-model-1")).toBe("alt+1");
    expect(resolveCombo("alt+1")?.id).toBe("set-model-1");
  });

  it("keeps an explicit override on the model slot itself", () => {
    setBinding("set-model-1", "alt+9");
    setBinding("open-chat-1", "alt+1");
    expect(getBinding("set-model-1")).toBe("alt+9");
    resetBinding("set-model-1");
  });
});
