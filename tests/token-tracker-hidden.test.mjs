// @vitest-environment jsdom
//
// The token tracker's numbers are inaccurate, so every surface drawn from transcript token
// records or drain is hidden (shared/token-tracker.ts). The claude.ai usage-% surfaces stay.

import { describe, it, expect, vi } from "vitest";
import { nothing } from "lit-html";

const { api } = vi.hoisted(() => ({
  api: {
    getStorageInfo: vi.fn(async () => [
      { dataset: "UsageSnapshots", label: "Usage History", record_count: 0n, oldest_entry: null, newest_entry: null, retention: "forever", total_db_bytes: 0n },
      { dataset: "TokenRecords", label: "Token Records", record_count: 0n, oldest_entry: null, newest_entry: null, retention: "forever", total_db_bytes: 0n },
    ]),
  },
}));
vi.mock("../src/shared/api.ts", () => ({ api }));
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => false }));

const { TOKEN_TRACKER_HIDDEN, TOKEN_TRACKER_WIDGET_IDS } = await import("../src/shared/token-tracker.ts");
const { getWidget } = await import("../src/views/dashboard/widget-registry.ts");
const { DrainPopover } = await import("../src/views/sessions/drain-popover.ts");
const { usage } = await import("../src/views/sessions/project-dashboard/dash-usage.ts");
const { renderDataView } = await import("../src/views/settings/subviews/data/data.ts");

describe("token tracker is hidden", () => {
  it("is on", () => {
    expect(TOKEN_TRACKER_HIDDEN).toBe(true);
  });

  it("the Home widgets drawn from token records are not in the registry, the usage-% ones are", () => {
    for (const id of TOKEN_TRACKER_WIDGET_IDS) expect(getWidget(id)).toBeUndefined();
    expect([...TOKEN_TRACKER_WIDGET_IDS].sort()).toEqual(["session-bars", "today", "token-source", "weekly-bars"]);
    for (const id of ["session-chart", "weekly-chart", "schedule", "skill-usage"]) expect(getWidget(id)).toBeDefined();
  });

  it("the per-chat drain chip draws nothing and never asks for the drain", async () => {
    const p = new DrainPopover();
    expect(p.renderChip(() => "")).toBe("");
    p.drain = { sessionId: "s", tokens: 1n, fiveHourPct: 60, weeklyPct: 5, messages: [] };
    expect(p.renderChip(() => "")).toBe("");
    const rerender = vi.fn();
    await p.refresh("s", rerender, () => {});
    expect(rerender).not.toHaveBeenCalled();
  });

  it("the project dashboard Usage card is not drawn", () => {
    const c = { usage: { range: "30d", records: [] }, snap: { target: { repos: [] } }, nowMs: Date.now(), act: {} };
    expect(usage(c, {})).toBe(nothing);
  });

  it("Settings > Data hides the token records dataset and tags the Token history rows", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderDataView(root);
    const cards = root.querySelector("#dataCards").textContent;
    expect(cards).toContain("Usage History");
    expect(cards).not.toContain("Token Records");
    expect(root.querySelector("#dataRebuildHistory").closest('[data-feature="token-stats"]')).not.toBeNull();
  });
});
