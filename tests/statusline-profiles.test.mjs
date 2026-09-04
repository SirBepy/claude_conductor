// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Joe, 2026-08-19: the phone inherited the desktop's statusline, so the chip row
// wrapped to two rows and still clipped. Desktop and mobile now key off separate
// settings entries; these pin that they never read or write each other's.
const store = { settings: {} };
const ipcMock = {
  impl: async (cmd, args) => {
    if (cmd === "get_settings") return { ...store.settings };
    if (cmd === "save_settings") { store.settings = { ...args.updated }; return null; }
    return null;
  },
};
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

let mobile = false;
vi.mock("../src/shared/mobile-viewport.ts", () => ({
  MOBILE_MQ: "(max-width: 768px)",
  isMobileViewport: () => mobile,
  onMobileViewportChange: () => () => {},
}));

const {
  loadStatuslineRows, saveStatuslineRows, activeProfile, profileMaxRows, profileDefaultRows,
  migrateStatuslineToV2,
} = await import("../src/views/sessions/session-statusbar-helpers.ts");
const { DEFAULT_ROWS, DEFAULT_MOBILE_ROWS, MOBILE_MAX_ROWS } = await import("../src/views/sessions/statusline-catalog.ts");

beforeEach(() => { store.settings = {}; mobile = false; });

describe("statusline desktop/mobile profiles", () => {
  it("writes each profile to its own settings key", async () => {
    await saveStatuslineRows([["model", "branch"]], "desktop");
    await saveStatuslineRows([["context_pct"]], "mobile");

    expect(store.settings.statuslineRows).toEqual([["model", "branch"]]);
    expect(store.settings.statuslineRowsMobile).toEqual([["context_pct"]]);
  });

  it("a configured desktop layout does not leak into mobile", async () => {
    await saveStatuslineRows([["model", "branch", "repo", "turns"]], "desktop");

    // Mobile has never been configured, so it falls back to its OWN default,
    // which is the whole point - not to the desktop rows just saved.
    expect(await loadStatuslineRows("mobile")).toEqual(DEFAULT_MOBILE_ROWS);
    expect(await loadStatuslineRows("desktop")).toEqual([["model", "branch", "repo", "turns"]]);
  });

  it("caps the mobile profile at one row so the bar can never wrap", async () => {
    expect(profileMaxRows("mobile")).toBe(MOBILE_MAX_ROWS);
    await saveStatuslineRows([["model"], ["branch"], ["turns"]], "mobile");

    expect(store.settings.statuslineRowsMobile).toHaveLength(1);
    expect(await loadStatuslineRows("mobile")).toHaveLength(1);
  });

  it("keeps the desktop cap unchanged at five rows", async () => {
    await saveStatuslineRows([["model"], ["branch"], ["turns"], ["cost"], ["clock"]], "desktop");
    expect(store.settings.statuslineRows).toHaveLength(5);
  });

  it("picks the profile from the viewport when none is passed", async () => {
    await saveStatuslineRows([["model", "branch"]], "desktop");
    await saveStatuslineRows([["context_pct"]], "mobile");

    expect(activeProfile()).toBe("desktop");
    expect(await loadStatuslineRows()).toEqual([["model", "branch"]]);

    mobile = true;
    expect(activeProfile()).toBe("mobile");
    expect(await loadStatuslineRows()).toEqual([["context_pct"]]);
  });

  it("migrates legacy statuslineFields for desktop only", async () => {
    store.settings = { statuslineFields: ["model", "branch"], tallyHiddenTools: [] };

    const desktop = await loadStatuslineRows("desktop");
    expect(desktop[0]).toEqual(["model", "branch"]);
    // The mobile profile postdates the legacy format, so it must not adopt it.
    expect(await loadStatuslineRows("mobile")).toEqual(DEFAULT_MOBILE_ROWS);
  });

  // The merged git + overflow chips subsume six chips a saved layout still lists
  // individually, so a default-only change would leave both halves rendering for
  // anyone who had ever opened the builder.
  it("rewrites both saved profiles once, then never again", async () => {
    store.settings = { statuslineRows: [["model", "branch", "repo", "commits"]], statuslineRowsMobile: [["model"]] };

    await migrateStatuslineToV2();
    expect(store.settings.statuslineRows).toEqual(DEFAULT_ROWS);
    expect(store.settings.statuslineRowsMobile).toEqual(DEFAULT_MOBILE_ROWS);
    expect(store.settings.statuslineRowsV2Applied).toBe(true);

    // A layout picked AFTER the migration survives the next boot.
    await saveStatuslineRows([["model", "turns"]], "desktop");
    await migrateStatuslineToV2();
    expect(store.settings.statuslineRows).toEqual([["model", "turns"]]);
  });

  it("leaves every other setting alone while rewriting the rows", async () => {
    store.settings = { theme: "glacier", statuslineHideZero: false, statuslineRows: [["model"]] };
    await migrateStatuslineToV2();
    expect(store.settings.theme).toBe("glacier");
    expect(store.settings.statuslineHideZero).toBe(false);
  });

  it("keeps the two defaults to a single row that can never wrap on a phone", () => {
    expect(profileDefaultRows("desktop")).toEqual(DEFAULT_ROWS);
    expect(profileDefaultRows("mobile")).toHaveLength(1);
    const mobileRow = profileDefaultRows("mobile")[0];
    // The header prints the project and the model/effort pair, and there is one
    // account - none of them earns a chip here.
    for (const redundant of ["account", "repo", "branch", "model", "effort"]) {
      expect(mobileRow).not.toContain(redundant);
    }
  });
});
