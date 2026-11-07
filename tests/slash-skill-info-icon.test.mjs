// @vitest-environment jsdom

// A user-skill or plugin-skill row of the "/" menu carries a small info icon
// that opens that skill's detail through the shared opener. A row click still
// picks; the icon must neither pick nor leave the menu open over the page it
// navigated to. Commands and builtins have no detail page, so no icon.

import { describe, it, expect, vi, beforeEach } from "vitest";

const entry = (name, source) => ({ name, args: null, description: `${name} desc`, source, path: null, menu_hidden: false });
const ENTRIES = [
  entry("mine", { kind: "user-skill" }),
  entry("brainstorm", { kind: "plugin-skill", plugin: "plug" }),
  entry("localskill", { kind: "project-skill" }),
  entry("mycmd", { kind: "user-command" }),
  entry("help", { kind: "builtin" }),
];
vi.mock("../src/shared/ipc.ts", () => ({ invoke: async () => ENTRIES }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: async () => () => {} }) }));
const openSkillDetail = vi.fn();
vi.mock("../src/shared/open-skill-detail.ts", () => ({ openSkillDetail: (s) => openSkillDetail(s) }));

const { SlashProvider } = await import("../src/shared/chat/caret-popup/providers/slash.ts");
const { CaretSuggestPopup } = await import("../src/shared/chat/caret-popup/popup.ts");

async function openMenu() {
  document.body.innerHTML = "";
  const anchor = document.createElement("div");
  const ta = document.createElement("textarea");
  anchor.appendChild(ta);
  document.body.appendChild(anchor);
  const provider = new SlashProvider();
  await provider.start(null);
  const popup = new CaretSuggestPopup({ anchor, textarea: ta, providers: [provider] });
  ta.value = "/";
  ta.setSelectionRange(1, 1);
  popup.handleInput();
  return { popup, ta, anchor };
}

const rowOf = (anchor, head) =>
  [...anchor.querySelectorAll(".caret-popup .row")].find((r) => r.querySelector(".head").textContent.startsWith(head));

beforeEach(() => openSkillDetail.mockClear());

describe("slash menu skill info icon", () => {
  it("renders on user-skill and plugin-skill rows only", async () => {
    const { anchor } = await openMenu();
    expect(rowOf(anchor, "/mine").querySelector(".skill-info")).not.toBeNull();
    expect(rowOf(anchor, "/plug:brainstorm").querySelector(".skill-info")).not.toBeNull();
    expect(rowOf(anchor, "/localskill").querySelector(".skill-info")).toBeNull();
    expect(rowOf(anchor, "/mycmd").querySelector(".skill-info")).toBeNull();
    expect(rowOf(anchor, "/help").querySelector(".skill-info")).toBeNull();
  });

  it("is a Phosphor icon in a labelled button", async () => {
    const { anchor } = await openMenu();
    const btn = rowOf(anchor, "/mine").querySelector(".skill-info");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.querySelector("i.ph.ph-info")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBeTruthy();
  });

  it("a click opens that skill's detail (plugin skills by their qualified name) without picking, and closes the menu", async () => {
    const { anchor, ta, popup } = await openMenu();
    const btn = rowOf(anchor, "/plug:brainstorm").querySelector(".skill-info");
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(openSkillDetail).toHaveBeenCalledWith("plug:brainstorm"));
    expect(openSkillDetail).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe("/");
    expect(popup.isOpen()).toBe(false);
  });

  it("a user skill opens by its bare name", async () => {
    const { anchor } = await openMenu();
    const btn = rowOf(anchor, "/mine").querySelector(".skill-info");
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(openSkillDetail).toHaveBeenCalledWith("mine"));
  });

  it("a press on the icon keeps the textarea focus target (default prevented) and does not pick", async () => {
    const { anchor, ta } = await openMenu();
    const btn = rowOf(anchor, "/mine").querySelector(".skill-info");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(ta.value).toBe("/");
  });

  it("a row press still picks the skill", async () => {
    const { anchor, ta, popup } = await openMenu();
    rowOf(anchor, "/mine").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ta.value).toBe("/mine ");
    expect(popup.isOpen()).toBe(false);
    expect(openSkillDetail).not.toHaveBeenCalled();
  });
});
