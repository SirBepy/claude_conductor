// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Covers todo 888: the bar stays up on an idle session purely to host the held
// chip, and used to keep the last tool name, rendering "<tool>... - thinking…"
// on a chat that finished minutes earlier.
describe("thinking bar, idle with held messages", () => {
  let mod;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    state = (await import("../src/views/sessions/state.ts")).state;
    mod = await import("../src/views/sessions/session-thinking-bar.ts");
  });

  afterEach(() => {
    mod.initThinkingBar(null);
    state.heldMessages = undefined;
    document.body.innerHTML = "";
  });

  function mount({ busy, held, frozen = false }) {
    const pane = document.createElement("div");
    pane.innerHTML = `<div class="session-thinking"><span class="thinking-text"></span></div>`;
    document.body.appendChild(pane);
    state.sessions = [{ session_id: "s1", busy, awaiting: null, frozen }];
    state.selectedId = "s1";
    state.pendingNewSession = null;
    state.heldMessages = { hasItemsForActive: () => held, renderChip: () => {} };
    mod.initThinkingBar(pane);
    mod.setThinkingActivity("mcp__cc_conductor__report_turn_status...", true);
    return pane.querySelector(".thinking-text");
  }

  it("does not claim to be thinking when no turn is running", () => {
    const text = mount({ busy: false, held: true });
    expect(text.textContent).not.toMatch(/thinking/i);
    expect(text.textContent).toBe("Waiting to send");
  });

  it("still names the live tool while the turn really is running", () => {
    const text = mount({ busy: true, held: true });
    expect(text.textContent).toBe("mcp__cc_conductor__report_turn_status... - thinking…");
  });

  it("keeps the frozen label, which was already truthful", () => {
    const text = mount({ busy: false, held: true, frozen: true });
    expect(text.textContent).toBe("Frozen - will send once unfrozen");
  });

  it("hides the bar entirely when idle with nothing held", () => {
    const pane = document.createElement("div");
    pane.innerHTML = `<div class="session-thinking"><span class="thinking-text"></span></div>`;
    document.body.appendChild(pane);
    state.sessions = [{ session_id: "s1", busy: false, awaiting: null }];
    state.selectedId = "s1";
    state.pendingNewSession = null;
    state.heldMessages = { hasItemsForActive: () => false, renderChip: () => {} };
    mod.initThinkingBar(pane);
    mod.updateThinkingBar();
    expect(pane.querySelector(".session-thinking").hasAttribute("hidden")).toBe(true);
  });
});
