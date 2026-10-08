// @vitest-environment jsdom

// The masked secret card for the `request_secret` MCP tool. Pins
// the acceptance items the Rust half doesn't cover: the card shows what's
// asked (label/file/key) and which session asked, Save invokes
// respond_secret with exactly the typed value then clears the input
// regardless of outcome, Cancel sends no value, a durable prompt-resolved
// tears the card down, and the typed value never reaches console output or
// survives in the DOM past submit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { showSecretCard, dismissSecretCard } = await import("../src/views/sessions/permission-modal/secret-card.ts");
const { state } = await import("../src/views/sessions/state.ts");

const SECRET_VALUE = "dummy-secret-value-xyz";

function payload(overrides = {}) {
  return {
    id: "secret-1",
    session_id: "s1",
    label: "Kinetic Panel API key",
    file: "C:\\repo\\.secrets.env",
    key: "KINETIC_API_KEY",
    ...overrides,
  };
}

function card() {
  return document.getElementById("prompt-card-host");
}

function input() {
  return card()?.querySelector(".secret-card__input") ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
  state.sessions = [{ session_id: "s1", cwd: "/repo/kinetic-panel", name: "Wire up billing" }];
});

afterEach(() => {
  dismissSecretCard();
  state.sessions = [];
});

describe("showSecretCard", () => {
  it("shows the label, file, key and the asking session's display name", () => {
    showSecretCard(payload());
    const text = card().textContent;
    expect(text).toContain("Kinetic Panel API key");
    expect(text).toContain("C:\\repo\\.secrets.env");
    expect(text).toContain("KINETIC_API_KEY");
    expect(text).toContain("Wire up billing");
    expect(text).toContain("kinetic-panel");
  });

  it("falls back cleanly when the session isn't known locally", () => {
    state.sessions = [];
    showSecretCard(payload({ session_id: "ghost" }));
    expect(card().textContent).toContain("Unknown chat");
  });

  it("disables Save while the input is empty", () => {
    showSecretCard(payload());
    expect(card().querySelector('[data-act="save"]').disabled).toBe(true);
  });

  it("Save invokes respond_secret with the typed value exactly once, then clears the input", async () => {
    invokeMock.mockResolvedValue(true);
    showSecretCard(payload());
    const field = input();
    field.value = SECRET_VALUE;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(card().querySelector('[data-act="save"]').disabled).toBe(false);

    card().querySelector('[data-act="save"]').click();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("respond_secret", {
      requestId: "secret-1",
      value: SECRET_VALUE,
      cancelled: false,
    });
    // The card closes on success - nothing left to inspect, which is itself
    // the strongest "value isn't lingering" guarantee.
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it("clears the input and shows the error text (not the value) when the save fails", async () => {
    invokeMock.mockRejectedValue(new Error("file is not gitignored"));
    showSecretCard(payload());
    const field = input();
    field.value = SECRET_VALUE;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    card().querySelector('[data-act="save"]').click();

    await vi.waitFor(() => expect(card().textContent).toContain("file is not gitignored"));
    expect(card().innerHTML).not.toContain(SECRET_VALUE);
    expect(input().value).toBe("");
  });

  it("Cancel invokes respond_secret with cancelled:true and no value", async () => {
    invokeMock.mockResolvedValue(true);
    showSecretCard(payload());
    const field = input();
    field.value = "typed but abandoned";
    field.dispatchEvent(new window.Event("input", { bubbles: true }));

    card().querySelector('[data-act="cancel"]').click();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());

    expect(invokeMock).toHaveBeenCalledWith("respond_secret", {
      requestId: "secret-1",
      value: null,
      cancelled: true,
    });
    expect(card()).toBeNull();
  });

  it("Escape cancels the same way as the Cancel button", async () => {
    invokeMock.mockResolvedValue(true);
    showSecretCard(payload());
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "respond_secret",
      { requestId: "secret-1", value: null, cancelled: true },
    ));
  });

  it("a matching prompt-resolved tears the card down", () => {
    showSecretCard(payload());
    expect(card()).not.toBeNull();
    dismissSecretCard("secret-1");
    expect(card()).toBeNull();
  });

  it("a prompt-resolved for a DIFFERENT id leaves the card alone", () => {
    showSecretCard(payload());
    dismissSecretCard("some-other-id");
    expect(card()).not.toBeNull();
  });

  it("never passes the typed value to console.* ", async () => {
    invokeMock.mockResolvedValue(true);
    const consoleSpies = ["log", "info", "warn", "error", "debug"].map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    showSecretCard(payload());
    const field = input();
    field.value = SECRET_VALUE;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    card().querySelector('[data-act="save"]').click();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg) ?? "").not.toContain(SECRET_VALUE);
        }
      }
      spy.mockRestore();
    }
  });
});
