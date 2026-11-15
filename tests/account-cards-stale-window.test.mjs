// @vitest-environment jsdom
// asserts: src/views/dashboard/account-selector.ts

// A window whose reset already passed draws "--" on the dashboard's account card, like the
// overlay dial and the Change account line ("Usage unknown"), until the poller refreshes.

import { describe, it, expect } from "vitest";
import { buildAccountCardsHTML } from "../src/views/dashboard/account-selector.ts";

const account = { id: "acc-1", label: "Personal", icon: "user", colour: "#8b5cf6" };
const hours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

function rings(usage) {
  const box = document.createElement("div");
  box.innerHTML = buildAccountCardsHTML([account], { "acc-1": usage }, null, {});
  return [...box.querySelectorAll(".dash-ring-col")].map((c) => c.querySelector(".dash-ring-cur").textContent);
}

describe("account card rings", () => {
  it("draws a dash for a window that already reset and the figure for one still running", () => {
    expect(rings({ session_pct: 97, session_resets_at: hours(-1), weekly_pct: 62, weekly_resets_at: hours(48) })).toEqual(["--", "62%"]);
    expect(rings({ session_pct: 97, session_resets_at: hours(2), weekly_pct: 62, weekly_resets_at: hours(-3) })).toEqual(["97%", "--"]);
  });
});
