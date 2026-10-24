// @vitest-environment jsdom
// asserts: src/shared/remote-voiceline.ts, src/views/settings/subviews/notifications/notifications.ts
// Per-phone "Play sounds on this phone": a localStorage switch that exists only
// on the phone and stops playVoiceline before it fetches any audio.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));
let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});
const invoke = vi.fn(async () => null);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const { renderNotificationsView } = await import("../src/views/settings/subviews/notifications/notifications.ts");
const { playVoiceline, PHONE_SOUNDS_KEY } = await import("../src/shared/remote-voiceline.ts");

beforeEach(() => { remote = false; document.body.innerHTML = ""; localStorage.clear(); invoke.mockClear(); });

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderNotificationsView(root);
  return root;
}

describe("This phone section", () => {
  it("renders only when remote, first on the page, default on", async () => {
    remote = true;
    const root = await mount();
    const sw = root.querySelector("#phoneSoundsSwitch");
    expect(sw).not.toBeNull();
    expect(sw.checked).toBe(true);
    expect(root.querySelector(".kit-section").id).toBe("phoneSoundsSection");
    expect(root.querySelector(".kit-section-title").textContent).toBe("This phone");
  });

  it("is absent on the desktop", async () => {
    const root = await mount();
    expect(root.querySelector("#phoneSoundsSwitch")).toBeNull();
    expect(root.querySelector("#phoneSoundsSection")).toBeNull();
  });

  it("writes the per-phone key when flipped", async () => {
    remote = true;
    const root = await mount();
    const sw = root.querySelector("#phoneSoundsSwitch");
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    expect(localStorage.getItem(PHONE_SOUNDS_KEY)).toBe("off");
  });
});

describe("playVoiceline", () => {
  it("does not resolve audio while the phone is muted", async () => {
    localStorage.setItem(PHONE_SOUNDS_KEY, "off");
    await playVoiceline({ awaiting: "done", session_id: "s1" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("resolves audio by default and re-reads the key on every fire", async () => {
    await playVoiceline({ awaiting: "done", session_id: "s1" });
    expect(invoke).toHaveBeenCalledWith("resolve_voiceline", expect.objectContaining({ awaiting: "done" }));
    invoke.mockClear();
    localStorage.setItem(PHONE_SOUNDS_KEY, "off");
    await playVoiceline({ awaiting: "question" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
