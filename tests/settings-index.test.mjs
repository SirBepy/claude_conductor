// @vitest-environment jsdom
// Settings index after the "one job per page" regroup: every page has a nav
// row, the rows whose page is desktop-only are dropped on the phone, and the
// Statusline page is gone (its editor lives on the chat's own bar now).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/sidemenu.ts", () => ({ openSidemenu: vi.fn() }));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderSettingsView } = await import("../src/views/settings/settings.ts");

async function rowLabels() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderSettingsView(root);
  return [...root.querySelectorAll(".kit-nav-row .kit-row-label")].map((e) => e.textContent.trim());
}

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("Settings index", () => {
  it("lists every page on desktop, with no Statusline row and no Gaming mode toggle", async () => {
    const labels = await rowLabels();
    expect(labels).toEqual([
      "Appearance", "Usage meter", "Notifications", "Voice & dictation", "Characters", "Skills",
      "Chat defaults", "Permissions", "Claude's browser",
      "Claude accounts & API keys", "Remote access",
      "Power & startup", "Shortcuts", "Data & storage", "About & updates",
    ]);
    expect(document.querySelector("#gamingModeToggle")).toBeNull();
  });

  it("drops the desktop-only pages on the phone", async () => {
    remote = true;
    const labels = await rowLabels();
    expect(labels).not.toContain("Usage meter");
    expect(labels).not.toContain("Claude's browser");
    expect(labels).not.toContain("Data & storage");
    expect(labels).not.toContain("Shortcuts");
    expect(labels).toContain("Notifications");
  });
});
