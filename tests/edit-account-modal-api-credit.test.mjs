// @vitest-environment jsdom

// An API-credit account is never a project binding and never fleet-eligible
// (the backend refuses both), so its Edit modal draws neither the Projects tab
// nor the fleet toggle. A subscription account keeps both.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: { listProjects: vi.fn(async () => []) } }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/views/sessions/project-picker.ts", () => ({ pickProject: vi.fn() }));

const { openEditAccountModal } = await import("../src/views/settings/subviews/accounts/edit-account-modal.ts");

const base = {
  id: "acct-1",
  label: "Personal",
  icon: "user",
  colour: "#9d7dfc",
  email: "a@x.test",
  fleet_eligible: false,
};

afterEach(() => {
  document.querySelectorAll(".aem-overlay").forEach((el) => el.remove());
});

describe("openEditAccountModal - account kind", () => {
  it("shows the Projects tab and the fleet toggle for a subscription account", () => {
    void openEditAccountModal({ ...base, kind: "subscription" });
    expect(document.querySelector('.aem-tab[data-tab="projects"]')).not.toBeNull();
    expect(document.querySelector("#aem-fleet-eligible")).not.toBeNull();
  });

  it("shows both for an account with no kind (older daemon)", () => {
    void openEditAccountModal({ ...base });
    expect(document.querySelector('.aem-tab[data-tab="projects"]')).not.toBeNull();
    expect(document.querySelector("#aem-fleet-eligible")).not.toBeNull();
  });

  it("hides the Projects tab and the fleet toggle for an API-credit account", () => {
    void openEditAccountModal({ ...base, kind: "api_credit" });
    expect(document.querySelector(".aem-tabs")).toBeNull();
    expect(document.querySelector('.aem-tab[data-tab="projects"]')).toBeNull();
    expect(document.querySelector("#aem-fleet-eligible")).toBeNull();
    // The label and appearance fields are still editable.
    expect(document.querySelector("#aem-label")).not.toBeNull();
    expect(document.querySelector("#aem-save-btn")).not.toBeNull();
  });
});
