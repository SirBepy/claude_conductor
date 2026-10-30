// A user message's sent attachments sit in a tray under the bubble, so the
// long-text clamp cannot hide the images that follow the text. Images past the
// cap fold into "+N" (which opens the image gallery); files never fold because
// the gallery holds images only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, makeBus } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { groupAttachmentTray, foldTray, TRAY_IMAGE_CAP } = await import("../src/shared/chat/message-attachment-tray.ts");
const { clampUserMessages } = await import("../src/shared/chat/turn-collapse.ts");
const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
});

afterEach(() => {
  delete globalThis.window.__TAURI__;
});

function chip(name) {
  return `<div class="attachment-chip" data-attachment-path="C:\\x\\${name}" data-filename="${name}"><i class="ph ph-file"></i><span class="chip-name">${name}</span></div>`;
}

function userEl(text, names) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="block text">${text}</div>${names.map(chip).join("")}`;
  return el;
}

const pngs = (n) => Array.from({ length: n }, (_, i) => `shot-${i + 1}.png`);

describe("groupAttachmentTray", () => {
  it("moves the chips into a tray under a bubble that keeps the text", () => {
    const el = userEl("look at these", pngs(2));
    groupAttachmentTray(el);

    expect(el.classList.contains("has-tray")).toBe(true);
    const bubble = el.querySelector(":scope > .msg-bubble");
    const tray = el.querySelector(":scope > .msg-tray");
    expect(bubble.textContent).toContain("look at these");
    expect(bubble.querySelector(".attachment-chip")).toBeNull();
    expect(tray.querySelectorAll(".attachment-chip")).toHaveLength(2);
    expect(bubble.nextElementSibling).toBe(tray);
  });

  it("drops the empty bubble when the message is only attachments", () => {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = chip("a.png") + chip("b.pdf");
    groupAttachmentTray(el);

    expect(el.querySelector(":scope > .msg-bubble")).toBeNull();
    expect(el.querySelector(":scope > .msg-tray").children).toHaveLength(2);
  });

  it("leaves a message with no attachments alone, and is idempotent", () => {
    const plain = userEl("just text", []);
    groupAttachmentTray(plain);
    expect(plain.classList.contains("has-tray")).toBe(false);

    const el = userEl("x", pngs(1));
    groupAttachmentTray(el);
    groupAttachmentTray(el);
    expect(el.querySelectorAll(".msg-tray")).toHaveLength(1);
    expect(el.querySelectorAll(".msg-bubble")).toHaveLength(1);
  });
});

describe("foldTray", () => {
  it("shows every image up to the cap with no +N tile", () => {
    const el = userEl("x", pngs(TRAY_IMAGE_CAP));
    groupAttachmentTray(el);
    expect(el.querySelector(".msg-tray-more")).toBeNull();
    expect(el.querySelectorAll(".msg-tray-folded")).toHaveLength(0);
  });

  it("folds images past the cap into a +N tile and never folds a file", () => {
    const el = userEl("x", [...pngs(9), "notes.pdf", "report.pdf"]);
    groupAttachmentTray(el);

    const folded = el.querySelectorAll(".msg-tray-folded");
    expect(folded).toHaveLength(3);
    for (const f of folded) expect(f.dataset.filename).toMatch(/^shot-[789]\.png$/);
    expect(el.querySelector(".msg-tray-more").textContent).toBe("+3");
    const pdfs = [...el.querySelectorAll(".attachment-chip")].filter((c) => c.dataset.filename.endsWith(".pdf"));
    expect(pdfs).toHaveLength(2);
    for (const p of pdfs) expect(p.classList.contains("msg-tray-folded")).toBe(false);
  });

  it("re-folds after hydration replaces a chip with a fresh thumb node", () => {
    const el = userEl("x", pngs(8));
    groupAttachmentTray(el);
    const tray = el.querySelector(".msg-tray");
    for (const c of [...tray.querySelectorAll(".attachment-chip")]) {
      const thumb = document.createElement("div");
      thumb.className = "sent-attachment-thumb";
      c.replaceWith(thumb);
    }
    expect(tray.querySelectorAll(".msg-tray-folded")).toHaveLength(0);

    foldTray(tray);
    expect(tray.querySelectorAll(".msg-tray-folded")).toHaveLength(2);
    expect(tray.querySelectorAll(".msg-tray-more")).toHaveLength(1);
  });

  it("clicking +N clicks the first folded thumb, which opens the gallery at it", () => {
    const el = userEl("x", pngs(8));
    groupAttachmentTray(el);
    const tray = el.querySelector(".msg-tray");
    const clicks = [];
    [...tray.querySelectorAll(".attachment-chip")].forEach((c, i) => {
      const thumb = document.createElement("div");
      thumb.className = "sent-attachment-thumb";
      thumb.addEventListener("click", () => clicks.push(i + 1));
      c.replaceWith(thumb);
    });
    foldTray(tray);
    tray.querySelector(".msg-tray-more").click();
    expect(clicks).toEqual([TRAY_IMAGE_CAP + 1]);
  });
});

describe("clampUserMessages with a tray", () => {
  it("clamps only the bubble and leaves the tray outside the clipped body", () => {
    const el = userEl("a very long wall of text", pngs(2));
    groupAttachmentTray(el);
    const bubble = el.querySelector(":scope > .msg-bubble");
    Object.defineProperty(bubble, "scrollHeight", { value: 900 });

    clampUserMessages([{ kind: "user", content: [], ts: 0 }], [el]);

    expect(el.classList.contains("has-clamp")).toBe(true);
    expect(bubble.querySelector(":scope > .msg-clamp-body")).not.toBeNull();
    expect(bubble.querySelector(":scope > .msg-clamp-toggle")).not.toBeNull();
    const tray = el.querySelector(":scope > .msg-tray");
    expect(tray.closest(".msg-clamp-body")).toBeNull();
    expect(tray.querySelectorAll(".attachment-chip")).toHaveLength(2);
  });
});

describe("ChatRenderer wiring", () => {
  it("renders a user message's attachments in a tray and folds hydrated images past the cap", async () => {
    globalThis.window.__TAURI__ = makeBus();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "read_attachment") return { mime: "image/png", base64: "AAAA" };
      return { events: [], oldest_seq: 0, newest_seq: 0, has_more: false };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    const sid = `sess-tray-${Math.random()}`;
    await r.attach(sid);
    await r.loadFromStore();

    const tokens = pngs(8).map((n) => `<file:C:\\x\\${n}::${n}>`).join("\n");
    sessionEvents.pushSynthetic(r.currentSessionId(), userEvent(`see these\n\n${tokens}`, Date.now()));

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg.user > .msg-tray .sent-attachment-thumb")).toHaveLength(8);
    });
    const msg = container.querySelector(".msg.user");
    expect(msg.classList.contains("has-tray")).toBe(true);
    expect(msg.querySelector(":scope > .msg-bubble").textContent).toContain("see these");
    await vi.waitFor(() => {
      expect(msg.querySelectorAll(".msg-tray-folded")).toHaveLength(2);
    });
    expect(msg.querySelector(".msg-tray-more").textContent).toBe("+2");
  });
});
