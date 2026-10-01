// @vitest-environment jsdom

// Todo 1043: the add/replace API key modal. Pins the acceptance items that
// aren't covered by cargo (the .env rewrite itself is Rust-side): the modal
// shows name/path/purpose before saving, Save calls set_api_key with the
// typed value, the input is cleared right after a successful save, the typed
// value never survives into the rendered DOM past that point, and a backend
// error surfaces as text instead of silently failing.

import { describe, it, expect, vi, afterEach } from "vitest";

const { listApiKeys, setApiKey } = vi.hoisted(() => ({
  listApiKeys: vi.fn(),
  setApiKey: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listApiKeys: (...a) => listApiKeys(...a),
    setApiKey: (...a) => setApiKey(...a),
  },
}));

const { openApiKeyModal } = await import("../src/shared/api-key-modal.ts");

const STATUS_UNSET = {
  env_name: "SHORTCUT_API_TOKEN",
  label: "Shortcut API token",
  purpose: "Lets ticket mentions in chat resolve title/state/owner.",
  used_by: "Ticket hover cards",
  create_url: "https://app.shortcut.com/settings/account/api-tokens",
  is_set: false,
  save_path: "C:\\Users\\tecno\\.claude\\.env",
};

const STATUS_SET = { ...STATUS_UNSET, is_set: true };

function overlay() {
  return document.querySelector(".aikm-overlay");
}

afterEach(() => {
  document.querySelectorAll(".aikm-overlay").forEach((el) => el.remove());
  listApiKeys.mockReset();
  setApiKey.mockReset();
});

describe("openApiKeyModal", () => {
  it("shows the key's env name, save path and purpose before saving", async () => {
    listApiKeys.mockResolvedValue([STATUS_UNSET]);
    const pending = openApiKeyModal("SHORTCUT_API_TOKEN");
    await vi.waitFor(() => expect(overlay()?.textContent).toContain(STATUS_UNSET.env_name));
    const text = overlay().textContent;
    expect(text).toContain(STATUS_UNSET.save_path);
    expect(text).toContain(STATUS_UNSET.purpose);
    expect(text).toContain("Not set");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBe(false);
  });

  it("shows a 'create one' link to create_url", async () => {
    listApiKeys.mockResolvedValue([STATUS_UNSET]);
    const pending = openApiKeyModal("SHORTCUT_API_TOKEN");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    const link = overlay().querySelector(".aikm-create-link");
    expect(link?.getAttribute("href")).toBe(STATUS_UNSET.create_url);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await pending;
  });

  it("Save calls set_api_key with the typed value, clears the input, and never leaves the value in the DOM", async () => {
    listApiKeys.mockResolvedValue([STATUS_UNSET]);
    setApiKey.mockResolvedValue(STATUS_SET);
    const pending = openApiKeyModal("SHORTCUT_API_TOKEN");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());

    const input = overlay().querySelector("#aikm-value");
    input.value = "sk-super-secret-123";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    overlay().querySelector(".aikm-save-btn").click();
    await vi.waitFor(() => expect(setApiKey).toHaveBeenCalledWith("SHORTCUT_API_TOKEN", "sk-super-secret-123"));

    await vi.waitFor(() => expect(overlay().textContent).toContain("Set"));
    expect(overlay().innerHTML).not.toContain("sk-super-secret-123");
    expect(overlay().querySelector("#aikm-value").value).toBe("");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBe(true); // a save happened before close
  });

  it("surfaces the backend's error text on a failed save, and keeps the typed value in state (not cleared)", async () => {
    listApiKeys.mockResolvedValue([STATUS_UNSET]);
    setApiKey.mockRejectedValue(new Error("could not write ~/.claude/.env: permission denied"));
    const pending = openApiKeyModal("SHORTCUT_API_TOKEN");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());

    const input = overlay().querySelector("#aikm-value");
    input.value = "sk-abc";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    overlay().querySelector(".aikm-save-btn").click();

    await vi.waitFor(() => expect(overlay().textContent).toContain("permission denied"));
    expect(overlay().textContent).not.toContain("Saved");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBe(false); // no successful save happened
  });

  it("resolves false on Escape/backdrop close without ever calling set_api_key", async () => {
    listApiKeys.mockResolvedValue([STATUS_UNSET]);
    const pending = openApiKeyModal("SHORTCUT_API_TOKEN");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBe(false);
    expect(setApiKey).not.toHaveBeenCalled();
  });
});
