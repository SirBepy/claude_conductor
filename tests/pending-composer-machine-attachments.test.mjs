// @vitest-environment jsdom

// Red->green regression: a new chat aimed at a paired machine (the new-chat
// picker's machine chip) uploads its attachments under a `pending-*` placeholder
// id that no machine's chat list contains. The upload used to land on THIS
// machine's disk, and the peer's `claude` was handed that dead local path. The
// pending composer must name its target machine on every attachment call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

let invoke;

beforeEach(() => {
  localStorage.clear();
  invoke = tauriMock((cmd) => {
    if (cmd === "paste_attachment") return "/peer/chat-attachments/pending-1-ab/u.png";
    if (cmd === "paste_attachment_from_path") {
      return { path: "/peer/chat-attachments/pending-1-ab/u.png", mime: "image/png", base64: "iVBO" };
    }
    if (cmd === "read_attachment") return { mime: "image/png", base64: "iVBO" };
    return undefined;
  });
});

afterEach(() => {
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

const callsTo = (cmd) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);

describe("composer attachments for a chat aimed at another machine", () => {
  it("passes the machine id to paste_attachment and paste_attachment_from_path", async () => {
    const { composer } = await mountComposer({ getMachineId: () => "mach-win" }, "pending-1-ab");

    await composer.dropFiles([new File([PNG], "shot.png", { type: "image/png" })]);
    await composer.attachFromPath("/Users/me/Desktop/shot.png");

    expect(callsTo("paste_attachment")).toHaveLength(1);
    expect(callsTo("paste_attachment")[0]).toMatchObject({ sessionId: "pending-1-ab", machineId: "mach-win" });
    expect(callsTo("paste_attachment_from_path")).toHaveLength(1);
    expect(callsTo("paste_attachment_from_path")[0]).toMatchObject({
      sessionId: "pending-1-ab",
      path: "/Users/me/Desktop/shot.png",
      machineId: "mach-win",
    });
  });

  it("re-reads a persisted attachment from the target machine", async () => {
    const { saveAttachmentsMeta } = await import("../src/shared/chat/composer-persistence.ts");
    saveAttachmentsMeta("pending-1-ab", [
      { path: "/peer/chat-attachments/pending-1-ab/u.png", mime: "image/png", filename: "u.png" },
    ]);
    await mountComposer({ getMachineId: () => "mach-win" }, "pending-1-ab");

    await vi.waitFor(() => expect(callsTo("read_attachment")).toHaveLength(1));
    expect(callsTo("read_attachment")[0]).toMatchObject({
      path: "/peer/chat-attachments/pending-1-ab/u.png",
      machineId: "mach-win",
    });
  });

  it("sends no machine id for a composer on this machine", async () => {
    const { composer } = await mountComposer({}, "sess-local");
    await composer.dropFiles([new File([PNG], "shot.png", { type: "image/png" })]);
    await composer.attachFromPath("/tmp/shot.png");

    expect(callsTo("paste_attachment")[0]).not.toHaveProperty("machineId");
    expect(callsTo("paste_attachment_from_path")[0]).not.toHaveProperty("machineId");

    const nullMachine = await mountComposer({ getMachineId: () => null }, "sess-local-2");
    await nullMachine.composer.dropFiles([new File([PNG], "b.png", { type: "image/png" })]);
    expect(callsTo("paste_attachment").at(-1)).not.toHaveProperty("machineId");
  });
});

describe("wirePendingComposer", () => {
  it("hands the pane's target machine to the composer's attachment calls", async () => {
    const { resetTransportForTests } = await import("../src/shared/transport.ts");
    resetTransportForTests();
    const { wirePendingComposer } = await import("../src/views/sessions/pending-pane-composer.ts");
    const { state } = await import("../src/views/sessions/state.ts");

    const pane = document.createElement("div");
    pane.innerHTML = '<div class="session-composer"></div>';
    document.body.appendChild(pane);
    wirePendingComposer(
      pane,
      "pending-1-ab",
      { path: "C:\\proj", name: "proj" },
      { model: "opus", effort: "high", machineId: "mach-win" },
      state.mountId,
      { rebindPaneHeader: () => {} },
    );
    try {
      await state.composer.attachFromPath("/Users/me/Desktop/shot.png");
      expect(callsTo("paste_attachment_from_path")[0]).toMatchObject({
        sessionId: "pending-1-ab",
        machineId: "mach-win",
      });
    } finally {
      state.composer.destroy();
      state.composer = null;
    }
  });
});
