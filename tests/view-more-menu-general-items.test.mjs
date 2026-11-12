// @vitest-environment jsdom
//
// The phone's Chats header menu: its General section carries New chat, History,
// Preview and Scheduled, and it has no desktop-only "When done" row. The button
// that opens it renders on the phone only (template.ts), so the desktop is not
// exercised here.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const transport = { remote: false };
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => transport.remote };
});

const { toggleViewMoreMenu, closeViewMoreMenu } = await import("../src/views/sessions/view-more-menu.ts");
const { state } = await import("../src/views/sessions/state.ts");

function mountHeader() {
  document.body.innerHTML = `
    <div class="view-header"><button class="icon-btn more-btn" id="viewMoreBtn"></button></div>
    <div id="view-more-host" hidden>
      <button id="newSessionBtn">New chat</button>
      <button id="historyBtn">History</button>
      <button id="previewToggleBtn">Preview</button>
    </div>`;
  return document.getElementById("viewMoreBtn");
}

const generalItems = () => [...document.querySelectorAll(".view-more-menu button")].map((el) => el.textContent.trim());

describe("Chats header menu, General section", () => {
  beforeEach(() => {
    closeViewMoreMenu();
    document.body.innerHTML = "";
    state.sessions = [];
    state.parkedDrafts = [];
    state.selectedId = null;
    state.pendingNewSession = null;
    localStorage.clear();
  });

  it("on the phone has New chat, History, Preview and Scheduled, and no When done", () => {
    transport.remote = true;
    toggleViewMoreMenu(mountHeader());
    const items = generalItems().join("|");
    for (const kept of ["New chat", "History", "Preview", "Scheduled"]) expect(items).toContain(kept);
    expect(items).not.toContain("When done");
  });

  it("gives the relocated buttons back to the host on close", () => {
    transport.remote = true;
    toggleViewMoreMenu(mountHeader());
    closeViewMoreMenu();
    expect(document.querySelectorAll("#view-more-host > button")).toHaveLength(3);
  });
});
