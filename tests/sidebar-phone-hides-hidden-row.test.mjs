// @vitest-environment jsdom
//
// The "Hidden (N)" row renders inline in the desktop sidebar, but on the phone it
// lives in the kebab "more options" menu (view-more-menu.ts): inline it sat
// pinned under the floating "new chat" FAB. This drives the real
// renderSidebar/buildSidebarEntries (not a stub). The sidebar's project filter
// rail is gone (pc-1740): a filter an older build left in storage hides nothing.

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
    <ul id="sessions-list" class="sessions-list"></ul>
  `;
  document.body.appendChild(aside);
  return aside.querySelector("#sessions-list");
}

function session(id, cwd, over = {}) {
  return { session_id: id, cwd, model: "opus", kind: "interactive", busy: false, ...over };
}

describe("Hidden row: inline on desktop, kebab-only on the phone", () => {
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
    // One hidden session, so the Hidden row has something to show.
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["hidden-1"]));
  });

  function seedTwoProjectsOneHidden() {
    state.sessions = [
      session("visible-1", "/proj-a"),
      session("hidden-1", "/proj-b"),
    ];
  }

  it("desktop: renders the Hidden row in the list", () => {
    remote = false;
    seedTwoProjectsOneHidden();
    const listEl = mountSidebar();

    renderSidebar(listEl);
    vi.runAllTimers();

    expect(listEl.querySelector("li.session-group-hidden-toggle")).not.toBeNull();
  });

  it("a project filter an older build left in storage hides nothing", () => {
    remote = false;
    seedTwoProjectsOneHidden();
    localStorage.setItem("cc_hidden_projects", JSON.stringify(["/proj-a"]));
    const listEl = mountSidebar();

    renderSidebar(listEl);
    vi.runAllTimers();

    expect(listEl.querySelector('li[data-session-id="visible-1"]')).not.toBeNull();
  });

  it("phone: renders no inline Hidden row", () => {
    remote = true;
    seedTwoProjectsOneHidden();
    const listEl = mountSidebar();

    renderSidebar(listEl);
    vi.runAllTimers();

    expect(listEl.querySelector("li.session-group-hidden-toggle")).toBeNull();
    // The hidden session itself must not leak into the visible list either.
    expect(listEl.querySelector('li[data-session-id="hidden-1"]')).toBeNull();
  });
});
