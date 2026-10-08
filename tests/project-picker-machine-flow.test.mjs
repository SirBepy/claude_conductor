// @vitest-environment jsdom
//
// G8 (docs/multi-machine.md): the phone can now reach the machine chip row
// (project-picker.ts's old `!isRemote()` gate on listMachines() is lifted),
// so picking a peer's chip then one of its projects must thread that peer's
// machine_id through to the picker's resolved value - the same contract H4
// already proved for desktop. The Playwright phone-sheet spec covers the
// rendered layout at 390px; this covers the resolved value, since
// project-picker.ts exposes no DOM for an e2e spec to read mid-chain (the
// result only surfaces once the whole model/effort -> launch chain finishes).

import { describe, it, expect, vi } from "vitest";

// jsdom has no layout, so no scrollIntoView (project-picker.ts's selected-row
// keyboard-nav scroll calls it on every render).
Element.prototype.scrollIntoView ??= () => {};

const SELF = { machine_id: "self", label: "Joe-PC", os: "windows" };
const PEER = {
  machine_id: "peer-1", label: "Mac Mini", os: "macos",
  iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0,
  reach: "direct",
};
const PEER_PROJECT = { id: "peer-proj-1", path: "C:/PeerProjects/widget", name: "widget" };

const listMachines = vi.fn().mockResolvedValue({ self: SELF, peers: [PEER] });
const listMachineProjects = vi.fn().mockResolvedValue([PEER_PROJECT]);
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listMachines: (...a) => listMachines(...a),
    listMachineProjects: (...a) => listMachineProjects(...a),
  },
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

vi.mock("../src/views/sessions/project-picker/add-project.ts", () => ({
  renderNoMatches: () => "",
}));

vi.mock("../src/views/sessions/location-picker.ts", () => ({
  openLocationModal: vi.fn(async () => null),
  resolveRememberedLocation: (p) => ({ path: p.path, name: p.name }),
}));

vi.mock("../src/views/sessions/restore-focus.ts", () => ({ restoreFocus: () => {} }));

const { openProjectPickerModal } = await import("../src/views/sessions/project-picker.ts");

describe("openProjectPickerModal / peer machine project pick (G8)", () => {
  it("resolves PickedProject.machineId with the picked peer's id, not the local machine's", async () => {
    document.body.innerHTML = "";
    const resultPromise = openProjectPickerModal([], Promise.resolve([]));

    // Self + one peer chip, once list_machines() (now reachable from both
    // platforms) resolves and the picker re-renders.
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".machine-chip").length).toBe(2);
    });
    const chips = document.querySelectorAll(".machine-chip");
    expect(chips[0].textContent).toBe("Joe-PC");
    expect(chips[1].textContent).toBe("Mac Mini");

    chips[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(listMachineProjects).toHaveBeenCalledWith("peer-1");

    await vi.waitFor(() => {
      expect(document.querySelector(".project-picker-row")).not.toBeNull();
    });
    document.querySelector(".project-picker-row")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const result = await resultPromise;
    expect(result).toEqual({
      path: PEER_PROJECT.path,
      name: PEER_PROJECT.name,
      machineId: "peer-1",
    });
  });
});
