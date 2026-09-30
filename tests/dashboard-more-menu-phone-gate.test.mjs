// @vitest-environment jsdom
// todo 1023: "Edit dashboard" and "Add: <widget>" both persist the widget
// layout via updateSettings, which the daemon refuses from the phone - gated
// out of the kebab menu there so neither looks like a working control.

import { describe, it, expect, vi, beforeEach } from "vitest";

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { wireDashMoreMenu } = await import("../src/views/dashboard/dashboard-more-menu.ts");

beforeEach(() => { remote = false; document.body.innerHTML = ""; });

function mountRoot() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="menu-anchor">
      <button id="dashMoreBtn"></button>
      <div class="menu-popover hidden" id="dashMoreMenu"></div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function baseDeps(overrides = {}) {
  return {
    isEditMode: () => false,
    onToggleEditMode: vi.fn(),
    triggerRefresh: vi.fn(async () => {}),
    getDashboardWidgets: () => [{ id: "today", enabled: false }],
    enableWidget: vi.fn(),
    ...overrides,
  };
}

describe("dashboard kebab menu on the phone", () => {
  it("hides 'Edit dashboard' and 'Add: <widget>' when remote", () => {
    remote = true;
    const root = mountRoot();
    wireDashMoreMenu(root, baseDeps());
    root.querySelector("#dashMoreBtn").click();
    const menu = root.querySelector("#dashMoreMenu");
    expect(menu.querySelector('[data-act="toggle-edit"]')).toBeNull();
    expect(menu.querySelector('[data-act="add-widget"]')).toBeNull();
    // Refresh now is not a settings write - stays reachable.
    expect(menu.querySelector('[data-act="refresh"]')).not.toBeNull();
  });

  it("shows 'Edit dashboard' and 'Add: <widget>' when not remote", () => {
    const root = mountRoot();
    wireDashMoreMenu(root, baseDeps());
    root.querySelector("#dashMoreBtn").click();
    const menu = root.querySelector("#dashMoreMenu");
    expect(menu.querySelector('[data-act="toggle-edit"]')).not.toBeNull();
    expect(menu.querySelector('[data-act="add-widget"]')).not.toBeNull();
  });
});
