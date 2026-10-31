import { describe, it, expect } from "vitest";
import {
  migrateLegacyPinnedCards,
  resolveDashboardWidgets,
  widgetScope,
  enabledWidgetIds,
  setWidgetEnabled,
  moveWidget,
  widgetNeedsAccountRerender,
  widgetsNeedingAccountRerender,
  WIDGET_METAS,
} from "../src/views/dashboard/dashboard-widget-logic.ts";

describe("migrateLegacyPinnedCards", () => {
  it("carries forward pinned ids as enabled, in pinned order first", () => {
    const out = migrateLegacyPinnedCards(["weekly-chart", "today"]);
    expect(out[0]).toEqual({ id: "weekly-chart", enabled: true });
    expect(out[1]).toEqual({ id: "today", enabled: true });
  });

  it("force-enables today and skill-usage even when not previously pinned", () => {
    const out = migrateLegacyPinnedCards([]);
    const byId = Object.fromEntries(out.map((w) => [w.id, w.enabled]));
    expect(byId["today"]).toBe(true);
    expect(byId["skill-usage"]).toBe(true);
  });

  it("appends every remaining registry widget disabled, with no duplicates", () => {
    const out = migrateLegacyPinnedCards(["session-chart"]);
    const ids = out.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(WIDGET_METAS.map((w) => w.id).sort());
    const byId = Object.fromEntries(out.map((w) => [w.id, w.enabled]));
    expect(byId["session-bars"]).toBe(false);
    expect(byId["weekly-chart"]).toBe(false);
  });

  it("ignores unknown legacy ids and non-array/garbage input", () => {
    expect(migrateLegacyPinnedCards(["not-a-real-id"]).some((w) => w.id === "not-a-real-id")).toBe(false);
    expect(() => migrateLegacyPinnedCards(null)).not.toThrow();
    expect(() => migrateLegacyPinnedCards(undefined)).not.toThrow();
    expect(() => migrateLegacyPinnedCards("today")).not.toThrow();
  });
});

describe("resolveDashboardWidgets", () => {
  it("migrates once from pinnedCards when dashboardWidgets is absent", () => {
    const out = resolveDashboardWidgets({ pinnedCards: ["today"] });
    expect(out.find((w) => w.id === "today")).toEqual({ id: "today", enabled: true });
  });

  it("returns the persisted layout verbatim (plus forward-compat fill) once migrated, ignoring pinnedCards", () => {
    const out = resolveDashboardWidgets({
      dashboardWidgets: [{ id: "today", enabled: false }],
      pinnedCards: ["session-chart"], // must be ignored - already migrated
    });
    expect(out.find((w) => w.id === "today")).toEqual({ id: "today", enabled: false });
    expect(out.find((w) => w.id === "session-chart")).toEqual({ id: "session-chart", enabled: false });
  });

  it("treats an already-saved empty array as 'migrated', not 'needs migration'", () => {
    const out = resolveDashboardWidgets({ dashboardWidgets: [], pinnedCards: ["today"] });
    expect(out.every((w) => w.enabled === false)).toBe(true);
  });

  it("appends registry ids missing from a persisted (older) layout, disabled", () => {
    const out = resolveDashboardWidgets({ dashboardWidgets: [{ id: "today", enabled: true }] });
    const ids = out.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining(WIDGET_METAS.map((w) => w.id)));
  });

  it("drops malformed entries in a persisted layout", () => {
    const out = resolveDashboardWidgets({
      dashboardWidgets: [{ id: "today", enabled: true }, { id: "bogus" }, null, "junk"],
    });
    expect(out.filter((w) => w.id === "today")).toHaveLength(1);
    expect(out.some((w) => w.id === "bogus")).toBe(false);
  });
});

describe("widgetScope", () => {
  it("reports global for today/skill-usage", () => {
    expect(widgetScope("today")).toBe("global");
    expect(widgetScope("skill-usage")).toBe("global");
  });
  it("reports account for the chart/bar widgets", () => {
    expect(widgetScope("session-chart")).toBe("account");
    expect(widgetScope("session-bars")).toBe("account");
    expect(widgetScope("weekly-chart")).toBe("account");
    expect(widgetScope("weekly-bars")).toBe("account");
  });
  it("returns null for an unknown id", () => {
    expect(widgetScope("does-not-exist")).toBeNull();
  });
});

describe("enabledWidgetIds / setWidgetEnabled / moveWidget", () => {
  it("enabledWidgetIds preserves layout order and filters disabled", () => {
    const layout = [
      { id: "b", enabled: true },
      { id: "a", enabled: false },
      { id: "c", enabled: true },
    ];
    expect(enabledWidgetIds(layout)).toEqual(["b", "c"]);
  });

  it("setWidgetEnabled toggles an existing entry without reordering", () => {
    const layout = [{ id: "a", enabled: true }, { id: "b", enabled: false }];
    const out = setWidgetEnabled(layout, "a", false);
    expect(out).toEqual([{ id: "a", enabled: false }, { id: "b", enabled: false }]);
  });

  it("setWidgetEnabled appends a new id when enabling something not yet in the layout", () => {
    const out = setWidgetEnabled([{ id: "a", enabled: true }], "c", true);
    expect(out).toEqual([{ id: "a", enabled: true }, { id: "c", enabled: true }]);
  });

  it("setWidgetEnabled is a no-op disabling an id absent from the layout", () => {
    const layout = [{ id: "a", enabled: true }];
    expect(setWidgetEnabled(layout, "z", false)).toEqual(layout);
  });

  it("moveWidget swaps with the neighbour in the given direction", () => {
    const layout = [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: true }];
    const movedDown = moveWidget(layout, "a", 1);
    expect(movedDown.map((w) => w.id)).toEqual(["b", "a", "c"]);
    const movedUp = moveWidget(layout, "c", -1);
    expect(movedUp.map((w) => w.id)).toEqual(["a", "c", "b"]);
  });

  it("moveWidget no-ops at the boundaries or for an unknown id", () => {
    const layout = [{ id: "a", enabled: true }, { id: "b", enabled: true }];
    expect(moveWidget(layout, "a", -1)).toEqual(layout);
    expect(moveWidget(layout, "b", 1)).toEqual(layout);
    expect(moveWidget(layout, "z", 1)).toEqual(layout);
  });
});

describe("widgetNeedsAccountRerender / widgetsNeedingAccountRerender", () => {
  it("is false for global widgets regardless of account change", () => {
    expect(widgetNeedsAccountRerender("today", "acct-a", "acct-b")).toBe(false);
    expect(widgetNeedsAccountRerender("skill-usage", "acct-a", null)).toBe(false);
  });

  it("is true for account-scoped widgets only when the id actually changes", () => {
    expect(widgetNeedsAccountRerender("session-chart", "acct-a", "acct-b")).toBe(true);
    expect(widgetNeedsAccountRerender("session-chart", "acct-a", "acct-a")).toBe(false);
    expect(widgetNeedsAccountRerender("session-chart", null, "acct-a")).toBe(true);
  });

  it("returns null->null as unchanged (no rerender) for account-scoped widgets", () => {
    expect(widgetNeedsAccountRerender("weekly-bars", null, null)).toBe(false);
  });

  it("widgetsNeedingAccountRerender filters to enabled + account-scoped + actually-changed", () => {
    const layout = [
      { id: "today", enabled: true },
      { id: "session-chart", enabled: true },
      { id: "weekly-bars", enabled: false },
      { id: "session-bars", enabled: true },
    ];
    const ids = widgetsNeedingAccountRerender(layout, "acct-a", "acct-b");
    expect(ids.sort()).toEqual(["session-bars", "session-chart"]);
  });
});

describe("Home schedule + skill widgets", () => {
  const HOME = ["schedule", "skill-top", "skill-runs"];

  it("are in the registry as global widgets", () => {
    for (const id of HOME) expect(widgetScope(id)).toBe("global");
  });

  it("are enabled on a brand-new dashboard", () => {
    const byId = Object.fromEntries(migrateLegacyPinnedCards([]).map((w) => [w.id, w.enabled]));
    for (const id of HOME) expect(byId[id]).toBe(true);
  });

  it("appear enabled in a layout saved before they shipped", () => {
    const out = resolveDashboardWidgets({ dashboardWidgets: [{ id: "today", enabled: true }] });
    const byId = Object.fromEntries(out.map((w) => [w.id, w.enabled]));
    for (const id of HOME) expect(byId[id]).toBe(true);
    expect(byId["weekly-bars"]).toBe(false);
  });

  it("stay off once the user has switched them off", () => {
    const out = resolveDashboardWidgets({
      dashboardWidgets: HOME.map((id) => ({ id, enabled: false })),
    });
    for (const id of HOME) expect(out.find((w) => w.id === id)?.enabled).toBe(false);
  });
});
