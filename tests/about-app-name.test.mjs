// @vitest-environment jsdom

// The About page names the app by its shipped product name, so a rename in
// tauri.conf.json cannot leave the old name on the page.

import { describe, it, expect, vi } from "vitest";
import conf from "../src-tauri/tauri.conf.json";

vi.mock("../src/shared/api.ts", () => ({
  api: {
    getVersionInfo: async () => ({ version: "1.0.0", build_date: "unknown", installed_at: null }),
    getUpdateState: async () => ({ state: "up-to-date" }),
    onUpdateStateChange: () => () => {},
  },
}));
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}) }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings: async () => {} }));

const { renderAboutView } = await import("../src/views/settings/subviews/about/about.ts");

describe("About page app name", () => {
  it("matches tauri.conf.json's productName", async () => {
    const root = document.createElement("div");
    await renderAboutView(root);
    expect(root.textContent).toContain(conf.productName);
  });
});
