// @vitest-environment jsdom
//
// The "% of 5h" chip a row shows while sorting by token drain describes a share
// of the account's 5h window. A plan with no 5h limit (`five_hour_limited:
// false`) has no such window, so its chats draw no chip; every other row keeps
// it, including a row whose account has not reported a usage record.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const snap = (limited) => ({
  captured_at: "2026-11-07T10:00:00Z",
  five_hour: { utilization: limited ? 30 : 0, resets_at: limited ? "2026-11-07T14:00:00Z" : null },
  five_hour_limited: limited,
  seven_day: { utilization: 20, resets_at: "2026-11-12T10:00:00Z" },
});

let usageMap = {};
let settings = {};
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "chat_drains") {
      return { chats: Object.fromEntries(["s1", "s2", "s3", "s4"].map((id) => [id, { sessionId: id, fiveHourPct: 12.4 }])) };
    }
    if (cmd === "get_usage_map") return usageMap;
    return {};
  }),
}));
vi.mock("../src/shared/state.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getSettings: () => settings };
});

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makeList() {
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

function instance(id, accountId) {
  return {
    session_id: id, pid: 0, cwd: "C:/proj", project_id: "p", kind: "interactive",
    is_remote: false, started_at: "2026-11-07T00:00:00Z", transcript_path: null,
    name: `chat ${id}`, ended_at: null, end_reason: null, busy: false, model: "",
    effort: "", awaiting: null, machine: null, account_id: accountId,
  };
}

const chipText = (ul, id) =>
  ul.querySelector(`li[data-session-id="${id}"] .session-row-drain`)?.textContent ?? null;

async function settle(ul) {
  // The drain fetch and the usage-map read both resolve on microtasks, then the
  // refresher re-renders; a few macrotask turns cover the whole chain.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return ul;
}

describe("sidebar token-drain chip on a plan without a 5h window", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.setItem("cc_session_sort", "drain");
    usageMap = { limited: snap(true), unlimited: snap(false) };
    settings = { default_account_id: "unlimited" };
    state.sessions = [
      instance("s1", "unlimited"),
      instance("s2", "limited"),
      instance("s3", null),
      instance("s4", "never-polled"),
    ];
  });

  it("hides the chip for an account with no 5h window, keeps it for the rest", async () => {
    const ul = makeList();
    renderSidebar(ul);
    await settle(ul);

    expect(chipText(ul, "s1")).toBeNull();
    expect(chipText(ul, "s2")).toBe("12% of 5h");
    expect(chipText(ul, "s4")).toBe("12% of 5h");
  });

  it("a chat with no account follows the default account", async () => {
    const ul = makeList();
    renderSidebar(ul);
    await settle(ul);
    expect(chipText(ul, "s3")).toBeNull();
  });
});
