// @vitest-environment jsdom
// Joe 2026-11-25: Ctrl+N dimmed the whole window and drew no picker card.
// A card enters hidden (`modal-card-morph-hidden`, opacity 0) and is shown by
// removing that class on the next animation frame. WebView2 pauses
// requestAnimationFrame while its window counts as hidden or occluded
// (flush-scheduler.ts), so the backdrop (plain CSS) showed and the card never
// left its hidden state. A frame that never comes must not hold a card hidden.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { html, render } from "lit-html";

beforeEach(() => {
  vi.useFakeTimers();
  // A paused frame loop: callbacks are queued and never run.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(async () => {
  const { closeHostCard } = await import("../src/shared/modal.ts");
  closeHostCard();
  await vi.advanceTimersByTimeAsync(400);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("presentHostCard with a paused animation-frame loop", () => {
  it("still lifts the hidden start state off the card", async () => {
    const { presentHostCard, modalCardSlot } = await import("../src/shared/modal.ts");
    void presentHostCard(() => {
      render(html`<div class="modal-card project-picker-modal">card</div>`, modalCardSlot());
    });
    await vi.advanceTimersByTimeAsync(300);
    const card = document.querySelector("#modal-host .modal-card");
    expect(card).not.toBeNull();
    expect(card.classList.contains("modal-card-morph-hidden")).toBe(false);
  });

  it("still lifts the hidden state when a step morphs into the next one", async () => {
    const { presentHostCard, modalCardSlot } = await import("../src/shared/modal.ts");
    const draw = (label) => () =>
      render(html`<div class="modal-card">${label}</div>`, modalCardSlot());
    void presentHostCard(draw("one"));
    await vi.advanceTimersByTimeAsync(300);
    void presentHostCard(draw("two"));
    await vi.advanceTimersByTimeAsync(600);
    const card = document.querySelector("#modal-host .modal-card");
    expect(card.textContent).toBe("two");
    expect(card.classList.contains("modal-card-morph-hidden")).toBe(false);
  });
});
