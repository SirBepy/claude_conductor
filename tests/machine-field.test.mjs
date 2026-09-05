// @vitest-environment jsdom
//
// New-chat machine chip row (H4). Pure render + attach - no IPC, no modal
// chrome; project-picker.ts owns wiring this into the real picker.

import { describe, it, expect, vi } from "vitest";

const { renderMachineFieldHtml, attachMachineFieldHandlers } = await import(
  "../src/views/sessions/machine-field.ts"
);

const SELF = { machine_id: "self", label: "This machine", os: "windows" };
const PEER_ONLINE = {
  machine_id: "peer-1", label: "Mac Mini", os: "macos",
  iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0,
  reach: "direct",
};
const PEER_OFFLINE = {
  machine_id: "peer-2", label: "Old Laptop", os: "windows",
  iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0,
  reach: "none",
};

function mount(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

describe("renderMachineFieldHtml", () => {
  it("renders nothing when there are no peers", () => {
    const html = renderMachineFieldHtml({ machineId: null }, { self: null, peers: [] });
    expect(html).toBe("");
  });

  it("renders 'This machine' selected by default, plus one chip per peer", () => {
    const html = renderMachineFieldHtml(
      { machineId: null },
      { self: null, peers: [PEER_ONLINE] },
    );
    const el = mount(html);
    const chips = el.querySelectorAll(".machine-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toBe("This machine");
    expect(chips[0].classList.contains("sel")).toBe(true);
    expect(chips[1].textContent).toBe("Mac Mini");
    expect(chips[1].classList.contains("sel")).toBe(false);
  });

  it("uses the resolved self label instead of the literal fallback when present", () => {
    const html = renderMachineFieldHtml({ machineId: null }, { self: SELF, peers: [PEER_ONLINE] });
    const el = mount(html);
    expect(el.querySelector(".machine-chip.sel").textContent).toBe("This machine");
  });

  it("renders an offline peer chip disabled with an 'is offline' tip", () => {
    const html = renderMachineFieldHtml({ machineId: null }, { self: SELF, peers: [PEER_OFFLINE] });
    const el = mount(html);
    const chip = el.querySelectorAll(".machine-chip")[1];
    expect(chip.classList.contains("machine-chip--offline")).toBe(true);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("data-tip")).toBe("Old Laptop is offline");
  });

  it("marks the currently-selected peer chip .sel", () => {
    const html = renderMachineFieldHtml(
      { machineId: "peer-1" },
      { self: SELF, peers: [PEER_ONLINE] },
    );
    const el = mount(html);
    const chips = el.querySelectorAll(".machine-chip");
    expect(chips[0].classList.contains("sel")).toBe(false);
    expect(chips[1].classList.contains("sel")).toBe(true);
  });
});

describe("attachMachineFieldHandlers", () => {
  it("fires onChange with the peer id on click, and back to null for 'This machine'", () => {
    const state = { machineId: null };
    const html = renderMachineFieldHtml(state, { self: SELF, peers: [PEER_ONLINE] });
    const el = mount(html);
    const onChange = vi.fn();
    attachMachineFieldHandlers(el, state, onChange);

    const peerChip = el.querySelectorAll(".machine-chip")[1];
    peerChip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("peer-1");
    expect(state.machineId).toBe("peer-1");

    // Re-render reflecting the new selection, re-attach (mirrors the real
    // caller's re-render-then-reattach loop), then pick "This machine" back.
    const html2 = renderMachineFieldHtml(state, { self: SELF, peers: [PEER_ONLINE] });
    el.innerHTML = html2;
    attachMachineFieldHandlers(el, state, onChange);
    const selfChip = el.querySelectorAll(".machine-chip")[0];
    selfChip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(state.machineId).toBe(null);
  });

  it("never wires a click/keydown handler onto a disabled (offline) chip", () => {
    const state = { machineId: null };
    const html = renderMachineFieldHtml(state, { self: SELF, peers: [PEER_OFFLINE] });
    const el = mount(html);
    const onChange = vi.fn();
    attachMachineFieldHandlers(el, state, onChange);

    const offlineChip = el.querySelectorAll(".machine-chip")[1];
    offlineChip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(state.machineId).toBe(null);
  });

  it("Enter/Space on a focusable chip activates it same as a click", () => {
    const state = { machineId: null };
    const html = renderMachineFieldHtml(state, { self: SELF, peers: [PEER_ONLINE] });
    const el = mount(html);
    const onChange = vi.fn();
    attachMachineFieldHandlers(el, state, onChange);

    const peerChip = el.querySelectorAll(".machine-chip")[1];
    peerChip.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("peer-1");
  });
});
