// @vitest-environment jsdom
// todo 1023: setNotifyEnabled persists via updateSettings, which the daemon
// refuses from the phone - the switch used to look toggleable there while
// silently failing to save. Gated at render so it's simply absent on the phone.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "get_settings") return {};
    if (cmd === "list_news") return [];
    return null;
  }),
}));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn({})),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderNewsView } = await import("../src/views/news/news.ts");

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

async function openMenu() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderNewsView(root);
  root.querySelector('[title="More"]').click();
  return { root, dispose };
}

describe("news kebab menu notify switch on the phone", () => {
  it("hides the notify switch when remote", async () => {
    remote = true;
    const { root, dispose } = await openMenu();
    expect(root.querySelector(".news-menu-toggle")).toBeNull();
    // The menu itself, and its other actions, stay reachable.
    expect(root.querySelector(".news-menu")).not.toBeNull();
    dispose();
  });

  it("shows the notify switch when not remote", async () => {
    const { root, dispose } = await openMenu();
    expect(root.querySelector(".news-menu-toggle")).not.toBeNull();
    dispose();
  });
});
