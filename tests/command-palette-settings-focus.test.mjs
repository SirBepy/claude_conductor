// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { findSettingRow, focusSettingRow } from "../src/views/command-palette/settings-focus.ts";

Element.prototype.scrollIntoView ??= () => {};

const row = (label) => `<div class="kit-row"><span class="kit-row-label">${label}</span><input type="checkbox"></div>`;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findSettingRow", () => {
  it("finds the row by label prefix, ignoring case and extra whitespace", () => {
    document.body.innerHTML = row("Mute sounds") + row("Gaming   mode");
    expect(findSettingRow(document.body, "gaming mode")?.textContent).toContain("Gaming");
    expect(findSettingRow(document.body, "mute")?.textContent).toContain("Mute sounds");
  });

  it("returns null when no row has the label", () => {
    document.body.innerHTML = row("Mute sounds");
    expect(findSettingRow(document.body, "Lock this app")).toBeNull();
  });

  it("returns the row element, not just its label", () => {
    document.body.innerHTML = row("Mute sounds");
    expect(findSettingRow(document.body, "Mute sounds")?.className).toBe("kit-row");
  });
});

describe("focusSettingRow", () => {
  it("waits for a page that renders after the jump, then flashes the row", async () => {
    const done = focusSettingRow("Gaming mode");
    setTimeout(() => { document.body.innerHTML = row("Gaming mode"); }, 20);
    expect(await done).toBe(true);
    expect(document.querySelector(".kit-row").classList.contains("palette-flash")).toBe(true);
  });

  it("flashes a row that is already on screen", async () => {
    document.body.innerHTML = row("Gaming mode");
    expect(await focusSettingRow("Gaming mode")).toBe(true);
    expect(document.querySelector(".kit-row").classList.contains("palette-flash")).toBe(true);
  });
});
