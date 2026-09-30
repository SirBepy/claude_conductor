// @vitest-environment jsdom
// todo 1023: both the per-rule Remove button and "Clear all rules" button
// persist via updateSettings, which the daemon refuses from the phone -
// hidden there so the list stays readable but not falsely editable.

import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = { projectPermissionRules: { "/proj": ["Bash::echo hi"] } };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => (cmd === "get_settings" ? settings : null)),
}));
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => fn(settings)),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderPermissionsView } = await import(
  "../src/views/settings/subviews/permissions/permissions.ts"
);

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

describe("permissions screen on the phone", () => {
  it("hides the remove and clear-all buttons when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderPermissionsView(root);
    expect(root.querySelector('[data-act="remove"]')).toBeNull();
    expect(root.querySelector('[data-act="clear-all"]')).toBeNull();
    // The rule itself stays visible/readable.
    expect(root.querySelector(".perm-rule")).not.toBeNull();
  });

  it("shows the remove and clear-all buttons when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderPermissionsView(root);
    expect(root.querySelector('[data-act="remove"]')).not.toBeNull();
    expect(root.querySelector('[data-act="clear-all"]')).not.toBeNull();
  });
});
