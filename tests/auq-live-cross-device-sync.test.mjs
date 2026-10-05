// @vitest-environment jsdom

// While a question card is open, piggyback get_session_drafts (no new
// transport) to adopt other clients' edits - typing on one device shows up
// on the others, including activeTab. Hard rule: the field the user is
// focused in is never overwritten, and no remote update steals focus.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { getSessionDrafts, setAuqDraft } = vi.hoisted(() => ({ getSessionDrafts: vi.fn(), setAuqDraft: vi.fn() }));
vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  getSessionDrafts: (...a) => getSessionDrafts(...a),
  setAuqDraft: (...a) => setAuqDraft(...a),
  clearAuqDraft: vi.fn().mockResolvedValue({ cleared: true }),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { saveQuestionDraft } = await import("../src/views/sessions/permission-modal/draft-persistence.ts");
const { snapshotActiveCardDraft, setActiveCard } = await import("../src/views/sessions/permission-modal/question-state.ts");
const { scheduleAuqPush, resetAuqSyncForTests } = await import("../src/views/sessions/permission-modal/auq-draft-sync.ts");

const QUESTIONS = [
  { question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
  { question: "Editor?", options: [{ label: "Vim" }, { label: "Emacs" }] },
];

function remoteDrafts({ freeText = [], selections = [], activeTab = 0, additionalMessage = "", updatedAt }) {
  return {
    composer: null,
    auq: { prompt_id: "p1", payload: { freeText, selections, activeTab, additionalMessage }, updated_at: updatedAt },
    held: [], held_updated_at: null,
  };
}

function baseOpts(overrides = {}) {
  return {
    id: "p1",
    sessionId: "s1",
    questions: QUESTIONS,
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    supportsExtras: true,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  invokeMock.mockClear();
  getSessionDrafts.mockReset().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
  setAuqDraft.mockReset().mockResolvedValue({ updated_at: "t" });
  setActiveCard(null);
  resetAuqSyncForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("live poll: never overwrites the field the user is typing in", () => {
  it("leaves the focused textarea's own value untouched, but adopts a remote update to a different question", async () => {
    renderQuestionUI(baseOpts());
    const textarea = document.querySelector(".prompt-q__other-input");
    textarea.value = "typing this right now";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    getSessionDrafts.mockResolvedValue(remoteDrafts({
      freeText: [[0, "should never appear"]],
      selections: [[1, "Vim"]],
      activeTab: 0,
      updatedAt: "2026-08-14T00:00:05.000Z",
    }));

    await vi.advanceTimersByTimeAsync(1000);

    // Focused field untouched, and the DOM node itself was never rebuilt
    // (a render() would blur it and swap in a fresh element).
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("typing this right now");

    // The OTHER question's answer still adopted the remote update.
    const draft = snapshotActiveCardDraft("s1");
    expect(draft.selections.get(1)).toBe("Vim");
  });
});

describe("live poll: activeTab (Task 2) advances when nothing is focused", () => {
  it("moves the card to the remote's active question once idle", async () => {
    renderQuestionUI(baseOpts());
    document.body.focus();
    expect(document.querySelector('.prompt-panel[data-panel="0"]').classList.contains("is-active")).toBe(true);

    getSessionDrafts.mockResolvedValue(remoteDrafts({
      selections: [[0, "Tabs"]],
      activeTab: 1,
      updatedAt: "2026-08-14T00:00:05.000Z",
    }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(document.querySelector('.prompt-panel[data-panel="1"]').classList.contains("is-active")).toBe(true);
    expect(snapshotActiveCardDraft("s1").selections.get(0)).toBe("Tabs");
  });
});

describe("live poll never compares the daemon's clock against this device's", () => {
  // Regression: the poll used to pick newest-wins between the daemon's
  // updated_at (PC clock) and the local save stamp (phone clock). With the PC
  // clock ahead, the stale daemon copy won the race between a pick and its
  // debounced push landing, yanking the card back a step every time.
  function daemonWithClockAhead() {
    let stored = { freeText: [], selections: [], activeTab: 0, additionalMessage: "" };
    let n = 0;
    getSessionDrafts.mockImplementation(async () => ({
      composer: null,
      auq: { prompt_id: "p1", payload: stored, updated_at: `2099-01-01T00:00:0${n}.000Z` },
      held: [], held_updated_at: null,
    }));
    setAuqDraft.mockImplementation(async (_s, _p, payload) => {
      stored = payload;
      n++;
      return { updated_at: `2099-01-01T00:00:0${n}.000Z` };
    });
  }

  it("a pick whose push is still pending is not undone by the stale daemon copy", async () => {
    daemonWithClockAhead();
    renderQuestionUI(baseOpts({
      onDraftChange: (d) => { saveQuestionDraft("p1", d); scheduleAuqPush("s1", "p1", d); },
    }));
    await vi.advanceTimersByTimeAsync(900); // open-time push has landed

    const tabs = document.querySelector('.prompt-panel[data-panel="0"] input[data-label="Tabs"]');
    tabs.checked = true;
    tabs.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector('.prompt-panel[data-panel="1"]').classList.contains("is-active")).toBe(true);

    // The 1s poll fires before the pick's 500ms push does.
    await vi.advanceTimersByTimeAsync(3000);

    expect(document.querySelector('.prompt-panel[data-panel="1"]').classList.contains("is-active")).toBe(true);
    expect(snapshotActiveCardDraft("s1").selections.get(0)).toBe("Tabs");
  });

  it("adopting another client's draft does not push it back as a fresh write", async () => {
    renderQuestionUI(baseOpts({ onDraftChange: (d) => scheduleAuqPush("s1", "p1", d) }));
    await vi.advanceTimersByTimeAsync(900);
    const pushesBefore = setAuqDraft.mock.calls.length;

    getSessionDrafts.mockResolvedValue(remoteDrafts({ selections: [[0, "Spaces"]], updatedAt: "remote-1" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(snapshotActiveCardDraft("s1").selections.get(0)).toBe("Spaces");
    expect(setAuqDraft.mock.calls.length).toBe(pushesBefore);
  });
});

describe("live poll stops when the card closes", () => {
  it("makes no further get_session_drafts calls after cancel", async () => {
    const opts = baseOpts();
    renderQuestionUI(opts);
    await vi.advanceTimersByTimeAsync(1000);
    const callsWhileOpen = getSessionDrafts.mock.calls.length;
    expect(callsWhileOpen).toBeGreaterThan(0);

    document.querySelector('[data-act="cancel"]').click();
    await vi.advanceTimersByTimeAsync(5000);

    expect(getSessionDrafts.mock.calls.length).toBe(callsWhileOpen);
  });
});
