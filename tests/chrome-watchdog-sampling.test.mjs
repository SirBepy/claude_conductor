// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// startChromeWatchdog's sampling: which element it measures, when it stays
// silent, and that it logs on a state change only. jsdom has no layout, so each
// test stubs the rects the snapshot reads.

const diag = vi.fn();
let tick = () => {};

vi.mock("../src/shared/perf.ts", () => ({ reportWebviewDiag: (line) => diag(line) }));
vi.mock("../src/shared/visible-interval.ts", () => ({
  visibleInterval: (fn) => { tick = fn; return () => {}; },
}));
vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({ getSelectedSessionId: () => "s1" }));

const { startChromeWatchdog } = await import("../src/views/sessions/chrome-watchdog.ts");

function rect(bottom, height) {
  return () => ({ top: bottom - height, bottom, height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} });
}

/** A pane with a transcript row holding a decoy textarea, then the real composer. */
function mount({ cardMounted = false } = {}) {
  document.body.innerHTML = `
    <div class="view-sessions"><div id="session-pane">
      <div class="session-messages"><div class="step-note"><textarea class="composer-textarea" id="decoy"></textarea></div></div>
      <div class="session-composer"><textarea class="composer-textarea" id="real"></textarea></div>
      ${cardMounted ? '<div class="prompt-card"></div>' : ""}
    </div></div>`;
  const view = document.querySelector(".view-sessions");
  const pane = document.getElementById("session-pane");
  pane.getClientRects = () => [{}];
  document.getElementById("real").getBoundingClientRect = rect(780, 40);
  document.getElementById("decoy").getBoundingClientRect = rect(5000, 40);
  return { view, pane };
}

beforeEach(() => {
  diag.mockClear();
  tick = () => {};
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

describe("startChromeWatchdog", () => {
  it("stays silent for a healthy pane and measures the real composer, not a transcript textarea", () => {
    const { view, pane } = mount();
    startChromeWatchdog(view, pane);
    tick();
    expect(diag).not.toHaveBeenCalled();
  });

  it("logs once when the composer input collapses, not on every sample, then once on recovery", () => {
    const { view, pane } = mount();
    startChromeWatchdog(view, pane);
    document.getElementById("real").getBoundingClientRect = rect(780, 0);
    tick(); tick(); tick();
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatch(/^\[chrome\] BROKEN: composer hidden with no card \| session=s1/);
    document.getElementById("real").getBoundingClientRect = rect(780, 40);
    tick();
    expect(diag).toHaveBeenCalledTimes(2);
    expect(diag.mock.calls[1][0]).toBe("[chrome] pane chrome recovered");
  });

  it("lets a mounted question card hide the composer", () => {
    const { view, pane } = mount({ cardMounted: true });
    document.getElementById("real").getBoundingClientRect = rect(780, 0);
    startChromeWatchdog(view, pane);
    tick();
    expect(diag).not.toHaveBeenCalled();
  });

  it("stays silent for a pane parked with visibility:hidden (the phone's list mode)", () => {
    const { view, pane } = mount();
    pane.style.visibility = "hidden";
    document.getElementById("real").getBoundingClientRect = rect(780, 0);
    startChromeWatchdog(view, pane);
    tick();
    expect(diag).not.toHaveBeenCalled();
  });

  it("logs a parent that has scrolled", () => {
    const { view, pane } = mount();
    view.scrollTop = 148;
    startChromeWatchdog(view, pane);
    tick();
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatch(/BROKEN: ancestor scrolled .*top=148/);
  });
});
