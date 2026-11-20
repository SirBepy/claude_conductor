// @vitest-environment jsdom
//
// Hidden chats on the chat heads (chat-heads.ts): a hidden chat is never a head in the
// stack, on desktop and on the phone alike; the eye-slash head carries their count and
// swaps the stack for them. This drives the real renderSidebar (not a stub). The
// sidebar's project filter rail is gone (pc-1740): a filter an older build left in
// storage hides nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function mountHeads() {
  const nav = document.createElement("nav");
  nav.className = "chat-heads";
  nav.innerHTML = `<ul id="sessions-list" class="chat-heads-list"></ul>`;
  document.body.appendChild(nav);
  return nav.querySelector("#sessions-list");
}

function session(id, cwd, over = {}) {
  return { session_id: id, cwd, model: "opus", kind: "interactive", busy: false, ...over };
}

describe("Hidden chats: the eye-slash head on desktop and phone", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    remote = false;
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.sortedSessionIds = [];
    localStorage.clear();
    // One hidden session, so the eye-slash head has something to count.
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hidden-1"]));
  });

  function seedTwoProjectsOneHidden() {
    state.sessions = [session("visible-1", "/proj-a"), session("hidden-1", "/proj-b")];
  }

  for (const [label, isPhone] of [["desktop", false], ["phone", true]]) {
    it(`${label}: the eye-slash head counts the hidden chat and the hidden chat is not a head`, () => {
      remote = isPhone;
      seedTwoProjectsOneHidden();
      const listEl = mountHeads();

      renderSidebar(listEl);
      // Not runAllTimers: the sidebar's card feed keeps a reconnecting socket and a watchdog alive, so
      // the timers never run out.
      vi.advanceTimersByTime(1000);

      const eye = listEl.querySelector("li[data-heads-hidden]");
      expect(eye).not.toBeNull();
      expect(eye.querySelector(".chat-head-count").textContent).toBe("1");
      expect(listEl.querySelector('li[data-session-id="visible-1"]')).not.toBeNull();
      expect(listEl.querySelector('li[data-session-id="hidden-1"]')).toBeNull();
      // V2 badge: no status ring around any circle in the heads list.
      expect(listEl.querySelector(".avatar-ring")).toBeNull();
    });
  }

  it("a project filter an older build left in storage hides nothing", () => {
    seedTwoProjectsOneHidden();
    localStorage.setItem("cc_hidden_projects", JSON.stringify(["/proj-a"]));
    const listEl = mountHeads();

    renderSidebar(listEl);
    vi.advanceTimersByTime(1000);

    expect(listEl.querySelector('li[data-session-id="visible-1"]')).not.toBeNull();
  });

  it("with nothing hidden there is no eye-slash head", () => {
    localStorage.setItem("cc_hidden_sessions", JSON.stringify([]));
    state.sessions = [session("visible-1", "/proj-a")];
    const listEl = mountHeads();

    renderSidebar(listEl);
    vi.advanceTimersByTime(1000);

    expect(listEl.querySelector("li[data-heads-hidden]")).toBeNull();
  });
});
