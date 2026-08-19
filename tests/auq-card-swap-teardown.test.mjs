// @vitest-environment jsdom
// Regression (todo 680): a second card yanked the first's DOM without tearing
// it down, leaving its keydown/visibilitychange handlers live, so Escape
// cancelled the STALE prompt id and reached the agent as an unasked skip.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue([]);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const getSessionDrafts = vi.fn();
vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: (...a) => getSessionDrafts(...a),
  setAuqDraft: vi.fn().mockResolvedValue({ updated_at: "t" }),
  clearAuqDraft: vi.fn().mockResolvedValue({ cleared: true }),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { dismissQuestionCard, getActiveCardId } = await import("../src/views/sessions/permission-modal/question-state.ts");

function baseOpts(overrides = {}) {
  return {
    questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

function pressEscape() {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// Pairs every document.addEventListener with its removeEventListener so a
// leaked handler is observable as a survivor, not inferred from behaviour.
let liveDocListeners = [];
const origAdd = document.addEventListener;
const origRemove = document.removeEventListener;

beforeEach(() => {
  dismissQuestionCard();
  document.body.innerHTML = "";
  localStorage.clear();
  invokeMock.mockClear();
  getSessionDrafts.mockReset().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
  liveDocListeners = [];
  document.addEventListener = function (type, handler, opts) {
    liveDocListeners.push({ type, handler });
    return origAdd.call(this, type, handler, opts);
  };
  document.removeEventListener = function (type, handler, opts) {
    const i = liveDocListeners.findIndex((l) => l.type === type && l.handler === handler);
    if (i >= 0) liveDocListeners.splice(i, 1);
    return origRemove.call(this, type, handler, opts);
  };
  vi.useFakeTimers();
});

afterEach(() => {
  document.addEventListener = origAdd;
  document.removeEventListener = origRemove;
  vi.useRealTimers();
});

describe("a second question card tears the first one down", () => {
  it("leaves no document-level listener behind from the first card", () => {
    renderQuestionUI(baseOpts({ id: "p-old", sessionId: "s-old" }));
    const fromFirst = [...liveDocListeners];
    expect(fromFirst.length).toBeGreaterThan(0);

    renderQuestionUI(baseOpts({ id: "p-new", sessionId: "s-new" }));

    const leaked = fromFirst.filter((l) =>
      liveDocListeners.some((x) => x.type === l.type && x.handler === l.handler)
    );
    expect(leaked.map((l) => l.type)).toEqual([]);
    expect(getActiveCardId()).toBe("p-new");
  });

  it("Escape after the swap cancels only the live prompt, never the stale one", () => {
    const stale = baseOpts({ id: "p-old", sessionId: "s-old" });
    renderQuestionUI(stale);
    const live = baseOpts({ id: "p-new", sessionId: "s-new" });
    renderQuestionUI(live);

    pressEscape();

    expect(stale.onCancel).not.toHaveBeenCalled();
    expect(live.onCancel).toHaveBeenCalledTimes(1);
  });

  it("neither the live poll nor a visibility change reaches the stale card's session", async () => {
    renderQuestionUI(baseOpts({ id: "p-old", sessionId: "s-old" }));
    renderQuestionUI(baseOpts({ id: "p-new", sessionId: "s-new" }));
    getSessionDrafts.mockClear();

    document.dispatchEvent(new window.Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3000);

    const polled = getSessionDrafts.mock.calls.map(([sid]) => sid);
    expect(polled).toContain("s-new");
    expect(polled).not.toContain("s-old");
  });

  it("survives repeated swaps and a late resolve for an already-swapped prompt", () => {
    const first = baseOpts({ id: "p1", sessionId: "s1" });
    renderQuestionUI(first);
    const fromFirst = [...liveDocListeners];
    renderQuestionUI(baseOpts({ id: "p2", sessionId: "s2" }));
    const live = baseOpts({ id: "p3", sessionId: "s3" });
    renderQuestionUI(live);

    // The daemon's prompt-resolved poll can still fire for a swapped-away id.
    dismissQuestionCard("p1");

    expect(getActiveCardId()).toBe("p3");
    expect(document.querySelectorAll("#prompt-card-host").length).toBe(1);
    expect(fromFirst.filter((l) => liveDocListeners.includes(l))).toEqual([]);

    pressEscape();
    expect(first.onCancel).not.toHaveBeenCalled();
    expect(live.onCancel).toHaveBeenCalledTimes(1);
  });
});
