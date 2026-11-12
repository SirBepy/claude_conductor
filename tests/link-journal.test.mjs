import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The phone's own record of what its connection did, uploaded to the PC so a
// "keeps disconnecting" report can be read from the PC's log (the daemon only
// ever sees connections that succeeded). Contract K4 (report_link_journal) and
// K5 (GET /__tunnel/journal on the Android shell).

const h = vi.hoisted(() => ({ remote: true, call: vi.fn() }));
vi.mock("../src/shared/transport.ts", () => ({
  isRemote: () => h.remote,
  getTransport: () => ({ call: (...a) => h.call(...a) }),
}));

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const fetchMock = vi.fn();
let store;

function makeLocalStorage() {
  store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function makeWindow(extra = {}) {
  return Object.assign(new EventTarget(), extra);
}

async function fresh() {
  vi.resetModules();
  return await import("../src/shared/link-journal.ts");
}

function jsonAnswer(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.remote = true;
  h.call.mockReset();
  h.call.mockResolvedValue({ ok: true });
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  globalThis.localStorage = makeLocalStorage();
  globalThis.window = makeWindow();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.location = { hostname: "127.0.0.1", port: "27300" };
});

afterEach(() => {
  vi.useRealTimers();
});

const linesOf = (callIndex) => h.call.mock.calls[callIndex][1].lines;

describe("the page ring", () => {
  it("keeps the newest 200 events", async () => {
    const j = await fresh();
    for (let i = 0; i < 250; i++) j.note("k", `n${i}`);
    const ev = j.journalEvents();
    expect(ev).toHaveLength(200);
    expect(ev[0].d).toBe("n50");
    expect(ev.at(-1).d).toBe("n249");
  });

  it("is a no-op off the phone: nothing recorded, nothing stored, nothing sent", async () => {
    h.remote = false;
    const j = await fresh();
    j.note("visible");
    j.persistLinkJournalNow();
    await j.flush();
    expect(j.journalEvents()).toEqual([]);
    expect(store.size).toBe(0);
    expect(h.call).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(j.mountLinkJournal()).toBeTypeOf("function");
  });
});

describe("flush", () => {
  it("sends '<ISO time> <p|t> <kind> <detail>' lines, oldest first", async () => {
    const j = await fresh();
    j.note("visible");
    vi.setSystemTime(T0 + 1500);
    j.note("req_fail", "list_projects fetch");
    await j.flush();
    expect(h.call).toHaveBeenCalledWith("report_link_journal", { lines: expect.any(Array) });
    expect(linesOf(0)).toEqual([
      "2026-11-12T10:00:00.000Z p visible",
      "2026-11-12T10:00:01.500Z p req_fail list_projects fetch",
    ]);
  });

  it("cuts a line to 300 chars and sends at most 50 lines per call, the rest on the next flush", async () => {
    const j = await fresh();
    for (let i = 0; i < 120; i++) j.note("k", i === 0 ? "x".repeat(500) : `n${i}`);
    await j.flush();
    expect(linesOf(0)).toHaveLength(50);
    expect(linesOf(0)[0]).toHaveLength(300);
    expect(linesOf(0)[1]).toContain("n1");
    vi.advanceTimersByTime(6000);
    await j.flush();
    expect(linesOf(1)).toHaveLength(50);
    expect(linesOf(1)[0]).toContain("n50");
    vi.advanceTimersByTime(6000);
    await j.flush();
    expect(linesOf(2)).toHaveLength(20);
    vi.advanceTimersByTime(6000);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(3);
  });

  it("a second flush sends only what is new", async () => {
    const j = await fresh();
    j.note("visible");
    await j.flush();
    vi.advanceTimersByTime(7000);
    j.note("hidden");
    await j.flush();
    expect(linesOf(1)).toHaveLength(1);
    expect(linesOf(1)[0]).toContain(" hidden");
  });

  it("a failed call leaves everything pending", async () => {
    const j = await fresh();
    j.note("visible");
    h.call.mockRejectedValueOnce(new Error("link down"));
    await j.flush();
    vi.advanceTimersByTime(7000);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(linesOf(1)).toHaveLength(1);
    expect(linesOf(1)[0]).toContain(" visible");
  });

  it("a refused batch (kept 0) stays pending and the next flush resends it", async () => {
    const j = await fresh();
    j.note("visible");
    h.call.mockResolvedValueOnce({ ok: true, kept: 0 });
    await j.flush();
    vi.advanceTimersByTime(7000);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(linesOf(1)).toEqual(linesOf(0));
    vi.advanceTimersByTime(7000);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(2); // accepted the second time (no kept field)
  });

  it("an answer with kept above 0, or with no kept at all (an older PC), counts as accepted", async () => {
    for (const answer of [{ ok: true, kept: 3 }, { ok: true }, undefined, null]) {
      h.call.mockReset();
      h.call.mockResolvedValue(answer);
      const j = await fresh();
      j.note("visible");
      await j.flush();
      vi.advanceTimersByTime(7000);
      await j.flush();
      expect(h.call).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(7000);
    }
  });

  it("never calls more often than every 6s", async () => {
    const j = await fresh();
    j.note("visible");
    await j.flush();
    j.note("hidden");
    vi.advanceTimersByTime(5900);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when nothing is waiting", async () => {
    const j = await fresh();
    await j.flush();
    expect(h.call).not.toHaveBeenCalled();
  });
});

describe("tunnel journal (Android shell)", () => {
  it("is not asked for off the Android shell", async () => {
    const j = await fresh();
    j.note("visible");
    await j.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an HTML answer (an older app forwards the URL to the PC) is ignored and page events still upload", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      json: async () => { throw new Error("not json"); },
    });
    const j = await fresh();
    j.note("visible");
    await j.flush();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:27301/", expect.objectContaining({ cache: "no-store" }));
    expect(linesOf(0)).toHaveLength(1);
    expect(linesOf(0)[0]).toContain(" p visible");
  });

  it("reads the journal port (page port + 1), never the page's own origin, with no credentials or headers", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    fetchMock.mockResolvedValue(jsonAnswer({ v: 1, events: [] }));
    const j = await fresh();
    j.note("visible");
    await j.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:27301/");
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("skips the tunnel fetch when the page is not on 127.0.0.1 with a numeric port", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    for (const loc of [
      { hostname: "192.168.1.5", port: "27300" },
      { hostname: "localhost", port: "27300" },
      { hostname: "127.0.0.1", port: "" },
    ]) {
      globalThis.location = loc;
      const j = await fresh();
      j.note("visible");
      await j.flush();
      expect(linesOf(h.call.mock.calls.length - 1)).toHaveLength(1);
      vi.advanceTimersByTime(7000);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up on a stuck journal port after 3s and still uploads the page's events", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    fetchMock.mockImplementation(
      (_url, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    const j = await fresh();
    j.note("visible");
    const done = j.flush();
    await vi.advanceTimersByTimeAsync(3100);
    await done;
    expect(linesOf(0)).toHaveLength(1);
  });

  it("ignores a JSON body without v 1 and an events array", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    fetchMock.mockResolvedValue(jsonAnswer({ v: 2, events: [{ t: T0, k: "x", d: "" }] }));
    const j = await fresh();
    j.note("visible");
    await j.flush();
    expect(linesOf(0)).toHaveLength(1);
  });

  it("merges tunnel events by time with the page's and does not resend them", async () => {
    globalThis.window = makeWindow({ ConductorPush: {} });
    const j = await fresh();
    j.note("visible"); // T0
    vi.setSystemTime(T0 + 3000);
    j.note("hidden"); // T0 + 3s
    fetchMock.mockResolvedValue(
      jsonAnswer({
        v: 1,
        now_ms: T0 + 3000,
        events: [
          { t: T0 + 1000, k: "dial_fail", d: "timeout" },
          { t: T0 + 2000, k: "dial_ok", d: "" },
        ],
      }),
    );
    await j.flush();
    expect(linesOf(0)).toEqual([
      "2026-11-12T10:00:00.000Z p visible",
      "2026-11-12T10:00:01.000Z t dial_fail timeout",
      "2026-11-12T10:00:02.000Z t dial_ok",
      "2026-11-12T10:00:03.000Z p hidden",
    ]);
    vi.advanceTimersByTime(7000);
    await j.flush();
    expect(h.call).toHaveBeenCalledTimes(1);
  });
});

describe("localStorage mirror", () => {
  it("restores events after a reload, and an uploaded event is not resent", async () => {
    let j = await fresh();
    j.note("visible", "a");
    j.note("hidden", "b");
    await j.flush();
    j.note("online", "c");
    j.persistLinkJournalNow();
    expect(store.size).toBe(1);

    h.call.mockClear();
    vi.advanceTimersByTime(7000);
    j = await fresh();
    expect(j.journalEvents().map((e) => e.k)).toEqual(["visible", "hidden", "online"]);
    await j.flush();
    expect(linesOf(0)).toHaveLength(1);
    expect(linesOf(0)[0]).toContain(" online c");
  });

  it("writes at most once every 2s", async () => {
    const j = await fresh();
    const setItem = vi.spyOn(globalThis.localStorage, "setItem");
    j.note("visible");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) j.note("k", `${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setItem).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("tolerates corrupt JSON and a throwing storage", async () => {
    localStorage.setItem("conductor_link_journal", "{not json");
    let j = await fresh();
    expect(j.journalEvents()).toEqual([]);
    j.note("visible");
    expect(j.journalEvents()).toHaveLength(1);

    globalThis.localStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => {},
    };
    j = await fresh();
    j.note("visible");
    expect(() => j.persistLinkJournalNow()).not.toThrow();
  });
});

describe("mountLinkJournal", () => {
  it("records visibility and network changes and a boot event, and flushes on becoming visible", async () => {
    const j = await fresh();
    const stop = j.mountLinkJournal();
    expect(j.journalEvents()[0].k).toBe("boot");
    globalThis.document.visibilityState = "hidden";
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
    globalThis.window.dispatchEvent(new Event("offline"));
    globalThis.window.dispatchEvent(new Event("online"));
    globalThis.document.visibilityState = "visible";
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
    expect(j.journalEvents().map((e) => e.k)).toEqual(["boot", "hidden", "offline", "online", "visible"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.call).toHaveBeenCalledTimes(1);
    stop();
  });

  it("flushes 3s after the global stream opens", async () => {
    const j = await fresh();
    const stop = j.mountLinkJournal();
    await vi.advanceTimersByTimeAsync(7000); // past the boot-time rate window
    h.call.mockClear();
    j.note("gws_open");
    await vi.advanceTimersByTimeAsync(2900);
    expect(h.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.call).toHaveBeenCalledTimes(1);
    stop();
  });

  it("adds the socket's age to its close", async () => {
    const j = await fresh();
    j.note("gws_open");
    vi.setSystemTime(T0 + 12_000);
    j.note("gws_close");
    expect(j.journalEvents().at(-1).d).toBe("age=12s");
    j.note("cws_open", "abcd1234");
    vi.setSystemTime(T0 + 30_000);
    j.note("cws_stale", "abcd1234");
    expect(j.journalEvents().at(-1).d).toBe("abcd1234 age=18s");
  });

  it("flushes every 60s while visible, only if something waits, and stops on dispose", async () => {
    const j = await fresh();
    const stop = j.mountLinkJournal();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.call).toHaveBeenCalledTimes(1); // the boot event was waiting
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.call).toHaveBeenCalledTimes(1); // nothing new
    j.note("online");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.call).toHaveBeenCalledTimes(2);
    stop();
    j.note("online");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.call).toHaveBeenCalledTimes(2);
  });
});
