// Paginated-in (scroll-up) history must fold exactly like the initial load:
// tool rows group into the turn footer's chip strip and the meta row settles
// from the turn's combined usage. Before this, prependEvents built raw rows -
// every old chat showed flat Skill/Bash/... cards once you scrolled up.
//
// The initial window is cut mid-turn by the page size, so its LEADING rows
// (before the first user message) have no turn to group into. bulkLoadEvents
// now folds that leading partial turn at load instead of leaving raw cards on
// screen until the user scrolled up; scrolling up later just adds the meta row
// once the opening user message (and its usage) prepend in.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function toolResultEvent(id, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: ts };
}

function turnUsageEvent({ outputTokens = 0, durationMs = 0 } = {}) {
  return {
    type: "turn_usage",
    input_tokens: 100,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    duration_ms: durationMs,
    has_thinking: false,
    model: "m",
  };
}

// Unique session id per renderer: the event-store (sessionEvents) is a module
// singleton that caches loaded events by session id, so a shared id leaks one
// test's history into the next.
let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-fold-test-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("pagination folds prepended turns", () => {
  it("folds a complete prepended turn into one footer with settled meta", async () => {
    invokeRouter.queueOnce("load_history_page", {
      // Initial window: a clean later turn.
      events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      // Older page: one complete turn with tools + usage.
      events: [
        userEvent("old question", 1_000_000),
        assistantEvent("old answer", 1_005_000),
        toolUseEvent("Bash", { command: "ls" }, "t1", 1_010_000),
        toolResultEvent("t1", 1_011_000),
        turnUsageEvent({ outputTokens: 1200, durationMs: 0 }),
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    // The old turn's tool rows are folded, not flat.
    const flat = [...container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    expect(flat.length).toBe(0);
    const strips = container.querySelectorAll(".tool-strip");
    expect(strips.length).toBe(1);
    expect(container.querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();

    // Footer sits inside the old turn with a settled meta row (combined
    // tokens, duration from the timestamp span: 1_000_000 -> 1_011_000 = 11s).
    const footer = container.querySelector(".turn-footer");
    expect(footer).not.toBeNull();
    expect(footer.querySelector(".turn-chip--tokens").textContent).toContain("1.2k");
    expect(footer.querySelector(".turn-chip--time").textContent).toContain("11s");
  });

  it("folds the initial window's leading partial turn at load (no scroll needed)", async () => {
    invokeRouter.queueOnce("load_history_page", {
      // Initial window cut MID-turn: tool rows with no opening user message.
      events: [
        toolUseEvent("Bash", { command: "build" }, "t9", 1_020_000),
        toolResultEvent("t9", 1_021_000),
        assistantEvent("done building", 1_025_000),
        turnUsageEvent({ outputTokens: 700, durationMs: 0 }),
        userEvent("next question", 1_100_000),
        assistantEvent("next answer", 1_101_000),
      ],
      oldest_seq: 5,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      // Older page brings the opening user message of that cut turn.
      events: [userEvent("the original ask", 1_000_000)],
      oldest_seq: 0,
      newest_seq: 4,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();

    // The leading rows fold at INITIAL load - no scroll-up required. This is
    // the bug fix: previously they stayed flat until pagination healed them.
    let flat = [...container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    expect(flat.length).toBe(0);
    expect(container.querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();

    // Scrolling up brings the opening user message; the turn stays folded.
    await renderer.fetchOlder();

    flat = [...container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    expect(flat.length).toBe(0);
    expect(container.querySelector('.tool-chip[data-tool="Bash"]')).not.toBeNull();
  });

  it("holds the transcript hidden during build, then re-pins and reveals after settle", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("q", 1_000_000), assistantEvent("plain answer", 1_001_000)],
      oldest_seq: 0,
      newest_seq: 2,
      has_more: false,
    });

    // jsdom has no layout: fake the scroll metrics. scrollTop is a real slot so
    // we can observe the renderer writing to it.
    const container = document.createElement("div");
    document.body.appendChild(container);
    let _top = 0;
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, get: () => 0 });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => _top,
      set: (v) => { _top = v; },
    });

    const renderer = new ChatRenderer(container);
    await renderer.attach(`sess-settle-${++_sessSeq}`);
    await renderer.loadFromStore();

    // The synchronous load pinned to the bottom, but the transcript is held
    // hidden so its ugly build (top-down paint, fold, snap) is never seen.
    expect(container.scrollTop).toBe(1000);
    expect(container.style.opacity).toBe("0");
    // Held slightly below resting so the reveal settles UP into place.
    expect(container.style.transform).toBe("translateY(8px)");

    // Async content (shiki highlight, image hydration) grows the height AFTER
    // that scroll, pushing the bottom out of view - simulate by resetting.
    container.scrollTop = 0;

    // The settle pass re-pins once that work flushes (highlight await + a
    // macrotask), then fades + slides the finished frame in. Without it the
    // newest turn's chips stay cut off and the transcript stays hidden.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container.scrollTop).toBe(1000);
    expect(container.style.opacity).toBe("1");
    expect(container.style.transform).toBe("translateY(0)");
  });

  it("carries usage across batches for a turn that straddles them", async () => {
    invokeRouter.queueOnce("load_history_page", {
      // Initial window: only the NEXT turn's user message onward.
      events: [userEvent("newest question", 2_000_000), assistantEvent("newest answer", 2_001_000)],
      oldest_seq: 20,
      newest_seq: 22,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      // Batch A (newer half of the old turn): its trailing usage, NO boundary.
      events: [
        toolUseEvent("Read", { file_path: "/x.ts" }, "r1", 1_050_000),
        toolResultEvent("r1", 1_051_000),
        turnUsageEvent({ outputTokens: 2000, durationMs: 0 }),
      ],
      oldest_seq: 10,
      newest_seq: 19,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      // Batch B (older half): the opening user message.
      events: [userEvent("the straddled ask", 1_000_000), assistantEvent("starting...", 1_001_000)],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();
    await renderer.fetchOlder();

    // The straddling turn folded with the usage carried from batch A.
    const flat = [...container.querySelectorAll(".tool-row")].filter((el) => el.dataset.toolGrouped !== "1");
    expect(flat.length).toBe(0);
    const footers = [...container.querySelectorAll(".turn-footer")];
    const withMeta = footers.find((f) => f.querySelector(".turn-chip--tokens"));
    expect(withMeta).not.toBeUndefined();
    expect(withMeta.querySelector(".turn-chip--tokens").textContent).toContain("2.0k");
  });
});
