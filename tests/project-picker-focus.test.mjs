// @vitest-environment jsdom
//
// A narrow desktop window has a mouse, so the picker still focuses its search
// field on open; only a touch phone skips it (the keyboard would pop before
// the sheet finished opening). Same rule as the chat composer's open-time focus.

import { describe, it, expect, vi } from "vitest";

Element.prototype.scrollIntoView ??= () => {};

vi.mock("../src/shared/mobile-viewport.ts", async (orig) => ({
  ...(await orig()),
  isMobileViewport: () => true, // a narrow window
  isTouchPhone: () => false, // with a mouse
}));
vi.mock("../src/shared/api.ts", () => ({
  api: { listMachines: vi.fn().mockResolvedValue({ self: { machine_id: "self", label: "PC", os: "windows" }, peers: [] }) },
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/shared/projects.ts", () => ({
  renderAvatar: () => "",
  hydrateCharacterAvatars: async () => {},
  hydrateProjectTechIcons: async () => {},
}));
vi.mock("../src/views/sessions/project-picker/favorites-rail.ts", () => ({
  renderFavoriteRail: () => "",
  renderFavoriteHint: () => "",
  positionFavoriteHint: () => {},
  startFavoriteDrag: () => {},
}));
vi.mock("../src/views/sessions/project-picker/add-project.ts", () => ({ renderNoMatches: () => "" }));
vi.mock("../src/views/sessions/location-picker.ts", () => ({
  openLocationModal: vi.fn(async () => null),
  resolveRememberedLocation: (p) => ({ path: p.path, name: p.name }),
}));
vi.mock("../src/views/sessions/restore-focus.ts", () => ({ restoreFocus: () => {} }));

const { openProjectPickerModal } = await import("../src/views/sessions/project-picker.ts");

describe("openProjectPickerModal open-time focus", () => {
  it("focuses the search field in a narrow window that is not a touch phone", async () => {
    document.body.innerHTML = "";
    void openProjectPickerModal([], Promise.resolve([]));
    await vi.waitFor(() => {
      expect(document.querySelector("#project-picker-search")).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector("#project-picker-search"));
    });
  });
});
