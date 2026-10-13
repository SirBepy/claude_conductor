// @vitest-environment jsdom

// A question card links ticket ids in its question and option descriptions,
// like a chat bubble, so hovering one shows the ticket's hover card.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

const SC = { kind: "shortcut", workspace: "zirtue", team_keys: [], inferred: true };

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd) => Promise.resolve(cmd === "get_ticket_tracker" ? SC : []));
});

describe("question card ticket links", () => {
  it("links ids in the question text and option descriptions", async () => {
    renderQuestionUI({
      questions: [{
        question: "Should 53957 go to On hold, or stay in Blocked?",
        options: [{ label: "On hold" }, { label: "Keep Blocked", description: "It has a real BE blocker (51278)." }],
      }],
      titleText: "Question",
      cancelLabel: "Skip",
      submitLabel: "Submit",
      submitIcon: "ph-check",
      cwd: "C:/zirtue-ticket-links",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    });
    await vi.waitFor(() => expect(document.querySelectorAll("a.ticket-ref")).toHaveLength(2));
    expect([...document.querySelectorAll("a.ticket-ref")].map((a) => a.getAttribute("href"))).toEqual([
      "https://app.shortcut.com/zirtue/story/53957",
      "https://app.shortcut.com/zirtue/story/51278",
    ]);
  });
});
