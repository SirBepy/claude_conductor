// @vitest-environment jsdom

// The Android shell keeps its process alive in the background, so the phone's
// polls must slow down (prompt poll) or pause (global degrade poll) while the
// page is hidden. Every other client keeps today's cadence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../src/shared/transport.ts", () => ({
  isRemote: () => true,
  getTransport: () => ({
    call: (method) => {
      calls.push(method);
      return Promise.resolve([]);
    },
  }),
}));

const { startRemotePromptPoll } = await import("../src/views/sessions/permission-modal/index.ts");
const { HttpTransport, REMOTE_TOKEN_KEY } = await import("../src/shared/http-transport.ts");
const { teardownGlobalStream } = await import("../src/shared/global-stream.ts");

let visibility = "visible";
let added;
const realAdd = document.addEventListener.bind(document);

function setVisibility(v) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}
function promptPolls() {
  return calls.filter((m) => m === "list_pending_prompts").length;
}

beforeEach(() => {
  calls.length = 0;
  visibility = "visible";
  added = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.addEventListener = (t, fn, o) => { added.push([t, fn]); realAdd(t, fn, o); };
  vi.useFakeTimers();
});

afterEach(() => {
  for (const [t, fn] of added) document.removeEventListener(t, fn);
  document.addEventListener = realAdd;
  delete window.ConductorPush;
  vi.useRealTimers();
});

describe("prompt poll while hidden", () => {
  it("on the Android shell polls every 5s, not every 700ms", async () => {
    window.ConductorPush = {};
    setVisibility("hidden");
    startRemotePromptPoll();
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(promptPolls()).toBe(2);
  });

  it("on the Android shell polls at once on becoming visible and returns to 700ms", async () => {
    window.ConductorPush = {};
    setVisibility("hidden");
    startRemotePromptPoll();
    await vi.advanceTimersByTimeAsync(2_000);
    calls.length = 0;
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(promptPolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(promptPolls()).toBe(1 + 3);
  });

  it("without the Android shell the hidden cadence stays 700ms", async () => {
    setVisibility("hidden");
    startRemotePromptPoll();
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(promptPolls()).toBe(10);
  });
});

describe("global degrade poll while hidden", () => {
  let sockets;
  class MockWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.close = vi.fn();
      this.send = vi.fn();
      sockets.push(this);
    }
  }
  const instancePolls = () => calls.filter((m) => m === "list_instances").length;

  // A dropped global socket starts the degrade poll; the resulting list_instances
  // reads run through a stubbed transport so only the cadence is measured.
  async function dropSocket() {
    sockets = [];
    globalThis.WebSocket = MockWebSocket;
    globalThis.localStorage.setItem(REMOTE_TOKEN_KEY, "tok");
    const t = new HttpTransport();
    t.call = (m) => { calls.push(m); return Promise.resolve([]); };
    const un = await t.listen("instances-changed", () => {});
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    sockets[0].onclose();
    return un;
  }

  afterEach(() => {
    teardownGlobalStream();
  });

  it("on the Android shell does not run while hidden", async () => {
    window.ConductorPush = {};
    setVisibility("hidden");
    const un = await dropSocket();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(instancePolls()).toBe(0);
    un();
  });

  it("on the Android shell resumes when visible", async () => {
    window.ConductorPush = {};
    setVisibility("hidden");
    const un = await dropSocket();
    await vi.advanceTimersByTimeAsync(20_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(instancePolls()).toBeGreaterThanOrEqual(1);
    un();
  });

  it("without the Android shell keeps polling while hidden", async () => {
    setVisibility("hidden");
    const un = await dropSocket();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(instancePolls()).toBeGreaterThanOrEqual(2);
    un();
  });
});
