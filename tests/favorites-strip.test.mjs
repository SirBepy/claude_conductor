// @vitest-environment jsdom
//
// The favourites strip shown while Ctrl+Shift is held (Joe, 2026-10-05): all 9
// slots with number, icon and name; nothing at all when no favourite is set; a
// click starts a new chat in that slot's project. It is a body-level overlay so
// it shows on every screen and above an open question card (Joe, 2026-10-30).

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

// jsdom lays nothing out, so an element's rect is whatever the test says.
function rect(el, r) {
  el.getBoundingClientRect = () => ({ left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height });
}

function mountComposer() {
  document.body.innerHTML = `<div class="composer-shell"><div class="session-composer"><textarea></textarea></div></div>`;
  rect(document.querySelector(".composer-shell"), { left: 100, top: 500, width: 700, height: 80 });
}

let favs;
beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  remote.value = false;
  modalOpen.value = false;
  favs = assignSlot(assignSlot(emptySlots(), 0, "C:/Projects/zng-app"), 2, "C:/Projects/countoff");
  favs = assignSlot(favs, 4, "C:/Projects/deleted-one");
  writeFavorites(favs);
});

describe("showFavoritesStrip", () => {
  it("renders all 9 slots, staggered left to right", () => {
    mountComposer();
    showFavoritesStrip(() => {});
    const strip = document.body.querySelector(":scope > .favorites-strip");
    expect(strip).not.toBeNull();
    const tiles = strip.querySelectorAll(".pp-fav-slot");
    expect(tiles).toHaveLength(9);
    expect([...tiles].map((t) => t.querySelector(".pp-num").textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(tiles[0].querySelector(".favorites-strip-name").textContent).toBe("zng-app");
    expect(tiles[0].querySelector(".pp-fav-face").textContent).toBe("Z");
    expect(tiles[1].classList.contains("is-empty")).toBe(true);
    expect([...tiles].map((t) => t.style.getPropertyValue("--slot-i"))).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("sits just above the composer box at its width", () => {
    mountComposer();
    showFavoritesStrip(() => {});
    const strip = document.querySelector(".favorites-strip");
    expect(strip.style.left).toBe("100px");
    expect(strip.style.width).toBe("700px");
    expect(strip.style.bottom).toBe("306px");
  });

  it("sits above an open question card, not under it", () => {
    mountComposer();
    const host = document.createElement("div");
    host.id = "prompt-card-host";
    host.innerHTML = `<div class="prompt-card"></div>`;
    document.body.appendChild(host);
    rect(host.querySelector(".prompt-card"), { left: 110, top: 200, width: 680, height: 300 });
    showFavoritesStrip(() => {});
    const strip = document.querySelector(".favorites-strip");
    expect(strip.style.left).toBe("110px");
    expect(strip.style.width).toBe("680px");
    expect(strip.style.bottom).toBe("606px");
  });

  it("shows with no composer on screen (no chat selected), riding the viewport bottom", () => {
    showFavoritesStrip(() => {});
    const strip = document.querySelector(".favorites-strip");
    expect(strip).not.toBeNull();
    expect(strip.style.bottom).toBe("24px");
    expect(strip.style.width).toBe("900px");
    expect(strip.style.left).toBe("150px");
  });

  it("ignores a composer that is not laid out (its view is hidden)", () => {
    document.body.innerHTML = `<div class="composer-shell"></div>`;
    rect(document.querySelector(".composer-shell"), { left: 0, top: 0, width: 0, height: 0 });
    showFavoritesStrip(() => {});
    expect(document.querySelector(".favorites-strip").style.bottom).toBe("24px");
  });

  it("names a slot whose project left the registry by its folder", () => {
    showFavoritesStrip(() => {});
    const tile = document.querySelector('.pp-fav-slot[data-slot="4"]');
    expect(tile.classList.contains("is-unresolved")).toBe(true);
    expect(tile.querySelector(".favorites-strip-name").textContent).toBe("deleted-one");
  });

  it("shows nothing when no favourite is set", () => {
    writeFavorites(emptySlots());
    showFavoritesStrip(() => {});
    expect(document.querySelector(".favorites-strip")).toBeNull();
  });

  it("shows nothing on the phone or under a modal", () => {
    remote.value = true;
    showFavoritesStrip(() => {});
    remote.value = false;
    modalOpen.value = true;
    showFavoritesStrip(() => {});
    expect(document.querySelector(".favorites-strip")).toBeNull();
  });

  it("does not stack a second strip", () => {
    showFavoritesStrip(() => {});
    showFavoritesStrip(() => {});
    expect(document.querySelectorAll(".favorites-strip")).toHaveLength(1);
  });

  it("clicking a project tile starts a new chat in that slot and hides the strip", () => {
    const onPick = vi.fn();
    showFavoritesStrip(onPick);
    document.querySelector('.pp-fav-slot[data-slot="2"]').click();
    expect(onPick).toHaveBeenCalledWith(3);
    expect(document.querySelector(".favorites-strip")).toBeNull();
  });

  it("empty and missing slots are inert", () => {
    const onPick = vi.fn();
    showFavoritesStrip(onPick);
    document.querySelector('.pp-fav-slot[data-slot="1"]').click();
    document.querySelector('.pp-fav-slot[data-slot="4"]').click();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("hideFavoritesStrip removes it", () => {
    showFavoritesStrip(() => {});
    hideFavoritesStrip();
    expect(document.querySelector(".favorites-strip")).toBeNull();
  });
});
