// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/permission-card.ts

// The approval card for `capture_secret_from_page` draws the page, element and text length
// open and offers no "Always Allow": a save is approved one element at a time. An ordinary
// tool's card keeps its title, its Always Allow button and no facts block.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/views/sessions/permission-modal/gating.ts", () => ({
  displayIdOf: (p) => p.session_id,
  resolveCwdForSession: () => "C:\\repo",
  storePendingPrompt: vi.fn(),
}));
// The desktop shell: a remembered rule can be saved there, which is what makes the button's
// absence on the capture card the card's own doing and not the phone's.
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/permission-modal/asker-face.ts", () => ({ askerFaceOf: () => null }));

const { showPermissionCard } = await import("../src/views/sessions/permission-modal/permission-card.ts");

const CAPTURE = "mcp__cc_conductor__capture_secret_from_page";
const INPUT = {
  label: "OVH client secret",
  file: "C:\\chat\\.env.ovh",
  key: "OVH_SECRET",
  element: "e12",
  page: "https://console.example.com/keys",
  found: '<input id="client-secret" type="password">',
  length: 27,
};

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

describe("permission card for the page-to-file secret save", () => {
  it("draws the facts open, retitles the card and drops Always Allow", () => {
    showPermissionCard({ id: "p1", session_id: "s1", tool_name: CAPTURE, input: INPUT });
    const facts = document.querySelector(".prompt-card__facts");
    expect(facts?.textContent).toContain("https://console.example.com/keys");
    expect(facts?.textContent).toContain('<input id="client-secret" type="password">');
    expect(facts?.textContent).toContain("27 characters");
    expect(document.querySelector(".prompt-card__title")?.textContent).toContain("Save a secret from this page");
    expect(document.querySelector('[data-act="always"]')).toBeNull();
    expect(document.querySelector('[data-act="allow"]')).not.toBeNull();
  });

  it("keeps the ordinary card for any other tool", () => {
    showPermissionCard({ id: "p2", session_id: "s1", tool_name: "WebFetch", input: { url: "https://example.com" } });
    expect(document.querySelector(".prompt-card__facts")).toBeNull();
    expect(document.querySelector(".prompt-card__title")?.textContent).toContain("Permission requested");
    expect(document.querySelector('[data-act="always"]')).not.toBeNull();
  });
});
