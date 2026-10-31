// @vitest-environment jsdom

// An open detail card lives inside its message bubble, so the chat's per-message
// passes (code highlight, blockquote wrap, inline-code wrap, drill/file/ticket
// linkify) walk into it on any re-render of that bubble or history page load.
// None of them may rewrite the card: a `[x](#d:other)` inside would become a chip
// that swaps the card for another detail, and a code block would be highlighted
// mid-read.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { renderMessage, wrapBlockquotes } = await import("../src/shared/chat/chat-transforms.ts");
const { linkifyDrillRefs, handleDrillClick } = await import("../src/shared/chat/drill-links.ts");
const { highlightCodeBlocks, highlightInlineCode } = await import("../src/shared/chat/code-highlighter.ts");
const { linkifyFilePaths } = await import("../src/shared/chat/file-refs.ts");
const { linkifyTickets, forgetTicketTracker } = await import("../src/shared/chat/ticket-refs.ts");
const { resolveCommitRefs } = await import("../src/shared/chat/commit-refs.ts");

const BODY = [
  "```js",
  "const a = 1;",
  "```",
  "",
  "[x](#d:other)",
  "",
  "> quoted line",
  "",
  "inline `snippet` in /home/u/repo/src/main.ts and sc-123 at 8a180b5",
].join("\n");

const DETAILS = [
  { id: "ign", label: "the card", body_md: BODY },
  { id: "other", label: "another", body_md: "other body" },
];

// The pass roots the app really uses: the freshly built bubble (flushRender) and
// the whole container (pagination's history-page pass).
function openCard() {
  const container = document.createElement("div");
  container.innerHTML = renderMessage({
    kind: "message",
    text: "see [the card](#d:ign)",
    id: "t",
    ts: 1,
    parentToolUseId: null,
    details: DETAILS,
  });
  document.body.appendChild(container);
  container.addEventListener("click", handleDrillClick);
  const bubble = container.querySelector(".msg.assistant");
  linkifyDrillRefs(container, container);
  container.querySelector("button.drill-chip").click();
  const card = bubble.querySelector(".drill-pop");
  expect(card).not.toBeNull();
  return { container, bubble, card, before: card.innerHTML };
}

const passes = {
  highlightCodeBlocks: async (el) => highlightCodeBlocks(el),
  wrapBlockquotes: async (el) => wrapBlockquotes(el),
  highlightInlineCode: async (el) => highlightInlineCode(el),
  linkifyDrillRefs: async (el, container) => linkifyDrillRefs(el, container),
  linkifyFilePaths: async (el) => linkifyFilePaths(el),
  linkifyTickets: async (el) => {
    invokeMock.mockResolvedValue({ kind: "shortcut", workspace: "zirtue", team_keys: [], inferred: true });
    forgetTicketTracker("C:/zirtue");
    await linkifyTickets(el, "C:/zirtue");
  },
  resolveCommitRefs: async (el) => {
    invokeMock.mockResolvedValue([
      { query: "8a180b5", sha: "8a180b5000", subject: "s", author: "a", date: "2026-01-01T00:00:00Z" },
    ]);
    await resolveCommitRefs(el, "C:/repo");
  },
};

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
});

describe("an open detail card is left alone by the per-message passes", () => {
  for (const [name, run] of Object.entries(passes)) {
    it(`${name} does not rewrite the card when run over the bubble`, async () => {
      const { container, bubble, card, before } = openCard();
      await run(bubble, container);
      expect(card.isConnected).toBe(true);
      expect(card.innerHTML).toBe(before);
    });

    it(`${name} does not rewrite the card when run over the whole container`, async () => {
      const { container, card, before } = openCard();
      await run(container, container);
      expect(card.isConnected).toBe(true);
      expect(card.innerHTML).toBe(before);
    });
  }

  it("still processes the bubble's own text outside the card", async () => {
    const { bubble, card } = openCard();
    bubble.insertAdjacentHTML("afterbegin", "<p class=\"own\">/home/u/repo/own.ts</p>");
    linkifyFilePaths(bubble);
    expect(bubble.querySelector(".own .file-ref")).not.toBeNull();
    expect(card.querySelector(".file-ref")).toBeNull();
  });
});
