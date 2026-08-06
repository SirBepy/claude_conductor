// Background shadow-only pagination for the chat-wide image gallery
// (ai_todo 524): pages older history via sessionEvents directly, never
// through ChatPaginator/ChatRenderer.fetchOlder, so it never touches the
// live transcript.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { assistantEvent } from "./helpers/chat-events.mjs";

const hasMoreMock = vi.fn();
const loadOlderMock = vi.fn();
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { hasMore: hasMoreMock, loadOlder: loadOlderMock },
}));

let startBackgroundImageFill;

function textOf(m) {
  return m.content?.[0]?.text;
}

beforeEach(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  hasMoreMock.mockReset();
  loadOlderMock.mockReset();
  ({ startBackgroundImageFill } = await import("../src/shared/chat/chat-image-history-fill.ts"));
});

describe("startBackgroundImageFill", () => {
  it("pages older history oldest-first, growing extraMessages, until exhausted", async () => {
    hasMoreMock
      .mockReturnValueOnce(true) // loop check before page 1
      .mockReturnValueOnce(true) // onPage's hasMore after page 1 (more left)
      .mockReturnValueOnce(true) // loop check before page 2
      .mockReturnValueOnce(false) // onPage's hasMore after page 2 (exhausted)
      .mockReturnValueOnce(false); // loop check after page 2 - exits
    loadOlderMock
      .mockResolvedValueOnce([assistantEvent("page1-a"), assistantEvent("page1-b")])
      .mockResolvedValueOnce([assistantEvent("page2-a")]);

    const onPage = vi.fn();
    startBackgroundImageFill("sess-1", "/cwd", onPage);

    await vi.waitFor(() => expect(onPage).toHaveBeenCalledTimes(2));

    const [first, second] = onPage.mock.calls;
    expect(first[0].map(textOf)).toEqual(["page1-a", "page1-b"]);
    expect(first[1]).toBe(true);
    // Page 2 is OLDER than page 1, so it prepends in front - oldest-first overall.
    expect(second[0].map(textOf)).toEqual(["page2-a", "page1-a", "page1-b"]);
    expect(second[1]).toBe(false);

    expect(loadOlderMock).toHaveBeenNthCalledWith(1, "sess-1", "/cwd");
    expect(loadOlderMock).toHaveBeenNthCalledWith(2, "sess-1", "/cwd");
    expect(loadOlderMock).toHaveBeenCalledTimes(2);
  });

  it("stops further onPage calls once cancelled, even with a loadOlder promise in flight", async () => {
    hasMoreMock.mockReturnValue(true);
    let resolveLoadOlder;
    loadOlderMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveLoadOlder = resolve; }),
    );

    const onPage = vi.fn();
    const cancel = startBackgroundImageFill("sess-2", undefined, onPage);
    cancel();
    resolveLoadOlder([assistantEvent("late-page")]);

    // Let the async loop's post-await continuation run and observe cancellation.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onPage).not.toHaveBeenCalled();
    // The hidden hydration host is torn down on cancel.
    expect(document.body.children.length).toBe(0);
  });

  it("never calls onPage when hasMore is false from the start", async () => {
    hasMoreMock.mockReturnValue(false);
    const onPage = vi.fn();
    startBackgroundImageFill("sess-3", undefined, onPage);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onPage).not.toHaveBeenCalled();
    expect(loadOlderMock).not.toHaveBeenCalled();
  });
});
