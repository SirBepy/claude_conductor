// @vitest-environment jsdom
// asserts: src/views/settings/subviews/chat-defaults/chat-defaults.ts
// The "Offload research subs" switch (pc-1782): off until Joe turns it on, writes the
// `offloadReadOnlySubs` settings key the daemon reads (subchats::remote::offload), and is
// absent on the phone, which cannot write settings.

import { describe, it, expect, vi, beforeEach } from "vitest";

let stored = {};
const updateSettings = vi.fn(async (fn) => {
  stored = fn(stored);
  return stored;
});
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => stored }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings }));
let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderChatDefaultsView } = await import(
  "../src/views/settings/subviews/chat-defaults/chat-defaults.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderChatDefaultsView(root);
  return { root, dispose };
}

beforeEach(() => {
  remote = false;
  stored = {};
  updateSettings.mockClear();
  document.body.innerHTML = "";
});

describe("offload research subs switch", () => {
  it("is off by default", async () => {
    const { root, dispose } = await mount();
    const box = root.querySelector("#chatDefaultsOffload");
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    dispose();
  });

  it("shows the stored value, and only a true one counts", async () => {
    stored = { offloadReadOnlySubs: true };
    let m = await mount();
    expect(m.root.querySelector("#chatDefaultsOffload").checked).toBe(true);
    m.dispose();
    document.body.innerHTML = "";
    stored = { offloadReadOnlySubs: "yes" };
    m = await mount();
    expect(m.root.querySelector("#chatDefaultsOffload").checked).toBe(false);
    m.dispose();
  });

  it("writes the key the daemon reads, both ways, keeping the rest of the settings", async () => {
    stored = { keep: 1 };
    const { root, dispose } = await mount();
    const box = root.querySelector("#chatDefaultsOffload");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.offloadReadOnlySubs).toBe(true));
    expect(stored.keep).toBe(1);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.offloadReadOnlySubs).toBe(false));
    dispose();
  });

  it("is not drawn on the phone", async () => {
    remote = true;
    const { root, dispose } = await mount();
    expect(root.querySelector("#chatDefaultsOffload")).toBeNull();
    dispose();
  });
});
