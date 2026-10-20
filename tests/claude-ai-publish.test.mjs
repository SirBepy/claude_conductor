// @vitest-environment jsdom

// "Publish to claude.ai" for previews. Pins the parts that decide what the
// user actually gets: which click re-uploads versus just re-copies the link,
// the menu wording per state, and the toast handing over the link.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, remoteMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  remoteMock: vi.fn(() => false),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: remoteMock }));

const { publishState, publishLabel, publishIcon, publishToClaudeAi, canPublish } = await import(
  "../src/shared/claude-ai-publish.ts"
);

const LINK = { url: "https://claude.ai/artifact/AB12", version: 3, account: "Joe", published_at: "now" };

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = `<div id="toastStack"></div>`;
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function toasts() {
  return [...document.querySelectorAll(".toast-msg")].map((t) => t.textContent);
}

describe("publish state", () => {
  it("is none, current or stale against the shown version", () => {
    expect(publishState(null, 3)).toBe("none");
    expect(publishState(LINK, 3)).toBe("current");
    expect(publishState(LINK, 4)).toBe("stale");
  });

  it("words the menu row by state", () => {
    expect(publishLabel(null, 1)).toBe("Publish to claude.ai");
    expect(publishLabel(LINK, 3)).toBe("Copy claude.ai link");
    expect(publishLabel(LINK, 4)).toBe("Update on claude.ai");
    expect(publishIcon(LINK, 3)).toBe("ph-link");
    expect(publishIcon(LINK, 4)).toBe("ph-cloud-arrow-up");
  });

  it("is hidden on the phone transport", () => {
    remoteMock.mockReturnValueOnce(true);
    expect(canPublish()).toBe(false);
  });
});

describe("publishToClaudeAi", () => {
  it("re-copies a current link without spending another upload", async () => {
    const out = await publishToClaudeAi("p", LINK, 3);
    expect(out).toBe(LINK);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINK.url);
  });

  it("uploads when the preview moved past the link, and shows the link", async () => {
    const fresh = { ...LINK, version: 4 };
    invokeMock.mockResolvedValueOnce({ published: fresh, stored: true });
    const out = await publishToClaudeAi("p", LINK, 4);
    expect(invokeMock).toHaveBeenCalledWith("publish_to_claude_ai", { id: "p" });
    expect(out).toEqual(fresh);
    // The menu closes on click, so the run announces itself first.
    expect(toasts()[0]).toContain("Publishing to claude.ai");
    expect(toasts().at(-1)).toContain("claude.ai/artifact/AB12");
    expect(toasts().at(-1)).toContain("as Joe");
  });

  it("ignores a second click on the same preview while the first run is open", async () => {
    let finish;
    invokeMock.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const first = publishToClaudeAi("same", null, 1);
    const second = await publishToClaudeAi("same", null, 1);
    expect(second).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(toasts().at(-1)).toContain("Already publishing");
    finish({ published: LINK, stored: true });
    await first;
    // Settled runs release the id, so a later click can publish again.
    invokeMock.mockResolvedValueOnce({ published: LINK, stored: true });
    await publishToClaudeAi("same", null, 1);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("says so when the preview was removed before the link could be saved", async () => {
    invokeMock.mockResolvedValueOnce({ published: LINK, stored: false });
    const out = await publishToClaudeAi("gone", null, 3);
    expect(out).toBeNull();
    expect(toasts().at(-1)).toContain("claude.ai/artifact/AB12");
    expect(toasts().at(-1)).toContain("(preview was removed, link not saved)");
  });

  it("reports a failure", async () => {
    invokeMock.mockRejectedValueOnce("no account");
    const out = await publishToClaudeAi("p", null, 1);
    expect(out).toBeNull();
    expect(toasts().at(-1)).toContain("no account");
  });
});
