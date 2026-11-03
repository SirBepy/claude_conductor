// A plan with no 5h limit draws one ring (the weekly one) and no 5h text, in
// both the overlay dial and the dashboard account card.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/router", () => ({ navigateTo: vi.fn() }));

import { cellHtml } from "../src/shared/usage-dial.ts";
import { buildAccountCardsHTML } from "../src/views/dashboard/account-selector.ts";
import { buildOverlayRow } from "../src/views/overlay/overlay-logic.ts";

const account = { id: "a1", label: "personal", colour: "#9d7dfc", icon: "user" };
const settings = {};
const usage = {
  session_pct: 0,
  session_resets_at: null,
  weekly_pct: 36,
  weekly_resets_at: "2026-11-07T11:00:00Z",
};

function circles(html) {
  return (html.match(/<circle cx="22" cy="22" r="(19|12)"/g) ?? []).length;
}

describe("overlay dial", () => {
  it("draws only the weekly ring when the plan has no 5h limit", () => {
    const row = buildOverlayRow(account, { ...usage, session_limited: false });
    const html = cellHtml(row, settings, false);
    // Track + arc(s) of ONE ring, all on the outer radius; no inner-radius ring.
    expect(html).not.toContain('r="12"');
    expect(circles(html)).toBeGreaterThan(0);
    // The 7d reset countdown can read "85h", so match the 5h row label itself.
    expect(html).not.toContain('oc-reset-k">5h');
    expect(html).toContain('oc-reset-k">7d');
  });

  it("keeps both rings for a plan that has a 5h limit", () => {
    const row = buildOverlayRow(account, { ...usage, session_limited: true });
    const html = cellHtml(row, settings, false);
    expect(html).toContain('r="12"');
    expect(html).toContain('r="19"');
  });
});

describe("dashboard account card", () => {
  it("shows only the 7d ring when the plan has no 5h limit", () => {
    const html = buildAccountCardsHTML([account], { a1: { ...usage, session_limited: false } }, null, settings);
    expect(html).not.toContain(">5h<");
    expect(html).toContain(">7d<");
  });

  it("shows a dash on the 5h ring while its window is not running", () => {
    const html = buildAccountCardsHTML([account], { a1: { ...usage, session_limited: true } }, null, settings);
    expect(html).toContain(">5h<");
    expect(html).toContain("dash-ring-cur-dim");
  });
});
