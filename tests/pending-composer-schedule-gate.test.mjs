// @vitest-environment jsdom

// Red->green regression: the composer clears the draft before it calls
// onSchedule, and only a throw puts the text back. The draft pane's account
// gate used to return quietly, so scheduling a new chat with no resolved
// account threw away the typed message (and the blocked-by-limit path still
// announced "Scheduled for ..."). A refused schedule must restore the draft
// and show no scheduled notice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  localStorage.clear();
  tauriMock();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
  vi.restoreAllMocks();
});

function scheduleViaMenu(root, textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  root.querySelector(".composer-send-chevron").click();
  const scheduleRow = [...document.querySelectorAll(".composer-menu-popover [data-idx]")].find((b) =>
    b.textContent.includes("Schedule message"),
  );
  expect(scheduleRow).toBeTruthy();
  scheduleRow.click();
  const preset = document.querySelector(".schedule-picker-popover [data-preset]");
  expect(preset).toBeTruthy();
  preset.click();
}

describe("composer schedule from the chevron menu", () => {
  it("puts the text back when onSchedule refuses, and shows no scheduled notice", async () => {
    const onSchedule = vi.fn(async () => {
      throw new Error("no account picked");
    });
    const { root, textarea } = await mountComposer({ onSchedule });

    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(textarea.value).toBe("remember the milk"));
    expect(root.querySelector(".composer-notice").hidden).toBe(true);
  });

  it("clears the box when onSchedule accepts", async () => {
    const onSchedule = vi.fn(async () => {});
    const { root, textarea } = await mountComposer({ onSchedule });

    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(textarea.value).toBe("");
  });
});
