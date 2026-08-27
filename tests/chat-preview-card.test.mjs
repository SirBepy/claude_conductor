// @vitest-environment jsdom

// The show_preview card: a pushed HTML document becomes its own centered
// message row on BOTH the live and scrollback paths, and the rail stops
// force-opening for it. The two paths drifting is the failure this guards:
// a card that renders live but reads back as raw narration after a reload.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue("http://127.0.0.1:1/hooks/preview-render/abc"),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { previewFieldsOf, titleFromSlug, renderPreviewCardHtml, PREVIEW_SOURCE_CHAT_CARD } =
  await import("../src/shared/chat/chat-preview-card.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");
const { isShowPreviewTool, MCP_SHOW_PREVIEW_TOOL } = await import("../src/shared/chat/tool-meta.ts");

const PUSH = {
  type: "tool_use",
  tool_name: MCP_SHOW_PREVIEW_TOOL,
  input: { slug: "clockify-week", html: "<p>hi</p>" },
  id: "tu-1",
  ts: 0,
  parent_tool_use_id: null,
};

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("show_preview field extraction", () => {
  it("derives a title from the slug when the push omits one", () => {
    expect(titleFromSlug("clockify-week")).toBe("Clockify Week");
    expect(previewFieldsOf({ slug: "clockify-week", html: "<p>x</p>" }).text).toBe("Clockify Week");
  });

  it("prefers an explicit title over the slug", () => {
    expect(previewFieldsOf({ slug: "a-b", title: "Real Title", html: "<p>x</p>" }).text).toBe("Real Title");
  });

  it("keeps the html and slug so the card can render without the daemon store", () => {
    const f = previewFieldsOf({ slug: "s", html: "<p>x</p>" });
    expect(f.previewHtml).toBe("<p>x</p>");
    expect(f.previewSlug).toBe("s");
  });

  it("recognizes only the MCP wire name", () => {
    expect(isShowPreviewTool(MCP_SHOW_PREVIEW_TOOL)).toBe(true);
    expect(isShowPreviewTool("Read")).toBe(false);
  });
});

describe("scrollback path", () => {
  it("maps a show_preview tool_use to a preview row, not hidden narration", () => {
    const m = eventToRenderedMessage(PUSH);
    expect(m.kind).toBe("preview");
    expect(m.text).toBe("Clockify Week");
    expect(m.previewHtml).toBe("<p>hi</p>");
  });

  it("leaves a subagent's own push as a plain tool_use", () => {
    const m = eventToRenderedMessage({ ...PUSH, parent_tool_use_id: "parent-1" });
    expect(m.kind).toBe("tool_use");
  });
});

describe("card markup", () => {
  it("renders the header, the sandboxed frame and the rail hand-off button", () => {
    const el = document.createElement("div");
    el.innerHTML = renderPreviewCardHtml(previewFieldsOf(PUSH.input));
    expect(el.querySelector(".pc-label").textContent).toBe("Clockify Week");
    expect(el.querySelector(".pc-frame").getAttribute("sandbox")).toBe("allow-scripts");
    expect(el.querySelector(".pc-pop").dataset.previewPop).toBe("clockify-week");
  });

  it("escapes a title rather than letting it inject markup", () => {
    const el = document.createElement("div");
    el.innerHTML = renderPreviewCardHtml(previewFieldsOf({ slug: "s", title: "<img src=x>", html: "<p>x</p>" }));
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("rail carve-out", () => {
  it("pins the source value the rail keys its no-force-open rule on", () => {
    // Must stay byte-identical to the Rust PREVIEW_SOURCE_CHAT_CARD; a
    // mismatch silently restores the force-open the card exists to stop.
    expect(PREVIEW_SOURCE_CHAT_CARD).toBe("chat_card");
  });
});
