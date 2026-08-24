// @vitest-environment jsdom
// Regression (todo 731): a swapped-away permission card's Escape handler
// stayed bound, and its clearHost()-by-ID deleted whatever card replaced
// it - live question card included.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The question card mounts a composer, whose SlashProvider fetches this list
// and iterates it. A bare undefined rejects unhandled after the test passed.
const invokeMock = vi.fn().mockImplementation((cmd) =>
  Promise.resolve(cmd === "list_slash_commands" ? [] : undefined)
);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
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

const { showPermissionCard } = await import("../src/views/sessions/permission-modal/permission-card.ts");
const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { dismissQuestionCard, getActiveCardId } = await import("../src/views/sessions/permission-modal/question-state.ts");

function permissionPayload(overrides = {}) {
  return { id: "perm-1", tool_name: "Bash", input: { command: "echo hi" }, session_id: "s-perm", ...overrides };
}

function questionOpts(overrides = {}) {
  return {
    id: "q-1",
    sessionId: "s-q",
    questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
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

describe("a permission card swapped away by ensureHost()", () => {
  it("leaves the live question card mounted with its options intact after Escape", () => {
    showPermissionCard(permissionPayload());
    expect(document.querySelector('[data-act="allow"]')).not.toBeNull();

    const live = questionOpts();
    renderQuestionUI(live);
    expect(document.querySelectorAll("#prompt-card-host").length).toBe(1);

    // A lightbox means the LIVE card's Escape handler correctly no-ops (see
    // auq-escape-lightbox-guard.test.mjs) - it's meant to survive. The stale
    // permission card's unremoved escHandler has no such guard, though.
    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    document.body.appendChild(overlay);

    pressEscape();

    expect(document.querySelectorAll("#prompt-card-host").length).toBe(1);
    expect(document.querySelectorAll('.prompt-panel[data-panel="0"] input').length).toBe(2);
    expect(getActiveCardId()).toBe("q-1");
    expect(live.onCancel).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("respond_permission", expect.objectContaining({ id: "perm-1" }));
  });

  it("leaves no document-level listener behind once torn down by a swap", () => {
    showPermissionCard(permissionPayload());
    const fromPermissionCard = [...liveDocListeners];
    expect(fromPermissionCard.length).toBeGreaterThan(0);

    renderQuestionUI(questionOpts());

    const leaked = fromPermissionCard.filter((l) =>
      liveDocListeners.some((x) => x.type === l.type && x.handler === l.handler)
    );
    expect(leaked).toEqual([]);
  });
});
