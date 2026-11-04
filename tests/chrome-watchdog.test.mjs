import { describe, it, expect } from "vitest";

const { brokenChromeReason } = await import("../src/views/sessions/chrome-watchdog.ts");

const OK = {
  hasComposer: true,
  composerInputVisible: true,
  composerInputBottom: 780,
  viewportHeight: 800,
  cardMounted: false,
  scrolledAncestors: [],
  transcriptPaddingBottom: 18,
};

describe("brokenChromeReason", () => {
  it("is null for a healthy pane", () => {
    expect(brokenChromeReason(OK)).toBeNull();
  });

  it("flags a hidden composer when no card is mounted", () => {
    expect(brokenChromeReason({ ...OK, composerInputVisible: false })).toBe("composer hidden with no card");
  });

  it("lets an open card hide the composer", () => {
    expect(brokenChromeReason({ ...OK, composerInputVisible: false, cardMounted: true })).toBeNull();
  });

  it("ignores a pane with no composer (dashboard, empty state)", () => {
    expect(brokenChromeReason({ ...OK, hasComposer: false, composerInputVisible: false })).toBeNull();
  });

  it("flags a composer pushed below the viewport", () => {
    expect(brokenChromeReason({ ...OK, composerInputBottom: 940 })).toBe("composer below the viewport");
  });

  it("flags a scrolled ancestor even with a card open", () => {
    expect(
      brokenChromeReason({ ...OK, cardMounted: true, composerInputVisible: false, scrolledAncestors: ["div.view-body top=148"] }),
    ).toBe("ancestor scrolled");
  });

  it("joins several reasons", () => {
    expect(
      brokenChromeReason({ ...OK, composerInputVisible: false, scrolledAncestors: ["div.x top=1"] }),
    ).toBe("ancestor scrolled, composer hidden with no card");
  });
});
