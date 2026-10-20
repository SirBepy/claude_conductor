// @vitest-environment jsdom

// "Publish to claude.ai". Pins the parts that decide what the user
// actually gets: which click re-uploads versus just re-copies the link, the
// draft page staying free of smuggled markup, and the toast handing over the
// link.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, remoteMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  remoteMock: vi.fn(() => false),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: remoteMock }));

const {
  publishState,
  publishButtonHtml,
  publishToClaudeAi,
  buildDraftPage,
  contentStamp,
  canPublish,
} = await import("../src/shared/claude-ai-publish.ts");

const LINK = { url: "https://claude.ai/artifact/AB12", version: 3, account: "Joe", published_at: "now" };

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = `<div id="toastStack"></div>`;
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("publish state", () => {
  it("is none, current or stale against the shown version", () => {
    expect(publishState(null, 3)).toBe("none");
    expect(publishState(LINK, 3)).toBe("current");
    expect(publishState(LINK, 4)).toBe("stale");
  });

  it("draws a link icon only when the link is current", () => {
    expect(publishButtonHtml(LINK, 3, "icon-btn")).toContain("ph-link");
    expect(publishButtonHtml(LINK, 4, "icon-btn")).toContain("ph-cloud-arrow-up");
    expect(publishButtonHtml(null, 1, "icon-btn")).toContain("private until you Share it");
  });

  it("is hidden on the phone transport", () => {
    remoteMock.mockReturnValueOnce(true);
    expect(canPublish()).toBe(false);
  });
});

describe("publishToClaudeAi", () => {
  it("re-copies a current link without spending another upload", async () => {
    const out = await publishToClaudeAi({ target: "preview", id: "p" }, LINK, 3, null);
    expect(out).toBe(LINK);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINK.url);
  });

  it("uploads when the content moved past the link, and shows the link", async () => {
    const fresh = { ...LINK, version: 4 };
    invokeMock.mockResolvedValueOnce(fresh);
    const out = await publishToClaudeAi({ target: "preview", id: "p" }, LINK, 4, null);
    expect(invokeMock).toHaveBeenCalledWith("publish_to_claude_ai", { params: { target: "preview", id: "p" } });
    expect(out).toEqual(fresh);
    expect(document.querySelector(".toast-msg")?.textContent).toContain("claude.ai/artifact/AB12");
    expect(document.querySelector(".toast-msg")?.textContent).toContain("as Joe");
  });

  it("restores the button and reports a failure", async () => {
    document.body.insertAdjacentHTML("beforeend", `<button data-publish><i class="ph ph-cloud-arrow-up"></i></button>`);
    const btn = document.querySelector("button");
    invokeMock.mockRejectedValueOnce("no account");
    const out = await publishToClaudeAi({ target: "preview", id: "p" }, null, 1, btn);
    expect(out).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector("i").className).toBe("ph ph-cloud-arrow-up");
    expect(document.querySelector(".toast-msg")?.textContent).toContain("no account");
  });
});

describe("buildDraftPage", () => {
  it("renders markdown into a standalone page titled by the topic", () => {
    const page = buildDraftPage("Handover <Revaire>", "## State\n\n- **done**");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<title>Handover &lt;Revaire&gt;</title>");
    expect(page).toContain("<h2>State</h2>");
    expect(page).toContain("<strong>done</strong>");
    expect(page).toContain("prefers-color-scheme: dark");
  });

  it("never passes raw HTML from the draft through", () => {
    const page = buildDraftPage("t", "<script>alert(1)</script>");
    expect(page).not.toContain("<script>alert(1)</script>");
  });
});

describe("contentStamp", () => {
  it("changes when the text changes and is a u32", () => {
    const a = contentStamp("hello");
    expect(a).toBe(contentStamp("hello"));
    expect(a).not.toBe(contentStamp("hello!"));
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
  });
});
