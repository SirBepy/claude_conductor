// @vitest-environment jsdom
//
// The Quick actions section of the Dashboard cards modal: every change saves
// through dashboard_set_pinned_actions with the card's scope, bad entries are
// refused before any call, and a backend refusal shows its line.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { card as cardView, groupSnapshot, projectSnapshot } from "./helpers/project-dashboard-fixtures.mjs";

const calls = [];
let setPinnedImpl = async (_args) => null;
let modalCards = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dashboard_snapshot") return { cards: modalCards };
    if (cmd === "dashboard_set_pinned_actions") return setPinnedImpl(args);
    return null;
  }),
}));
vi.mock("../src/shared/modal.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    modalCardSlot: () => document.getElementById("test-modal-slot"),
    presentHostCard: vi.fn(async (fn) => fn()),
    closeHostCard: vi.fn(() => { document.getElementById("test-modal-slot").replaceChildren(); }),
    setBackdropCancel: vi.fn(),
  };
});

const { openCardsModal } = await import("../src/views/sessions/project-dashboard/dash-modals.ts");

const slot = () => document.getElementById("test-modal-slot");
const pinNames = () => [...slot().querySelectorAll("[data-pd-pin]")].map((r) => r.dataset.pdPin);
const saves = () => calls.filter((c) => c.cmd === "dashboard_set_pinned_actions");
const input = () => slot().querySelector(".pd-pin-input");

function open(snap) {
  openCardsModal({ ctx: () => ({ snap }), reload: vi.fn() });
  return vi.waitFor(() => expect(slot().querySelector(".pd-pin-add")).not.toBeNull());
}

async function typeAndAdd(text, how = "button") {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  if (how === "enter") input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  else slot().querySelector(".pd-pin-btn").click();
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="test-modal-slot"></div>';
  calls.length = 0;
  setPinnedImpl = async () => null;
});

describe("Quick actions in the cards modal", () => {
  it("sits above Sections and lists the current pins in order", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a", "/b"] }));
    const heads = [...slot().querySelectorAll(".pd-msec")].map((n) => n.textContent);
    expect(heads).toEqual(["Quick actions", "Sections", "Custom cards"]);
    expect(pinNames()).toEqual(["/a", "/b"]);
  });

  it("an empty list says the recent-chats fallback shows instead", async () => {
    await open(projectSnapshot({ pinned_actions: [] }));
    expect(slot().textContent).toContain("Empty: the most-used commands from recent chats show instead.");
  });

  it("Add prefixes a missing slash and saves the project scope with the new list", async () => {
    const snap = projectSnapshot({ pinned_actions: ["/a"] });
    await open(snap);
    setPinnedImpl = async (args) => args.actions;
    await typeAndAdd("pickup");
    await vi.waitFor(() => expect(pinNames()).toEqual(["/a", "/pickup"]));
    expect(saves()).toEqual([{ cmd: "dashboard_set_pinned_actions", args: {
      scope: { kind: "project", cwd: snap.target.repos[0].cwd }, actions: ["/a", "/pickup"] } }]);
    expect(input().value).toBe("");
  });

  it("Enter adds, and a group saves under its group scope", async () => {
    const snap = groupSnapshot({ pinned_actions: [] });
    await open(snap);
    await typeAndAdd("/audit", "enter");
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].args).toEqual({ scope: { kind: "group", id: snap.target.id }, actions: ["/audit"] });
  });

  it("refuses a duplicate and /close inline, with no RPC call", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a"] }));
    await typeAndAdd("a");
    await settle();
    expect(slot().querySelector(".pd-err").textContent).toBe("/a is already pinned");
    await typeAndAdd("/close");
    await settle();
    expect(slot().querySelector(".pd-err").textContent).toBe("/close cannot be pinned");
    await typeAndAdd("close now");
    await settle();
    expect(slot().querySelector(".pd-err").textContent).toBe("/close cannot be pinned");
    expect(saves()).toHaveLength(0);
    expect(pinNames()).toEqual(["/a"]);
  });

  it("typing clears the inline refusal", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a"] }));
    await typeAndAdd("/close");
    await settle();
    expect(slot().querySelector(".pd-err")).not.toBeNull();
    input().value = "/x";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(slot().querySelector(".pd-err")).toBeNull();
  });

  it("Remove drops the row and saves the rest", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a", "/b", "/c"] }));
    setPinnedImpl = async (args) => args.actions;
    slot().querySelector('[data-pd-pin="/b"] button[title="Remove"]').click();
    await vi.waitFor(() => expect(pinNames()).toEqual(["/a", "/c"]));
    expect(saves()[0].args.actions).toEqual(["/a", "/c"]);
  });

  it("Move up and down reorder, and the ends are disabled", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a", "/b", "/c"] }));
    setPinnedImpl = async (args) => args.actions;
    const btn = (pin, title) => slot().querySelector(`[data-pd-pin="${pin}"] button[title="${title}"]`);
    expect(btn("/a", "Move up").disabled).toBe(true);
    expect(btn("/c", "Move down").disabled).toBe(true);

    btn("/c", "Move up").click();
    await vi.waitFor(() => expect(pinNames()).toEqual(["/a", "/c", "/b"]));
    expect(saves()[0].args.actions).toEqual(["/a", "/c", "/b"]);

    btn("/a", "Move down").click();
    await vi.waitFor(() => expect(pinNames()).toEqual(["/c", "/a", "/b"]));
    expect(saves()[1].args.actions).toEqual(["/c", "/a", "/b"]);
  });

  it("a backend refusal keeps the old list and shows the backend line", async () => {
    await open(projectSnapshot({ pinned_actions: ["/a"] }));
    setPinnedImpl = async () => { throw "at most 20 pinned actions"; };
    await typeAndAdd("/b");
    await vi.waitFor(() => expect(slot().querySelector(".pd-err")?.textContent).toBe("at most 20 pinned actions"));
    expect(pinNames()).toEqual(["/a"]);
    expect(input().value).toBe("/b");
  });
});

describe("custom cards in the cards modal", () => {
  it("a project's modal lists the group cards its dashboard paints, marked as group cards", async () => {
    const own = cardView("own", "Own card", { kind: "stats", items: [] }, null);
    own.config.scope = { kind: "project", cwd: "C:/Projects/conductor" };
    const shared = cardView("shared", "Clockify", { kind: "stats", items: [] }, null);
    modalCards = [own, shared];
    await open(projectSnapshot({ cards: [own, shared] }));
    await vi.waitFor(() => expect([...slot().querySelectorAll(".pd-mrow .pd-mt")].map((n) => n.textContent)).toContain("Clockify"));
    const rowOf = (title) => [...slot().querySelectorAll(".pd-mrow")].find((r) => r.querySelector(".pd-mt")?.textContent === title);
    expect(rowOf("Clockify").textContent).toContain("group card");
    expect(rowOf("Own card").textContent).not.toContain("group card");
  });

  it("a disabled card offers no Refresh, and switching it back on brings Refresh back", async () => {
    const off = cardView("off", "Paused", { kind: "stats", items: [] }, null, false);
    modalCards = [off];
    await open(groupSnapshot({ cards: [off] }));
    const row = () => [...slot().querySelectorAll(".pd-mrow")].find((r) => r.querySelector(".pd-mt")?.textContent === "Paused");
    await vi.waitFor(() => expect(row()).toBeTruthy());
    expect(row().querySelector('[title="Refresh"]')).toBeNull();
    const sw = row().querySelector(".switch input");
    sw.checked = true;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(row().querySelector('[title="Refresh"]')).not.toBeNull());
  });
});
