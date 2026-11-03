// @vitest-environment jsdom
//
// The Chats header menu's General section: on the desktop it carries New chat
// only, because History lives on the project dashboard, Preview is a tab in the
// chat's tool strip and Scheduled is the right rail's Schedule icon. The phone
// has none of those yet, so it keeps History, Preview and Scheduled here.

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

  it("on the desktop has no History, Preview or Scheduled, and gives the buttons back to the host on close", () => {
    transport.remote = false;
    toggleViewMoreMenu(mountHeader());
    const items = generalItems();
    expect(items).toContain("New chat");
    for (const gone of ["History", "Preview", "Scheduled"]) expect(items.join("|")).not.toContain(gone);
    closeViewMoreMenu();
    expect(document.querySelectorAll("#view-more-host > button")).toHaveLength(3);
  });

  it("on the phone keeps History, Preview and Scheduled", () => {
    transport.remote = true;
    toggleViewMoreMenu(mountHeader());
    const items = generalItems().join("|");
    for (const kept of ["New chat", "History", "Preview", "Scheduled"]) expect(items).toContain(kept);
  });
});
