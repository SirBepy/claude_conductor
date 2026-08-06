// @vitest-environment jsdom

// Images chip: hides at zero, lists each image via the shared
// chat-renderer-bridge provider, shows "loading earlier" when more history remains.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { setChatImageDataProvider } = await import("../src/shared/chat/chat-renderer-bridge.ts");
const { attachmentShots } = await import("../src/shared/chat/attachment-hydrator.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

function attachmentThumb(mime, base64, filename) {
  const thumb = document.createElement("div");
  thumb.className = "sent-attachment-thumb";
  attachmentShots.set(thumb, { mime, base64, filename });
  return thumb;
}

function userMsg(text) {
  return { kind: "user", content: [{ type: "text", text }], ts: 0 };
}

function mount(rows = [["images"]], opts = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, rows, { sessionId: "sess-1", hideZero: true, ...opts });
  return { el, sb };
}

beforeEach(() => {
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
  setChatImageDataProvider(null);
  vi.restoreAllMocks();
});

describe("images chip", () => {
  it("hides when there are no images", () => {
    const { el, sb } = mount();
    setChatImageDataProvider(() => ({ messages: [userMsg("hi")], messageEls: [document.createElement("div")], sessionId: "sess-1", cwd: undefined }));
    sb.updateToolTally({ byType: [] });
    expect(el.querySelector(".sb-images")).toBeNull();
  });

  it("renders a count chip and opens a popover listing each image", () => {
    const { el, sb } = mount();
    const msgEl = document.createElement("div");
    msgEl.appendChild(attachmentThumb("image/png", "AAAA", "shot.png"));
    setChatImageDataProvider(() => ({ messages: [userMsg("here is a file")], messageEls: [msgEl], sessionId: "sess-1", cwd: undefined }));
    sb.updateToolTally({ byType: [] });

    const chip = el.querySelector(".sb-images-btn");
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("1 img");

    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const pop = document.body.querySelector(".sb-images-popover");
    expect(pop).not.toBeNull();
    const rows = pop.querySelectorAll(".sb-images-row");
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".sb-images-row-name").textContent).toBe("shot.png");
    expect(rows[0].dataset.agent).toBe("user");
  });

  it("shows a trailing loading row when the session has more (older) history", () => {
    vi.spyOn(sessionEvents, "hasMore").mockReturnValue(true);
    const { el, sb } = mount();
    const msgEl = document.createElement("div");
    msgEl.appendChild(attachmentThumb("image/png", "AAAA", "shot.png"));
    setChatImageDataProvider(() => ({ messages: [userMsg("file")], messageEls: [msgEl], sessionId: "sess-1", cwd: undefined }));
    sb.updateToolTally({ byType: [] });

    el.querySelector(".sb-images-btn").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.querySelector(".sb-images-loading")).not.toBeNull();
  });
});
