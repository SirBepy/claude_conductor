// @vitest-environment jsdom
//
// Critique-driven mobile Chats overhaul (2026-10-18): the project-filter
// rail and the "Hidden (N)" row both used to render inline in the sidebar on
// every viewport. On the phone that meant a permanent chip row fusing into
// the "Done" segment header above it, and a Hidden row pinned to the bottom
// via margin-top:auto landing directly under the floating "new chat" FAB.
// Both moved into the kebab "more options" menu for the phone transport
// (view-more-menu.ts); desktop keeps the inline versions unchanged. This
// drives the real renderSidebar/buildSidebarEntries (not a stub), so a
// regression that brings either one back inline on the phone is caught.

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

function mountSidebar() {
  const aside = document.createElement("aside");
  aside.className = "sessions-sidebar";
  aside.innerHTML = `
    <div id="project-rail" class="project-rail" hidden></div>
    <ul id="sessions-list" class="sessions-list"></ul>
  `;
  document.body.appendChild(aside);
  return aside.querySelector("#sessions-list");
}

function session(id, cwd, over = {}) {
  return { session_id: id, cwd, model: "opus", kind: "interactive", busy: false, ...over };
}

describe("project rail + Hidden row: inline on desktop, kebab-only on the phone", () => {
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
    // Two distinct projects (project-rail.ts only renders at 2+) and one
    // hidden session, so both surfaces under test have something to show.
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hidden-1"]));
  });

  function seedTwoProjectsOneHidden() {
    state.sessions = [
      session("visible-1", "/proj-a"),
      session("hidden-1", "/proj-b"),
    ];
  }

  it("desktop: renders the project rail inline and the Hidden row in the list", () => {
    remote = false;
    seedTwoProjectsOneHidden();
    const listEl = mountSidebar();

    renderSidebar(listEl);
    vi.runAllTimers();

    const rail = document.getElementById("project-rail");
    expect(rail.hidden).toBe(false);
    expect(rail.querySelector(".project-rail-all")).not.toBeNull();
    expect(listEl.querySelector("li.session-group-hidden-toggle")).not.toBeNull();
  });

  it("phone: renders neither the inline project rail nor the inline Hidden row", () => {
    remote = true;
    seedTwoProjectsOneHidden();
    const listEl = mountSidebar();

    renderSidebar(listEl);
    vi.runAllTimers();

    const rail = document.getElementById("project-rail");
    expect(rail.innerHTML).toBe("");
    expect(listEl.querySelector("li.session-group-hidden-toggle")).toBeNull();
    // The hidden session itself must not leak into the visible list either.
    expect(listEl.querySelector('li[data-session-id="hidden-1"]')).toBeNull();
  });
});
