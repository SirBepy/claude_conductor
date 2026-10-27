// Shared setup for the Projects tab card tests: the ipc, transport, modal and
// new-chat-config mocks plus a `mount` that puts the dashboard and its chip row
// under one wrapper. The mocks are registered here, not in each test file, so
// this module has to be imported before anything that pulls in the dashboard;
// it hands back the mocked modules so a test file never imports them itself
// ahead of the mocks.

import { vi, expect } from "vitest";
import { history, projectSnapshot } from "./project-dashboard-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

// What the mocked ipc answers with. A test reassigns a field; `resetDashboard`
// restores the defaults before each test.
export const dash = { snapshot: projectSnapshot(), historyResult: history() };

vi.mock("../../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "dashboard_snapshot") return dash.snapshot;
    if (cmd === "dashboard_history") return dash.historyResult;
    if (cmd === "dashboard_gallery_image") return "data:image/png;base64,AAAA";
    return null;
  }),
}));
vi.mock("../../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => false, getTransport: () => ({ listen: async () => () => {} }) };
});
vi.mock("../../src/views/sessions/active-session.ts", () => ({ dismountActivePane: vi.fn(), selectSession: vi.fn(async () => {}) }));
vi.mock("../../src/views/sessions/new-chat-config.ts", () => ({
  resolveNewChatConfig: vi.fn(),
  accountPickNeeded: vi.fn(async () => false),
}));
// The real host morphs between cards on timers; the tests only need the card in a slot.
vi.mock("../../src/shared/modal.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    modalCardSlot: () => document.getElementById("test-modal-slot"),
    presentHostCard: vi.fn(async (fn) => fn()),
    closeHostCard: vi.fn(() => { document.getElementById("test-modal-slot").replaceChildren(); }),
    setBackdropCancel: vi.fn(),
  };
});

const { mountDashboard } = await import("../../src/views/sessions/project-dashboard/dashboard.ts");
export const { state } = await import("../../src/views/sessions/state.ts");
export const { resolveNewChatConfig, accountPickNeeded } = await import("../../src/views/sessions/new-chat-config.ts");
export const { invoke } = await import("../../src/shared/ipc.ts");

export async function mount(ref) {
  const h = mountDashboard(ref, { mode: "page", pane: document.body, leave: vi.fn(), back: vi.fn(), deselect: vi.fn() });
  // The page puts the chip row under the dashboard; one wrapper lets a test query both.
  const wrap = document.createElement("div");
  wrap.append(h.root, h.chips);
  document.body.appendChild(wrap);
  await vi.waitFor(() => expect(h.root.querySelector(".pd-head")).not.toBeNull());
  return wrap;
}

export function resetDashboard() {
  document.body.innerHTML = '<div id="test-modal-slot"></div>';
  dash.snapshot = projectSnapshot();
  dash.historyResult = history();
  vi.clearAllMocks();
}
