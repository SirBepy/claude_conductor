// @vitest-environment jsdom
//
// An automated channel never restarts itself, so Restart / Show terminal /
// Phone link / Stop must be reachable from the dashboard's project menu (also
// when the channel is dead) and from a live channel's own chat menu.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
let projects = [];
let remote = false;
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === "list_projects" ? projects : cmd === "phone_link" ? "https://phone.example/x" : null;
  }),
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => remote }));

const { state } = await import("../src/views/sessions/state.ts");
const { channelFor, projectItems } = await import("../src/views/sessions/project-dashboard/dash-menu.ts");
const { buildAgentItems } = await import("../src/views/sessions/chat-menu-items.ts");

const LABELS = ["Restart channel", "Show terminal", "Phone link", "Stop channel"];
const proj = (automation) => ({ id: "p1", path: "C:/a", automation });
const host = (kind = "project", repos = [{ cwd: "C:/a", name: "a", project_id: "p1" }]) => ({
  ctx: () => ({ snap: { target: { kind, id: "t", name: "a", repos } }, mode: "page" }),
  reload: vi.fn(), deselect: vi.fn(),
});
const labelsOf = (items) => items.filter(Boolean).map((i) => i.label);
const menuLabels = async (h) => labelsOf(projectItems(h, document.createElement("div"), await channelFor(h)));

beforeEach(() => {
  calls.length = 0;
  projects = [];
  remote = false;
  state.sessions = [];
});

describe("project menu channel block", () => {
  it("is present when automation is enabled, even with no live channel session (no Phone link then)", async () => {
    projects = [proj({ enabled: true })];
    const labels = await menuLabels(host());
    expect(labels).toEqual(expect.arrayContaining(["Restart channel", "Show terminal", "Stop channel"]));
    expect(labels).not.toContain("Phone link");
  });

  it("adds Phone link when a live channel session has a bridge session", async () => {
    projects = [proj({ enabled: true })];
    state.sessions = [{ session_id: "s1", project_id: "p1", kind: "automated", bridge_session_id: "b1" }];
    const labels = await menuLabels(host());
    for (const l of LABELS) expect(labels).toContain(l);
  });

  it("is absent when automation is off or unset", async () => {
    projects = [proj({ enabled: false })];
    expect(await menuLabels(host())).not.toContain("Restart channel");
    projects = [proj(null)];
    expect(await menuLabels(host())).not.toContain("Restart channel");
  });

  it("is absent on the phone and on a group", async () => {
    projects = [proj({ enabled: true })];
    expect(await menuLabels(host("group"))).not.toContain("Restart channel");
    remote = true;
    expect(await menuLabels(host())).not.toContain("Restart channel");
  });

  it("Restart calls restart_channel with the project id; Stop is danger", async () => {
    projects = [proj({ enabled: true })];
    const items = projectItems(host(), document.createElement("div"), await channelFor(host()));
    items.find((i) => i?.label === "Restart channel").run();
    await vi.waitFor(() => expect(calls).toContainEqual(["restart_channel", { projectId: "p1" }]));
    expect(items.find((i) => i?.label === "Stop channel").danger).toBe(true);
  });
});

describe("chat menu channel items", () => {
  const ctx = (o = {}) => ({ kind: "live", sessionId: "s1", cwd: "C:/a", pid: 1, readOnly: true, ...o });
  const channelSession = { session_id: "s1", project_id: "p1", kind: "automated", bridge_session_id: "b1" };

  it("shows them for an automated session", () => {
    state.sessions = [channelSession];
    expect(labelsOf(buildAgentItems(ctx()))).toEqual(expect.arrayContaining(LABELS));
  });

  it("omits Phone link without a bridge session", () => {
    state.sessions = [{ ...channelSession, bridge_session_id: null }];
    const labels = labelsOf(buildAgentItems(ctx()));
    expect(labels).toContain("Restart channel");
    expect(labels).not.toContain("Phone link");
  });

  it("omits them for a normal chat, a mirrored one and on the phone", () => {
    state.sessions = [{ ...channelSession, kind: "interactive" }];
    expect(labelsOf(buildAgentItems(ctx({ readOnly: false })))).not.toContain("Restart channel");
    state.sessions = [channelSession];
    expect(labelsOf(buildAgentItems(ctx({ mirrored: true })))).not.toContain("Restart channel");
    remote = true;
    expect(labelsOf(buildAgentItems(ctx()))).not.toContain("Restart channel");
  });

  it("Restart calls restart_channel with the session's project id", async () => {
    state.sessions = [channelSession];
    buildAgentItems(ctx()).find((i) => i.label === "Restart channel").run();
    await vi.waitFor(() => expect(calls).toContainEqual(["restart_channel", { projectId: "p1" }]));
  });
});
