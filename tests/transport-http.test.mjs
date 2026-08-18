import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// HttpTransport is the browser/phone transport: it maps frontend command names
// onto the daemon's remote-access REST/WS server (see src/shared/http-transport.ts,
// selected by src/shared/transport.ts). Node env has no DOM globals, so we stub
// the few it touches.

const { getTransport, resetTransportForTests } = await import(
  "../src/shared/transport.ts"
);
const { HttpTransport, RemoteUnavailableError, REMOTE_TOKEN_KEY } = await import(
  "../src/shared/http-transport.ts"
);

let lastWs;
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.close = vi.fn();
    lastWs = this;
  }
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  lastWs = undefined;
  globalThis.fetch = fetchMock;
  globalThis.WebSocket = MockWebSocket;
  globalThis.localStorage = makeLocalStorage();
  globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
  globalThis.window = {};
  globalThis.localStorage.setItem(REMOTE_TOKEN_KEY, "tok123");
  resetTransportForTests();
});

/** Parsed JSON body of the Nth fetch call. */
function body(n = 0) {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}
function url(n = 0) {
  return fetchMock.mock.calls[n][0];
}
function headers(n = 0) {
  return fetchMock.mock.calls[n][1].headers;
}

describe("getTransport selection", () => {
  it("returns HttpTransport when window.__TAURI__ is absent", () => {
    expect(getTransport()).toBeInstanceOf(HttpTransport);
  });

  it("returns the Tauri transport (delegates to core.invoke) when __TAURI__ exists", async () => {
    const invoke = vi.fn().mockResolvedValue("ok");
    globalThis.window = { __TAURI__: { core: { invoke } } };
    resetTransportForTests();
    const res = await getTransport().call("some_command", { a: 1 });
    expect(invoke).toHaveBeenCalledWith("some_command", { a: 1 });
    expect(res).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HttpTransport.call mapping", () => {
  it("forwards list_instances to /api/rpc with null params and the bearer token", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ session_id: "s" }] });
    const out = await new HttpTransport().call("list_instances");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "list_instances", params: null });
    expect(headers().Authorization).toBe("Bearer tok123");
    expect(out).toEqual([{ session_id: "s" }]);
  });

  it("reshapes respond_permission (deny) to request_id/allow", async () => {
    await new HttpTransport().call("respond_permission", {
      id: "req-1",
      behavior: "deny",
      message: "nope",
    });
    expect(body()).toEqual({
      method: "respond_permission",
      params: { request_id: "req-1", allow: false, message: "nope" },
    });
  });

  it("reshapes respond_permission (allow) carrying updatedInput", async () => {
    await new HttpTransport().call("respond_permission", {
      id: "req-2",
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(body().params).toEqual({
      request_id: "req-2",
      allow: true,
      updated_input: { command: "ls" },
    });
  });

  it("reshapes respond_question to request_id/answers", async () => {
    await new HttpTransport().call("respond_question", {
      id: "q-1",
      answers: { color: "blue" },
    });
    expect(body()).toEqual({
      method: "respond_question",
      params: { request_id: "q-1", answers: { color: "blue" }, skipped: false },
    });
  });

  it("threads a real Skip through to the skipped flag", async () => {
    await new HttpTransport().call("respond_question", {
      id: "q-1",
      answers: {},
      skipped: true,
    });
    expect(body()).toEqual({
      method: "respond_question",
      params: { request_id: "q-1", answers: {}, skipped: true },
    });
  });

  it("send_message joins text blocks (dropping images) and hits the dedicated endpoint", async () => {
    const out = await new HttpTransport().call("send_message", {
      sessionId: "sess-9",
      cwd: "/x",
      blocks: [
        { type: "text", text: "hello" },
        { type: "image", mime: "image/png", data: "..." },
        { type: "text", text: "world" },
      ],
    });
    expect(url()).toBe("/api/sessions/sess-9/send");
    expect(body()).toEqual({ text: "hello\nworld" });
    expect(out).toBe("sess-9");
  });

  it("cancel_turn maps sessionId -> session_id", async () => {
    await new HttpTransport().call("cancel_turn", { sessionId: "sess-3" });
    expect(body()).toEqual({ method: "cancel_turn", params: { session_id: "sess-3" } });
  });

  it("maps load_history_page to the rpc with reshaped (snake_case) params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ events: [], oldest_seq: 0, newest_seq: 0, has_more: false }),
    });
    await new HttpTransport().call("load_history_page", {
      sessionId: "sess-h",
      cwd: "/work",
      messageLimit: 20,
    });
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({
      method: "load_history_page",
      params: { session_id: "sess-h", cwd: "/work", before_seq: null, message_limit: 20 },
    });
  });

  it("throws RemoteUnavailableError for commands with no remote path", async () => {
    // poll_now is a CDP scrape that only the desktop app process can run.
    await expect(new HttpTransport().call("poll_now", {})).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
  });

  it("forwards get_settings to the rpc with a null param (settings served from the daemon)", async () => {
    await new HttpTransport().call("get_settings");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_settings", params: null });
  });

  it("forwards get_history to the rpc with a null limit (usage history from the daemon db)", async () => {
    await new HttpTransport().call("get_history");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_history", params: { limit: null } });
  });

  it("forwards get_token_history to the rpc", async () => {
    await new HttpTransport().call("get_token_history");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_token_history", params: null });
  });

  it("forwards get_active_sessions to the rpc", async () => {
    await new HttpTransport().call("get_active_sessions");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_active_sessions", params: null });
  });

  it("forwards list_previews to the rpc with a null param", async () => {
    await new HttpTransport().call("list_previews");
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "list_previews", params: null });
  });

  it("forwards get_preview with the snapshot id", async () => {
    await new HttpTransport().call("get_preview", { id: "prev-1" });
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_preview", params: { id: "prev-1" } });
  });

  it("throws on a non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(new HttpTransport().call("list_instances")).rejects.toThrow("403");
  });

  // Session-statusbar chips + location-picker scan (confirmed root cause of
  // the phone's forever-loading branch/commits/dirty/servers chips and the
  // "Open .claude" modal's raw exception string: these commands fell through
  // to the default branch and rejected with RemoteUnavailableError).
  it("forwards get_git_info to the rpc with cwd", async () => {
    await new HttpTransport().call("get_git_info", { cwd: "/repo" });
    expect(url()).toBe("/api/rpc");
    expect(body()).toEqual({ method: "get_git_info", params: { cwd: "/repo" } });
  });

  it("forwards get_git_dirty to the rpc with cwd", async () => {
    await new HttpTransport().call("get_git_dirty", { cwd: "/repo" });
    expect(body()).toEqual({ method: "get_git_dirty", params: { cwd: "/repo" } });
  });

  it("forwards get_commit_sync to the rpc with cwd", async () => {
    await new HttpTransport().call("get_commit_sync", { cwd: "/repo" });
    expect(body()).toEqual({ method: "get_commit_sync", params: { cwd: "/repo" } });
  });

  it("forwards list_project_servers to the rpc with cwd", async () => {
    await new HttpTransport().call("list_project_servers", { cwd: "/repo" });
    expect(body()).toEqual({ method: "list_project_servers", params: { cwd: "/repo" } });
  });

  it("reshapes list_claude_md_scopes worktreePath -> worktree_path", async () => {
    await new HttpTransport().call("list_claude_md_scopes", { worktreePath: "/repo/wt" });
    expect(body()).toEqual({ method: "list_claude_md_scopes", params: { worktree_path: "/repo/wt" } });
  });
});

describe("HttpTransport.listen", () => {
  it("opens an authed per-session WebSocket for chat:<id> and delivers parsed payloads", async () => {
    const received = [];
    const unlisten = await new HttpTransport().listen("chat:abc-123", (p) => received.push(p));
    expect(lastWs.url).toBe(
      "wss://pc.tail.ts.net/api/sessions/abc-123/stream?token=tok123",
    );
    lastWs.onmessage({ data: JSON.stringify({ type: "assistant_message" }) });
    lastWs.onmessage({ data: "not json" }); // ignored, no throw
    expect(received).toEqual([{ type: "assistant_message" }]);
    unlisten();
    expect(lastWs.close).toHaveBeenCalledTimes(1);
    unlisten(); // idempotent
    expect(lastWs.close).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no WebSocket) for unknown global channels", async () => {
    const unlisten = await new HttpTransport().listen("some-other-channel", () => {});
    expect(lastWs).toBeUndefined();
    expect(() => unlisten()).not.toThrow();
  });

  it("skips the WS for external/automated (read-only) sessions, opens it for interactive", async () => {
    const t = new HttpTransport();
    // A list_instances result teaches the transport which sessions can't stream
    // (external/automated aren't in the daemon's hosted registry -> /stream 404s).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { session_id: "live-1", kind: "interactive" },
        { session_id: "ext-1", kind: "external" },
        { session_id: "auto-1", kind: "automated" },
      ],
    });
    await t.call("list_instances");

    // External + automated: no WebSocket opened (would 404-loop forever).
    const u1 = await t.listen("chat:ext-1", () => {});
    expect(lastWs).toBeUndefined();
    const u2 = await t.listen("chat:auto-1", () => {});
    expect(lastWs).toBeUndefined();
    expect(() => { u1(); u2(); }).not.toThrow();

    // Interactive (daemon-hosted): WS opens as before.
    const u3 = await t.listen("chat:live-1", () => {});
    expect(lastWs).toBeDefined();
    expect(lastWs.url).toContain("/api/sessions/live-1/stream");
    u3();
  });

  it("opens the WS for a session never seen in a list (no false-skip / live regression)", async () => {
    const unlisten = await new HttpTransport().listen("chat:unseen-9", () => {});
    expect(lastWs).toBeDefined();
    expect(lastWs.url).toContain("/api/sessions/unseen-9/stream");
    unlisten();
  });
});

describe("HttpTransport.listen — instances-changed poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires cb immediately on subscribe with a list_instances fetch", async () => {
    const instances = [{ session_id: "s1" }];
    fetchMock.mockResolvedValue({ ok: true, json: async () => instances });

    const received = [];
    const unlisten = await new HttpTransport().listen("instances-changed", (p) => received.push(p));

    // Let the immediate poll's promise resolve (advance 0ms, drain microtasks).
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalled();
    expect(body()).toEqual({ method: "list_instances", params: null });
    // cb is called (payload is undefined — consumers ignore it and call refreshSessions).
    expect(received).toHaveLength(1);

    unlisten();
  });

  it("does not poll again while the global WS is still fresh", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    const received = [];
    const unlisten = await new HttpTransport().listen("instances-changed", () => received.push(1));

    // Flush the immediate call.
    await vi.advanceTimersByTimeAsync(0);
    const afterImmediate = received.length;
    expect(afterImmediate).toBe(1);

    // Advance short of the watchdog's staleness threshold (GLOBAL_STALE_MS,
    // checked every GLOBAL_WATCHDOG_INTERVAL_MS) — the degrade poll never
    // starts, so no further tick fires.
    await vi.advanceTimersByTimeAsync(9000);

    expect(received.length).toBe(afterImmediate);

    unlisten();
  });

  it("degrade-polls and invokes cb once the global WS goes stale", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    const received = [];
    const unlisten = await new HttpTransport().listen("instances-changed", () => received.push(1));

    // Flush the immediate call.
    await vi.advanceTimersByTimeAsync(0);
    const afterImmediate = received.length;
    expect(afterImmediate).toBe(1);

    // The mock WS never opens/frames, so the watchdog (ticking every 5s)
    // eventually finds the last-frame timestamp older than the 10s staleness
    // threshold, starts the degrade poll, and that poll's first 3.5s tick fires.
    await vi.advanceTimersByTimeAsync(19000);

    expect(received.length).toBeGreaterThan(afterImmediate);

    unlisten();
  });

  it("unlisten stops further polls", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    const received = [];
    const unlisten = await new HttpTransport().listen("instances-changed", () => received.push(1));

    // Flush immediate call.
    await vi.advanceTimersByTimeAsync(0);
    const countBeforeStop = received.length;

    unlisten();

    // Advance well past the interval — no more calls.
    await vi.advanceTimersByTimeAsync(10000);

    expect(received.length).toBe(countBeforeStop);
  });

  it("skips a tick when the previous fetch is still in flight (no overlap)", async () => {
    let resolveFirst;
    // First call hangs indefinitely.
    fetchMock.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; })
    );
    // Subsequent calls resolve normally.
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    const received = [];
    const unlisten = await new HttpTransport().listen("instances-changed", () => received.push(1));

    // Immediate poll is in-flight (not resolved yet); no microtask flush yet.
    // Advance past the interval — the interval tick should see inFlight=true and skip.
    await vi.advanceTimersByTimeAsync(3500);

    // Only the first (unresolved) fetch should have been called so far.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the first fetch — cb fires once.
    resolveFirst({ ok: true, json: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.length).toBe(1);

    unlisten();
  });
});
