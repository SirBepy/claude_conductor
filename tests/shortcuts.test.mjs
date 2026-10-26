// tests/shortcuts.test.mjs
import { describe, it, expect } from "vitest";
import { normalizeEvent, findConflict, getAll } from "../src/shared/shortcuts.ts";

describe("normalizeEvent", () => {
  it("ctrl+n", () => {
    expect(normalizeEvent({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: "n" }))
      .toBe("ctrl+n");
  });

  it("ctrl+shift+h lowercases key", () => {
    expect(normalizeEvent({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: "H" }))
      .toBe("ctrl+shift+h");
  });

  it("ctrl+1 digit key", () => {
    expect(normalizeEvent({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, key: "1" }))
      .toBe("ctrl+1");
  });

  it("bare Control key returns empty string", () => {
    expect(normalizeEvent({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: "Control" }))
      .toBe("");
  });

  it("bare Shift key returns empty string", () => {
    expect(normalizeEvent({ ctrlKey: false, shiftKey: true, altKey: false, metaKey: false, key: "Shift" }))
      .toBe("");
  });

  it("metaKey treated as ctrl", () => {
    expect(normalizeEvent({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, key: "n" }))
      .toBe("ctrl+n");
  });

  it("ctrl+w", () => {
    expect(normalizeEvent({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: "w" }))
      .toBe("ctrl+w");
  });
});

describe("findConflict", () => {
  it("finds the definition with the default binding", () => {
    const conflict = findConflict("ctrl+n");
    expect(conflict).not.toBeNull();
    expect(conflict?.id).toBe("new-chat");
  });

  it("returns null for unknown combo", () => {
    expect(findConflict("ctrl+z")).toBeNull();
  });

  it("excludeId skips that definition", () => {
    const conflict = findConflict("ctrl+n", "new-chat");
    expect(conflict).toBeNull();
  });

  it("finds chats-view shortcut by default binding", () => {
    const conflict = findConflict("ctrl+1");
    expect(conflict?.id).toBe("open-chat-1");
  });
});

describe("close-chat shortcut", () => {
  // A draft's composer is auto-focused, so a suppressed Ctrl+W never closed it.
  it("fires even while an input/textarea has focus", () => {
    const def = getAll().find(d => d.id === "close-chat");
    expect(def?.suppressInInput).toBe(false);
  });
});

describe("new-chat shortcut", () => {
  it("fires even while an input/textarea has focus", () => {
    const def = getAll().find(d => d.id === "new-chat");
    expect(def?.suppressInInput).toBe(false);
  });
});
