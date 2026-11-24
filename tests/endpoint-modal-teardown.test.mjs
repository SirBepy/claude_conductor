// @vitest-environment jsdom
// asserts: src/views/settings/subviews/models-providers/provider-modals.ts

// The Endpoint account modals are hand-built DOM on the shared modal host, whose
// teardown clears the slot with lit's render. A card appended outside lit stayed in
// the slot after Cancel, so the next flow's card (Add account's kind card) drew
// under a stale "Add DeepSeek" card.

import { describe, it, expect, vi } from "vitest";
import { html, render } from "lit-html";

vi.mock("../src/shared/api.ts", () => ({ api: { addEndpointAccount: vi.fn() } }));

const { openAddEndpointModal } = await import("../src/views/settings/subviews/models-providers/provider-modals.ts");
const { modalCardSlot, presentHostCard } = await import("../src/shared/modal.ts");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Endpoint add modal teardown", () => {
  it("leaves no card behind after Cancel, so the next flow's card is the only one", async () => {
    const pending = openAddEndpointModal("openrouter");
    await wait(60);
    expect(modalCardSlot().querySelectorAll(".modal-card")).toHaveLength(1);

    document.querySelector(".mp-modal-cancel").click();
    expect(await pending).toBeNull();
    await wait(300);
    expect(modalCardSlot().querySelector(".modal-card")).toBeNull();

    await presentHostCard(() => render(html`<div class="modal-card kind-card">next</div>`, modalCardSlot()));
    const cards = [...modalCardSlot().querySelectorAll(".modal-card")];
    expect(cards.map((c) => c.className.includes("kind-card"))).toEqual([true]);
  });
});
