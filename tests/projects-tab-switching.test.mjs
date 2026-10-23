// @vitest-environment jsdom
//
// The Chats | Projects tab strip: which lists show, what happens to the open
// chat on the way in and out, and the one hook (state.onChatActivated) that
// flips the tab back when anything else selects a chat. active-session,
// pending-flow and the sidebar are stubbed so only this module's own wiring runs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { closedRow, groupRow, groupSnapshot, history, projectRow, projectSnapshot } from "./helpers/projects-tab-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

const calls = [];
// The daemon owns which rows are open; the fake keeps that state so a close/open round-trips through the next list load.
let listRows = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dashboard_list_targets") return structuredClone(listRows);
    if (cmd === "dashboard_close_target" || cmd === "dashboard_open_target") {
      const row = listRows.find((r) => r.target.id === args.target.id);
      if (row) row.open = cmd === "dashboard_open_target";
      return null;
    }
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

// The real host morphs between cards on timers; the picker only needs its card in a slot.
vi.mock("../src/shared/modal.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    modalCardSlot: () => document.getElementById("test-modal-slot"),
    presentHostCard: vi.fn(async (fn) => fn()),
    closeHostCard: vi.fn(() => { document.getElementById("test-modal-slot").replaceChildren(); }),
    setBackdropCancel: vi.fn(),
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
    <main id="session-pane" class="session-pane"><div class="chat-stub">open chat</div></main></div>
    <div id="test-modal-slot"></div>`;
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
    listRows = [projectRow(), groupRow(), closedRow()];
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

  describe("on the phone", () => {
    let d;
    beforeEach(() => {
      tab.destroy();
      remote = true;
      d = mountDom();
      d.view.setAttribute("data-mobile-pane", "list");
      tab = mountProjectsTab(d.view, d.pane, d.listEl);
    });

    it("has the strip, and a project list with + but no hover-only close button", async () => {
      expect(d.view.querySelectorAll(".pd-tab")).toHaveLength(2);
      clickTab("projects");
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      expect(document.querySelector("#projects-list .pd-row-x")).toBeNull();
      expect(document.querySelector("#projects-list .pd-list-add")).not.toBeNull();
    });

    it("tapping a project slides its dashboard in, and the header has no PC-only kebab", async () => {
      clickTab("projects");
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      // Listing paints the first dashboard behind the list without leaving it.
      expect(d.view.getAttribute("data-mobile-pane")).toBe("list");
      rows()[1].click();
      expect(d.view.getAttribute("data-mobile-pane")).toBe("chat");
      await vi.waitFor(() => expect(d.pane.querySelector('.pd-root[data-pd-target="group:g1"] .pd-head')).not.toBeNull());
      expect(d.pane.querySelector('.pd-head [title="More"]')).toBeNull();
      // New chat stays reachable on the phone: it leads the chip row.
      expect(d.pane.querySelector("[data-pd-new-chat]")).not.toBeNull();
    });

    it("opening a closed project from + slides its dashboard in", async () => {
      clickTab("projects");
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      d.view.querySelector(".pd-list-add").click();
      document.querySelector("#test-modal-slot .pd-pick").click();
      await vi.waitFor(() => expect(d.view.getAttribute("data-mobile-pane")).toBe("chat"));
      await vi.waitFor(() => expect(d.pane.querySelector('.pd-root[data-pd-target="project:p9"]')).not.toBeNull());
    });

    it("going back to Chats leaves the list showing instead of sliding the old chat over it", async () => {
      state.selectedId = "s1";
      clickTab("projects");
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      clickTab("chats");
      expect(active.selectSession).not.toHaveBeenCalled();
      expect(d.view.getAttribute("data-mobile-pane")).toBe("list");
    });
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
    await vi.waitFor(() => expect(dom.pane.querySelector('.pd-root[data-pd-target="group:g1"] .pd-head')).not.toBeNull());
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

describe("open and closed projects", () => {
  let dom;
  const closeBtn = (i) => rows()[i].querySelector(".pd-row-x");
  const names = () => rows().map((r) => r.querySelector(".session-row-title-text").textContent);
  const closeCalls = () => calls.filter((c) => c.cmd === "dashboard_close_target").map((c) => c.args);

  beforeEach(async () => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    calls.length = 0;
    listRows = [projectRow(), groupRow(), closedRow("p9", "old_project"), closedRow("p8", "ancient_app")];
    listeners.clear();
    remote = false;
    state.dashboardOpen = false;
    state.onChatActivated = null;
    state.onCloseProject = null;
    state.selectedId = null;
    state.pendingNewSession = null;
    dom = mountDom();
    mountProjectsTab(dom.view, dom.pane, dom.listEl);
    clickTab("projects");
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("lists only open targets under an Open projects header with a + button", () => {
    expect(dom.view.querySelector("#projects-list .pd-list-head").textContent).toContain("Open projects");
    expect(dom.view.querySelector("#projects-list .pd-list-add")).not.toBeNull();
    expect(names()).toEqual(["claude_usage_in_taskbar", "Zirtue"]);
  });

  it("a row's x closes that project through dashboard_close_target and drops the row", async () => {
    closeBtn(1).click();
    await vi.waitFor(() => expect(names()).toEqual(["claude_usage_in_taskbar"]));
    expect(closeCalls()).toEqual([{ target: { kind: "group", id: "g1" } }]);
    expect(rows()[0].classList.contains("active")).toBe(true);
    expect(dom.pane.querySelector('.pd-root[data-pd-target="project:p1"]')).not.toBeNull();
  });

  it("closing the shown project moves to the next open one, and closing the last shows the empty pane", async () => {
    await vi.waitFor(() => expect(dom.pane.querySelector(".pd-root")).not.toBeNull());
    closeBtn(0).click();
    await vi.waitFor(() => expect(dom.pane.querySelector('.pd-root[data-pd-target="group:g1"] .pd-head')).not.toBeNull());
    expect(names()).toEqual(["Zirtue"]);

    closeBtn(0).click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(dom.pane.textContent).toContain("No open projects");
    expect(dom.view.querySelector("#projects-list .pd-list-empty").textContent).toBe("No open projects");
  });

  it("the Ctrl+W hook closes the selected project without a confirm, and is released on leaving the tab", async () => {
    expect(typeof state.onCloseProject).toBe("function");
    state.onCloseProject();
    await vi.waitFor(() => expect(names()).toEqual(["Zirtue"]));
    expect(closeCalls()).toEqual([{ target: { kind: "project", id: "p1" } }]);

    clickTab("chats");
    expect(state.onCloseProject).toBeNull();
  });

  it("+ lists the closed targets, filters them, and picking one opens it and shows its dashboard", async () => {
    dom.view.querySelector(".pd-list-add").click();
    const slot = document.getElementById("test-modal-slot");
    expect([...slot.querySelectorAll(".pd-pick .pd-mt")].map((n) => n.textContent)).toEqual(["old_project", "ancient_app"]);

    const search = slot.querySelector(".pd-pick-search");
    search.value = "anc";
    search.dispatchEvent(new Event("input"));
    expect([...slot.querySelectorAll(".pd-pick .pd-mt")].map((n) => n.textContent)).toEqual(["ancient_app"]);

    slot.querySelector(".pd-pick").click();
    await vi.waitFor(() => expect(names()).toContain("ancient_app"));
    expect(calls.find((c) => c.cmd === "dashboard_open_target").args).toEqual({ target: { kind: "project", id: "p8" } });
    expect(slot.querySelector(".pd-modal")).toBeNull();
    await vi.waitFor(() => expect(dom.pane.querySelector('.pd-root[data-pd-target="project:p8"]')).not.toBeNull());
    expect(rows().find((r) => r.textContent.includes("ancient_app")).classList.contains("active")).toBe(true);
  });

  it("the picker says so when every project is already open", async () => {
    listRows = [projectRow(), groupRow()];
    for (const cb of listeners.get("instances-changed") ?? []) cb({});
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === "dashboard_list_targets").length).toBeGreaterThan(1));
    dom.view.querySelector(".pd-list-add").click();
    expect(document.getElementById("test-modal-slot").textContent).toContain("Every project is already open");
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
