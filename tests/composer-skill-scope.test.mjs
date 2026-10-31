// @vitest-environment jsdom
// asserts: src/shared/chat/composer-skill-scope.ts, src/shared/chat/caret-popup/providers/slash.ts

// Per-project skill scope in the composer: a draft starting
// with a /skill scoped to other projects shows a warning, and sending it calls
// enable_skill_here (save the scope, restart the chat) before the message goes
// out. "Send anyway" skips that, and a busy chat never restarts mid-turn.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer as mountComposerBase, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

const entry = (name, off_here, extra = {}) => ({
  name,
  args: null,
  description: `${name} desc`,
  source: { kind: "user-skill" },
  path: null,
  menu_hidden: false,
  scope_key: name,
  off_here,
  ...extra,
});

let invokeMock;
let offHere;

beforeEach(() => {
  localStorage.clear();
  offHere = true;
  invokeMock = tauriMock(async (cmd) => {
    if (cmd === "list_slash_commands") {
      return [
        entry("commit", false),
        entry("figma-tiles", offHere),
        entry("figma-use", offHere, {
          source: { kind: "plugin-skill", plugin: "figma" },
          scope_key: "figma@claude-plugins-official",
        }),
      ];
    }
    if (cmd === "enable_skill_here") {
      offHere = false;
      return true;
    }
    return undefined;
  });
});

afterEach(() => {
  destroyMounted();
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

async function mount(opts = {}) {
  const r = await mountComposerBase({ projectDir: "C:/w/app", ...opts });
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_slash_commands", { projectDir: "C:/w/app" }));
  // Let the provider's first fetch land before typing.
  await new Promise((res) => setTimeout(res, 0));
  return r;
}

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function pressEnter(textarea) {
  textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

const warning = (root) => root.querySelector(".composer-scope-warning");
const enableCalls = () => invokeMock.mock.calls.filter(([c]) => c === "enable_skill_here");

describe("composer skill scope", () => {
  it("warns about an off-here skill and enables it before sending", async () => {
    const onSend = vi.fn(async () => {});
    const { root, textarea } = await mount({ onSend });

    typeInto(textarea, "/commit now");
    expect(warning(root).hidden).toBe(true);

    typeInto(textarea, "/figma-tiles export the board");
    expect(warning(root).hidden).toBe(false);
    expect(warning(root).textContent).toContain("/figma-tiles is off in this project");
    expect(warning(root).textContent).toContain("Enable here");

    pressEnter(textarea);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(enableCalls()).toEqual([
      ["enable_skill_here", { projectDir: "C:/w/app", key: "figma-tiles", sessionId: "sess-1" }],
    ]);
    // The scope was saved before the message left, not after.
    const enableAt = invokeMock.mock.invocationCallOrder[invokeMock.mock.calls.findIndex(([c]) => c === "enable_skill_here")];
    expect(enableAt).toBeLessThan(onSend.mock.invocationCallOrder[0]);
    expect(warning(root).hidden).toBe(true);
  });

  it("names the whole plugin for a plugin skill", async () => {
    const { root, textarea } = await mount();
    typeInto(textarea, "/figma:figma-use read it");
    expect(warning(root).textContent).toContain("turns on the whole figma plugin");
    pressEnter(textarea);
    await vi.waitFor(() => expect(enableCalls().length).toBe(1));
    expect(enableCalls()[0][1].key).toBe("figma@claude-plugins-official");
  });

  it("Send anyway sends without enabling", async () => {
    const onSend = vi.fn(async () => {});
    const { root, textarea } = await mount({ onSend });
    typeInto(textarea, "/figma-tiles x");
    const anyway = [...warning(root).querySelectorAll("button")].find((b) => b.textContent === "Send anyway");
    anyway.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(enableCalls()).toEqual([]);
  });

  // "Send anyway" used to park a flag for the next send() to read; when send()
  // returned early (disabled) the flag survived and silently skipped the scope
  // check on the user's NEXT, unrelated send.
  it("a Send anyway that never reached send() does not skip the check on the next send", async () => {
    const onSend = vi.fn(async () => {});
    let offline = null;
    const { composer, root, textarea } = await mount({ onSend, isOffline: () => offline });
    typeInto(textarea, "/figma-tiles x");
    // The host drops after the warning is up, so the click lands on a disabled composer.
    offline = "host offline";
    composer.refreshOfflineState();
    const anyway = [...warning(root).querySelectorAll("button")].find((b) => b.textContent === "Send anyway");
    anyway.click();
    await new Promise((res) => setTimeout(res, 20));
    expect(onSend).not.toHaveBeenCalled();
    // The host comes back; a plain Enter must still enable the skill first.
    offline = null;
    composer.refreshOfflineState();
    pressEnter(textarea);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(enableCalls().length).toBe(1);
  });

  it("does not restart a busy chat, and keeps the draft", async () => {
    const onSend = vi.fn(async () => {});
    const onStage = vi.fn(() => true);
    const { root, textarea } = await mount({ onSend, onStage, isBusy: () => true });
    typeInto(textarea, "/figma-tiles x");
    pressEnter(textarea);
    await new Promise((res) => setTimeout(res, 20));
    expect(enableCalls()).toEqual([]);
    expect(onSend).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/figma-tiles x");
    expect(root.querySelector(".composer-notice").textContent).toContain("once this turn finishes");
  });

  it("keeps the draft when enabling fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "list_slash_commands") return [entry("figma-tiles", true)];
      if (cmd === "enable_skill_here") throw "not_a_project: C:/w/app";
      return [];
    });
    const onSend = vi.fn(async () => {});
    const { root, textarea } = await mount({ onSend });
    typeInto(textarea, "/figma-tiles x");
    pressEnter(textarea);
    await vi.waitFor(() => expect(root.querySelector(".composer-notice").textContent).toContain("Couldn't enable /figma-tiles"));
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/figma-tiles x");
  });
});

describe("slash popup", () => {
  it("lists off-here skills last, tagged", async () => {
    const { resetTransportForTests } = await import("../src/shared/transport.ts");
    resetTransportForTests();
    const { SlashProvider } = await import("../src/shared/chat/caret-popup/providers/slash.ts");
    const p = new SlashProvider();
    await p.start("C:/w/app");
    const rows = p.query("/fig");
    expect(rows.map((e) => e.name).sort()).toEqual(["figma-tiles", "figma-use"]);
    expect(rows.every((e) => e.off_here)).toBe(true);
    const mixed = p.query("/");
    expect(mixed[mixed.length - 1].off_here).toBe(true);
    expect(mixed[0].off_here).toBe(false);
    const row = p.renderRow(rows[0], false);
    expect(row.classList.contains("off-here")).toBe(true);
    expect(row.querySelector(".off-here-tag").textContent).toBe("off in this project");
    p.stop();
  });
});
