// @vitest-environment jsdom
//
// Regression for a code-check finding (2026-10-18): the phone kebab menu's
// "Hidden" submenu rendered every hidden chat's row with hardcoded-empty
// unread/attention/question/rateLimited/closing sets, so a hidden chat that
// was genuinely rate-limited (or closing, or needing input) showed a plain
// neutral status dot - the same as a hidden chat doing nothing. This drives
// the real toggleViewMoreMenu (not a stub) so a regression back to blank
// sets is caught.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => true };
});

const { toggleViewMoreMenu } = await import("../src/views/sessions/view-more-menu.ts");
const { state } = await import("../src/views/sessions/state.ts");

function mountHeader() {
  document.body.innerHTML = `
    <div class="view-header">
      <button class="icon-btn more-btn" id="viewMoreBtn"></button>
    </div>
    <div id="view-more-host" hidden>
      <button id="newSessionBtn"></button>
      <button id="historyBtn"></button>
      <button id="previewToggleBtn"></button>
    </div>
  `;
  return document.getElementById("viewMoreBtn");
}

describe("phone kebab menu: Hidden submenu carries real row status", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.sessions = [];
    state.parkedDrafts = [];
    state.selectedId = null;
    state.pendingNewSession = null;
    state.filter = "";
    localStorage.clear();
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hidden-1"]));
  });

  it("marks a rate-limited hidden session's row is-rate-limited, not a bare neutral row", () => {
    const futureUnixSeconds = Math.floor(Date.now() / 1000) + 3600;
    state.sessions = [
      {
        session_id: "hidden-1",
        cwd: "/proj-a",
        model: "opus",
        kind: "interactive",
        busy: false,
        rate_limited_resets_at: String(futureUnixSeconds),
      },
    ];

    const btn = mountHeader();
    toggleViewMoreMenu(btn);

    const hiddenItem = [...document.querySelectorAll(".smore-item")].find((el) => el.textContent?.includes("Hidden"));
    expect(hiddenItem).toBeTruthy();
    hiddenItem.click();

    const row = document.querySelector('.smore-hidden-list li[data-session-id="hidden-1"]');
    expect(row).toBeTruthy();
    expect(row.classList.contains("is-rate-limited")).toBe(true);
  });
});
