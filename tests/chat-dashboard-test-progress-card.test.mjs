// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/test-progress-card.ts
//
// The Test progress card's DOM contract (pc-1684): it patches in place, so a tick of the
// numbers changes text and a bar's scale and never rebuilds a node (nothing replays an
// enter animation), a failing test's name is its own row, another chat's event is ignored,
// and a dismissed run stays dismissed until the runner reports again.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: async () => () => {} }) }));

const { TestProgressCard } = await import("../src/views/sessions/chat-dashboard/test-progress-card.ts");
const { deriveTestProgress } = await import("../src/shared/chat/dashboard/test-progress-model.ts");

const run = (over = {}) => ({
  runner: "vitest", passed: 10, failed: 0, total: 100, failing: [], failing_more: 0, state: "running", at_ms: 1, ...over,
});

let host;
let card;
let schedule;

function draw() {
  const state = deriveTestProgress(card.sideData(), true, Date.now());
  if (state) card.update(host, state);
}
const tick = (runs, sid = "chat") => {
  card.adopt({ session_id: sid, runs });
  draw();
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  schedule = vi.fn();
  card = new TestProgressCard({ sessionId: () => "chat", schedule });
});
afterEach(() => {
  card.dispose();
  vi.useRealTimers();
});

describe("TestProgressCard", () => {
  it("draws a row per runner with the counts and the bar's fill", () => {
    tick([run({ passed: 40, failed: 10 }), run({ runner: "cargo test", total: 0 })]);
    const rows = [...host.querySelectorAll(".tp-run")];
    expect(rows.map((r) => r.dataset.tp)).toEqual(["vitest", "cargo test"]);
    expect(rows[0].querySelector(".tp-chip").textContent).toBe("Running");
    expect(rows[0].querySelector(".tp-pass").textContent).toBe("40 passed");
    expect(rows[0].querySelector(".tp-fail-in").textContent).toBe("10 failed");
    expect(rows[0].querySelector(".tp-ok").style.getPropertyValue("--f")).toBe("0.4");
    expect(rows[0].querySelector(".tp-bad").style.getPropertyValue("--f")).toBe("0.5");
    expect(rows[1].classList.contains("is-indet")).toBe(true);
  });

  it("patches a tick in place: the same nodes, new text, new scale", () => {
    tick([run({ passed: 10, failing: ["a > b"] })]);
    const row = host.querySelector(".tp-run");
    const ok = row.querySelector(".tp-ok");
    const name = row.querySelector(".tp-f");
    tick([run({ passed: 55, failing: ["a > b"] })]);
    expect(host.querySelector(".tp-run")).toBe(row);
    expect(row.querySelector(".tp-ok")).toBe(ok);
    expect(row.querySelector(".tp-f")).toBe(name);
    expect(row.querySelector(".tp-pass").textContent).toBe("55 passed");
    expect(ok.style.getPropertyValue("--f")).toBe("0.55");
    expect(name.classList.contains("is-new")).toBe(false);
  });

  it("lists each failing test by name and folds one away that the runner stops reporting", () => {
    tick([run({ failed: 2, failing: ["a > one", "a > two"], failing_more: 3 })]);
    expect([...host.querySelectorAll(".tp-f")].map((l) => l.dataset.name)).toEqual(["a > one", "a > two"]);
    expect(host.querySelector(".tp-more-t").textContent).toBe("+3 more");
    expect(host.querySelector(".tp-more").classList.contains("is-on")).toBe(true);
    tick([run({ failed: 1, failing: ["a > two"] })]);
    const one = [...host.querySelectorAll(".tp-f")].find((l) => l.dataset.name === "a > one");
    expect(one.classList.contains("is-leaving")).toBe(true);
    vi.advanceTimersByTime(500);
    expect([...host.querySelectorAll(".tp-f")].map((l) => l.dataset.name)).toEqual(["a > two"]);
    expect(host.querySelector(".tp-more").classList.contains("is-on")).toBe(false);
  });

  it("escapes a test name that carries markup", () => {
    tick([run({ failed: 1, failing: ["<img src=x onerror=alert(1)>"] })]);
    expect(host.querySelector(".tp-fn img")).toBeNull();
    expect(host.querySelector(".tp-fn").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("ignores another chat's event", () => {
    tick([run()], "someone-else");
    expect(card.sideData()).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("a run that is not reported again keeps the time it was last heard, so it can go stale", () => {
    tick([run({ at_ms: 1 })]);
    vi.advanceTimersByTime(20_000);
    // The other runner reports; the daemon resends vitest unchanged.
    tick([run({ at_ms: 1 }), run({ runner: "cargo test", at_ms: 2 })]);
    vi.advanceTimersByTime(11_000);
    draw();
    expect(host.querySelector('[data-tp="vitest"]').dataset.state).toBe("stale");
    expect(host.querySelector('[data-tp="cargo test"]').dataset.state).toBe("running");
  });

  it("asks for one redraw when the live run would turn stale", () => {
    tick([run()]);
    schedule.mockClear();
    vi.advanceTimersByTime(31_000);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("a finished run can be dismissed, folds away, and stays gone until the runner reports again", () => {
    tick([run({ state: "passed", passed: 100, at_ms: 7 })]);
    host.querySelector('[data-tp-act="dismiss"]').click();
    expect(host.querySelector(".tp-run").classList.contains("is-leaving")).toBe(true);
    schedule.mockClear();
    vi.advanceTimersByTime(500);
    expect(host.querySelector(".tp-run")).toBeNull();
    expect(schedule).toHaveBeenCalled();
    expect(card.sideData()).toBeUndefined();
    // The daemon resends the old report along with another runner's: it stays gone.
    tick([run({ state: "passed", at_ms: 7 }), run({ runner: "cargo test", at_ms: 8 })]);
    expect([...host.querySelectorAll(".tp-run")].map((r) => r.dataset.tp)).toEqual(["cargo test"]);
    // A newer report of the same runner is a new run.
    tick([run({ at_ms: 9 })]);
    expect(host.querySelector('[data-tp="vitest"]')).not.toBeNull();
  });

  it("a report that lands while a dismissed row folds away is a new run and is kept", () => {
    tick([run({ state: "passed", passed: 100, at_ms: 7 })]);
    host.querySelector('[data-tp-act="dismiss"]').click();
    tick([run({ state: "running", passed: 3, at_ms: 8 })]);
    vi.advanceTimersByTime(500);
    expect(card.sideData()?.runs.map((r) => r.atMs)).toEqual([8]);
    draw();
    expect(host.querySelector('[data-tp="vitest"]')).not.toBeNull();
  });

  it("dispose cancels the pending fold fallbacks", () => {
    tick([run({ state: "passed", at_ms: 7 })]);
    host.querySelector('[data-tp-act="dismiss"]').click();
    schedule.mockClear();
    card.dispose();
    vi.advanceTimersByTime(500);
    expect(schedule).not.toHaveBeenCalled();
  });
});
