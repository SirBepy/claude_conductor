// @vitest-environment jsdom
// Todo 1021: project-picker.ts (and location-picker.ts, worktree-picker.ts,
// same pattern) captured `document.activeElement` as the trigger at open and
// called `trigger?.focus?.()` unconditionally on close. Opened from the
// kebab menu's "New chat" item, view-more-menu.ts relocates that item back
// into #view-more-host on close, which carries the native `hidden` attribute
// (template.ts) - the trigger is still `.isConnected` but no longer
// focusable, so `.focus()` silently no-ops and focus drops to <body>.
//
// jsdom has no layout engine (offsetParent is always null), so the fix
// checks `closest("[hidden]")` + `isConnected` instead of a layout property -
// exactly the DOM shape this bug has, and the one jsdom can actually model.

import { describe, it, expect } from "vitest";
import { restoreFocus } from "../src/views/sessions/restore-focus.ts";

describe("restoreFocus", () => {
  it("focuses a visible, connected trigger directly", () => {
    document.body.innerHTML = "";
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);

    restoreFocus(trigger);

    expect(document.activeElement).toBe(trigger);
  });

  it("falls back to #viewMoreBtn when the trigger sits inside a hidden ancestor", () => {
    document.body.innerHTML = "";
    const viewMoreBtn = document.createElement("button");
    viewMoreBtn.id = "viewMoreBtn";
    document.body.appendChild(viewMoreBtn);

    // Mirrors #view-more-host: the relocated "New chat" item is still
    // .isConnected but sits inside a `hidden` container.
    const hiddenHost = document.createElement("div");
    hiddenHost.id = "view-more-host";
    hiddenHost.hidden = true;
    const trigger = document.createElement("button");
    trigger.id = "newSessionBtn";
    hiddenHost.appendChild(trigger);
    document.body.appendChild(hiddenHost);

    restoreFocus(trigger);

    expect(document.activeElement).toBe(viewMoreBtn);
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does nothing when neither the trigger nor the fallback is focusable", () => {
    document.body.innerHTML = "";
    const hiddenHost = document.createElement("div");
    hiddenHost.hidden = true;
    const trigger = document.createElement("button");
    hiddenHost.appendChild(trigger);
    document.body.appendChild(hiddenHost);

    expect(() => restoreFocus(trigger)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it("falls back to #viewMoreBtn when the trigger is null", () => {
    document.body.innerHTML = "";
    const viewMoreBtn = document.createElement("button");
    viewMoreBtn.id = "viewMoreBtn";
    document.body.appendChild(viewMoreBtn);

    restoreFocus(null);

    expect(document.activeElement).toBe(viewMoreBtn);
  });

  it("does nothing when the trigger was removed from the document", () => {
    document.body.innerHTML = "";
    const trigger = document.createElement("button");
    // Never appended - not .isConnected.

    expect(() => restoreFocus(trigger)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
