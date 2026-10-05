// @vitest-environment jsdom
//
// The favourites strip shown in the composer while Ctrl+Shift is held (Joe,
// 2026-10-05): all 9 slots with number, icon and name; nothing at all when no
// favourite is set; a click starts a new chat in that slot's project.

import { describe, it, expect, beforeEach, vi } from "vitest";

const remote = { value: false };
const modalOpen = { value: false };
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.value }));
vi.mock("../src/shared/modal-input-lock.ts", () => ({ isAnyModalOpen: () => modalOpen.value }));
vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  projectGroupsData: () => ({
    cached: [
      { path: "C:/Projects/zng-app", name: "zng-app", avatar: { kind: "emoji", value: "Z" } },
      { path: "C:/Projects/countoff", name: "countoff", avatar: { kind: "emoji", value: "C" } },
    ],
    ready: Promise.resolve([]),
  }),
}));

const { showFavoritesStrip, hideFavoritesStrip } = await import("../src/views/sessions/favorites-strip.ts");
const { writeFavorites, emptySlots, assignSlot } = await import("../src/views/sessions/project-favorites.ts");

function mountPane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="composer-shell"><div class="session-thinking" hidden></div><div class="session-composer"><textarea></textarea></div></div>`;
  document.body.replaceChildren(pane);
  return pane;
}

let favs;
beforeEach(() => {
  localStorage.clear();
  remote.value = false;
  modalOpen.value = false;
  favs = assignSlot(assignSlot(emptySlots(), 0, "C:/Projects/zng-app"), 2, "C:/Projects/countoff");
  favs = assignSlot(favs, 4, "C:/Projects/deleted-one");
  writeFavorites(favs);
});

describe("showFavoritesStrip", () => {
  it("renders all 9 slots inside the composer box, above the input", () => {
    const pane = mountPane();
    showFavoritesStrip(pane, () => {});
    const strip = pane.querySelector(".composer-shell > .favorites-strip");
    expect(strip).not.toBeNull();
    expect(strip.nextElementSibling.classList.contains("session-composer")).toBe(true);
    const tiles = strip.querySelectorAll(".pp-fav-slot");
    expect(tiles).toHaveLength(9);
    expect([...tiles].map((t) => t.querySelector(".pp-num").textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(tiles[0].querySelector(".favorites-strip-name").textContent).toBe("zng-app");
    expect(tiles[0].querySelector(".pp-fav-face").textContent).toBe("Z");
    expect(tiles[1].classList.contains("is-empty")).toBe(true);
  });

  it("names a slot whose project left the registry by its folder", () => {
    const pane = mountPane();
    showFavoritesStrip(pane, () => {});
    const tile = pane.querySelector('.pp-fav-slot[data-slot="4"]');
    expect(tile.classList.contains("is-unresolved")).toBe(true);
    expect(tile.querySelector(".favorites-strip-name").textContent).toBe("deleted-one");
  });

  it("shows nothing when no favourite is set", () => {
    writeFavorites(emptySlots());
    const pane = mountPane();
    showFavoritesStrip(pane, () => {});
    expect(pane.querySelector(".favorites-strip")).toBeNull();
  });

  it("shows nothing on the phone or under a modal", () => {
    const pane = mountPane();
    remote.value = true;
    showFavoritesStrip(pane, () => {});
    remote.value = false;
    modalOpen.value = true;
    showFavoritesStrip(pane, () => {});
    expect(pane.querySelector(".favorites-strip")).toBeNull();
  });

  it("does not stack a second strip", () => {
    const pane = mountPane();
    showFavoritesStrip(pane, () => {});
    showFavoritesStrip(pane, () => {});
    expect(pane.querySelectorAll(".favorites-strip")).toHaveLength(1);
  });

  it("clicking a project tile starts a new chat in that slot and hides the strip", () => {
    const pane = mountPane();
    const onPick = vi.fn();
    showFavoritesStrip(pane, onPick);
    pane.querySelector('.pp-fav-slot[data-slot="2"]').click();
    expect(onPick).toHaveBeenCalledWith(3);
    expect(pane.querySelector(".favorites-strip")).toBeNull();
  });

  it("empty and missing slots are inert", () => {
    const pane = mountPane();
    const onPick = vi.fn();
    showFavoritesStrip(pane, onPick);
    pane.querySelector('.pp-fav-slot[data-slot="1"]').click();
    pane.querySelector('.pp-fav-slot[data-slot="4"]').click();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("hideFavoritesStrip removes it", () => {
    const pane = mountPane();
    showFavoritesStrip(pane, () => {});
    hideFavoritesStrip(pane);
    expect(pane.querySelector(".favorites-strip")).toBeNull();
  });
});
