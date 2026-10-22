// @vitest-environment jsdom
//
// The Chats | Projects tab strip: which lists show, what happens to the open
// chat on the way in and out, and the one hook (state.onChatActivated) that
// flips the tab back when anything else selects a chat. active-session,
// pending-flow and the sidebar are stubbed so only this module's own wiring runs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupRow, groupSnapshot, history, projectRow, projectSnapshot } from "./helpers/projects-tab-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

const calls = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dashboard_list_targets") return [projectRow(), groupRow()];
    if (cmd === "dashboard_snapshot") return args.target.kind === "group" ? groupSnapshot() : projectSnapshot();
    if (cmd === "dashboard_history") return history();
    return null;
  }),
}));

let remote = false;
const listeners = new Map();
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isRemote: () => remote,
    getTransport: () => ({
      listen: async (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(cb);
        return () => listeners.get(name)?.delete(cb);
      },
    }),
  };
});

const { state, setActiveSession } = await import("../src/views/sessions/state.ts");
vi.mock("../src/views/sessions/active-session.ts", () => ({
  dismountActivePane: vi.fn(() => setActiveSession(null)),
  selectSession: vi.fn(async (id) => { setActiveSession(id); }),
}));
vi.mock("../src/views/sessions/pending-flow.ts", () => ({ resumeDraft: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: vi.fn() }));
vi.mock("../src/views/sessions/model-effort-modal.ts", () => ({ openModelEffortModal: vi.fn() }));

const { mountProjectsTab } = await import("../src/views/sessions/projects-tab/projects-tab.ts");
const active = await import("../src/views/sessions/active-session.ts");

function mountDom() {
  document.body.innerHTML = `<div class="view-sessions"><aside class="sessions-sidebar">
    <div id="project-rail" hidden></div><ul id="sessions-list" class="sessions-list"></ul>
    <button class="sessions-fab"></button></aside>
    <main id="session-pane" class="session-pane"><div class="chat-stub">open chat</div></main></div>`;
  return {
    view: document.querySelector(".view-sessions"),
    aside: document.querySelector(".sessions-sidebar"),
    pane: document.getElementById("session-pane"),
    listEl: document.getElementById("sessions-list"),
  };
}

const clickTab = (name) => document.querySelector(`[data-pd-tab="${name}"]`).click();
const rows = () => [...document.querySelectorAll("#projects-list li.row-portrait")];

describe("Projects tab", () => {
  let dom;
  let tab;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    calls.length = 0;
    listeners.clear();
    remote = false;
    state.dashboardOpen = false;
    state.onChatActivated = null;
    state.selectedId = null;
    state.sessions = [{ session_id: "s1", cwd: "C:/Projects/conductor" }, { session_id: "s2", cwd: "C:/Projects/conductor" }];
    state.pendingNewSession = null;
    dom = mountDom();
    tab = mountProjectsTab(dom.view, dom.pane, dom.listEl);
  });

  it("mounts a strip with both tabs, starting on Chats with the chat list showing", () => {
    expect(dom.view.querySelectorAll(".pd-tab")).toHaveLength(2);
    expect(dom.view.querySelector('[data-pd-tab="chats"]').classList.contains("on")).toBe(true);
    expect(dom.aside.classList.contains("is-projects-tab")).toBe(false);
    expect(tab.tab()).toBe("chats");
  });

  it("is absent on the phone", () => {
    remote = true;
    const d = mountDom();
    expect(mountProjectsTab(d.view, d.pane, d.listEl)).toBeNull();
    expect(d.view.querySelector(".pd-tabs")).toBeNull();
  });

  it("Projects: swaps the lists, dismounts the open chat, and lists targets by recency", async () => {
    state.selectedId = "s1";
    clickTab("projects");

    expect(dom.aside.classList.contains("is-projects-tab")).toBe(true);
    expect(active.dismountActivePane).toHaveBeenCalledWith({ rerenderSidebar: false });
    expect(state.dashboardOpen).toBe(true);
    expect(state.selectedId).toBeNull();

    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0].querySelector(".session-row-title-text").textContent).toBe("claude_usage_in_taskbar");
    expect(rows()[0].querySelector(".proj-name").textContent).toBe("now \u00B7 2 running \u00B7 1 waiting on you");
    expect(rows()[0].querySelector(".avatar-status-dot.st-question")).not.toBeNull();
    expect(rows()[1].querySelector(".proj-name").textContent).toContain("4 repos");
    expect(rows()[1].querySelector(".ph-briefcase")).not.toBeNull();
    expect(rows()[1].querySelector(".avatar-status-dot.st-working")).not.toBeNull();
  });

  it("paints the first target's dashboard into the pane, never the .session-empty block", async () => {
    clickTab("projects");
    await vi.waitFor(() => expect(dom.pane.querySelector('.pd-root[data-pd-target="project:p1"] .pd-head h3')).not.toBeNull());
    expect(dom.pane.querySelector(".session-empty")).toBeNull();
    expect(rows()[0].classList.contains("active")).toBe(true);
  });

  it("selecting another row swaps the dashboard and moves the highlight", async () => {
    clickTab("projects");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    rows()[1].click();
    await vi.waitFor(() => expect(dom.pane.querySelector('.pd-root[data-pd-target="group:g1"] .pd-repos')).not.toBeNull());
    expect(rows()[1].classList.contains("active")).toBe(true);
    expect(rows()[0].classList.contains("active")).toBe(false);
  });

  it("Chats: restores the chat that was open before entering Projects", async () => {
    state.selectedId = "s1";
    clickTab("projects");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    clickTab("chats");

    expect(dom.aside.classList.contains("is-projects-tab")).toBe(false);
    expect(state.dashboardOpen).toBe(false);
    expect(active.selectSession).toHaveBeenCalledWith("s1", dom.pane);
    expect(dom.pane.querySelector(".pd-root")).toBeNull();
  });

  it("Chats with nothing open before: shows the normal empty state", () => {
    clickTab("projects");
    clickTab("chats");
    expect(active.selectSession).not.toHaveBeenCalled();
    expect(dom.pane.querySelector(".session-empty")).not.toBeNull();
  });

  it("flips back to Chats when something else selects a chat, without selecting twice", async () => {
    clickTab("projects");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    setActiveSession("s2"); // notification click, Ctrl+1..9 and new chat all end here

    expect(tab.tab()).toBe("chats");
    expect(dom.aside.classList.contains("is-projects-tab")).toBe(false);
    expect(state.dashboardOpen).toBe(false);
    expect(dom.view.querySelector('[data-pd-tab="chats"]').classList.contains("on")).toBe(true);
    expect(active.selectSession).not.toHaveBeenCalled();
  });

  it("refetches the list on an instances-changed event while the tab is open", async () => {
    clickTab("projects");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const before = calls.filter((c) => c.cmd === "dashboard_list_targets").length;
    for (const cb of listeners.get("instances-changed") ?? []) cb({});
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === "dashboard_list_targets").length).toBe(before + 1));
  });

  it("does not fetch the list while the Chats tab is showing", async () => {
    for (const cb of listeners.get("instances-changed") ?? []) cb({});
    await new Promise((r) => setTimeout(r, 500));
    expect(calls.filter((c) => c.cmd === "dashboard_list_targets")).toHaveLength(0);
  });
});

describe("chat restore stands down while the dashboard owns the pane", () => {
  it("loadLastSelectedSession returns null only while dashboardOpen", async () => {
    const { loadLastSelectedSession } = await import("../src/views/sessions/state.ts");
    state.dashboardOpen = false;
    setActiveSession("restore-me");
    expect(loadLastSelectedSession()).toBe("restore-me");
    state.dashboardOpen = true;
    expect(loadLastSelectedSession()).toBeNull();
    state.dashboardOpen = false;
  });
});
