// @vitest-environment jsdom
//
// Joe, 2026-11-03: pasted images sat under the options list so he had to scroll
// to see them, and clicking one opened a preview whose caption box edited the
// MAIN chat input instead of the card's own answer box. Also covers the
// minimize exit animation that now precedes the collapsed bar.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue("C:\\fake\\chat-attachments\\s1\\paste.png") }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");
const { closeLightbox, setLightboxComposerBridge } = await import("../src/shared/chat/lightbox.ts");
const { expandActiveCard } = await import("../src/views/sessions/permission-modal/question-state.ts");

function baseOpts(overrides = {}) {
  return {
    questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    supportsExtras: true,
    ...overrides,
  };
}

function pastePngEvent() {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "paste.png", { type: "image/png" });
  const evt = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(evt, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" },
  });
  return evt;
}

async function pasteImage() {
  document.querySelector(".prompt-q__other-input").dispatchEvent(pastePngEvent());
  await vi.waitFor(() => {
    expect(document.querySelector(".prompt-attachments img")).toBeTruthy();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockClear();
});

afterEach(() => {
  closeLightbox();
  setLightboxComposerBridge(null);
  vi.useRealTimers();
});

describe("AUQ card attachment strip placement", () => {
  it("shows a pasted image in the footer, directly above the answer box, not inside the scrolling body", async () => {
    renderQuestionUI(baseOpts());
    await pasteImage();

    const strip = document.querySelector(".prompt-attachments");
    expect(strip.closest(".prompt-card__answer-bar")).toBeTruthy();
    expect(strip.closest(".prompt-card__body")).toBeNull();
    const field = document.querySelector(".prompt-q__other-input");
    // DOCUMENT_POSITION_FOLLOWING (4): the field comes after the strip.
    expect(strip.compareDocumentPosition(field) & 4).toBeTruthy();
  });

  it("keeps each step's images on that step when the answer box swaps", async () => {
    renderQuestionUI(baseOpts({
      questions: [
        { question: "One?", options: [{ label: "A" }] },
        { question: "Two?", options: [{ label: "B" }] },
      ],
    }));
    await pasteImage();

    document.querySelector('.prompt-pager [data-nav="1"]').removeAttribute("disabled");
    document.querySelector('[data-dot="1"]').click();
    await vi.waitFor(() => {
      expect(document.querySelector(".prompt-attachments").dataset.attachPanel).toBe("1");
    });
    expect(document.querySelector(".prompt-attachments img")).toBeNull();
  });
});

describe("AUQ card image preview caption", () => {
  it("edits the card's answer box, never the main chat composer's draft", async () => {
    const mainDraft = { text: "main chat draft" };
    setLightboxComposerBridge({
      getDraftText: () => mainDraft.text,
      setDraftText: (t) => { mainDraft.text = t; },
    });
    renderQuestionUI(baseOpts());
    const field = document.querySelector(".prompt-q__other-input");
    field.value = "card text";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await pasteImage();

    document.querySelector(".prompt-attachments img").click();
    const caption = document.querySelector(".lightbox-composer");
    expect(caption.value).toBe("card text");

    caption.value = "card text plus a caption";
    closeLightbox();

    expect(document.querySelector(".prompt-q__other-input").value).toBe("card text plus a caption");
    expect(mainDraft.text).toBe("main chat draft");
  });
});

describe("AUQ card minimize animation", () => {
  it("plays the exit, then swaps to the collapsed bar", () => {
    vi.useFakeTimers();
    renderQuestionUI(baseOpts());

    document.querySelector('[data-act="minimize"]').click();
    expect(document.querySelector(".prompt-card.prompt-card--leaving")).toBeTruthy();
    expect(document.querySelector(".prompt-collapsed")).toBeNull();

    vi.advanceTimersByTime(400);
    expect(document.querySelector(".prompt-collapsed.prompt-collapsed--in")).toBeTruthy();
    expect(document.querySelector(".prompt-card")).toBeNull();
  });

  it("a cancelled exit leaves no timer behind to cut the next exit short", () => {
    vi.useFakeTimers();
    renderQuestionUI(baseOpts({ id: "p-1", sessionId: "s-1" }));

    document.querySelector('[data-act="minimize"]').click();
    vi.advanceTimersByTime(200);
    // Re-announcing the question mid-exit cancels it.
    expandActiveCard({ id: "p-1" });
    expect(document.querySelector(".prompt-card--leaving")).toBeNull();

    // The second exit starts 200ms into the first one's 360ms fallback timer.
    document.querySelector('[data-act="minimize"]').click();
    vi.advanceTimersByTime(200);
    expect(document.querySelector(".prompt-collapsed")).toBeNull();
    expect(document.querySelector(".prompt-card--leaving")).toBeTruthy();

    vi.advanceTimersByTime(400);
    expect(document.querySelector(".prompt-collapsed")).toBeTruthy();
  });

  it("rises back out of the bar when restored", () => {
    vi.useFakeTimers();
    renderQuestionUI(baseOpts());
    document.querySelector('[data-act="minimize"]').click();
    vi.advanceTimersByTime(400);

    document.querySelector('.prompt-collapsed [data-act="restore"]').click();

    expect(document.querySelector(".prompt-card.prompt-card--expanding")).toBeTruthy();
  });
});
