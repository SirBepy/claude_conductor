// @vitest-environment jsdom

// Terse-but-drillable send_message bubbles: `[x](#d:id)` + `details` becomes a
// chip that opens the body; a later message resolves an id it does not define.

import { describe, it, expect, beforeEach } from "vitest";

const { renderMessage } = await import("../src/shared/chat/chat-transforms.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");
const { handleToolUseEvent } = await import("../src/shared/chat/chat-event-handler-tools.ts");
const { linkifyDrillRefs, handleDrillClick } = await import("../src/shared/chat/drill-links.ts");

const DETAILS = [{ id: "ign", label: "23 ignored tickets", body_md: "- #23 Flaky login\n- #41 **Slow** page" }];

function bubble(text, details) {
  return { kind: "message", text, id: "t", ts: 1, parentToolUseId: null, details };
}
function mount(...msgs) {
  const root = document.createElement("div");
  root.innerHTML = msgs.map((m) => renderMessage(m)).join("");
  document.body.appendChild(root);
  root.addEventListener("click", handleDrillClick);
  linkifyDrillRefs(root, root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("drill chips", () => {
  it("renders a chip and opens the detail body in a popover on click", () => {
    const root = mount(bubble("There were [23 ignored tickets](#d:ign).", DETAILS));
    const chip = root.querySelector("button.drill-chip");
    expect(chip.textContent).toBe("23 ignored tickets");
    expect(root.querySelector("a")).toBeNull();
    chip.click();
    const pop = document.querySelector(".drill-pop");
    expect(pop.textContent).toContain("Flaky login");
    expect(pop.querySelector("strong").textContent).toBe("Slow");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    chip.click();
    expect(document.querySelector(".drill-pop")).toBeNull();
  });

  it("opens the card inside its own bubble, one at a time, closed by its button or Esc", () => {
    const root = mount(bubble("a [t](#d:ign)", DETAILS), bubble("b [t](#d:ign)", undefined));
    const [c1, c2] = root.querySelectorAll("button.drill-chip");
    c1.click();
    expect(c1.closest(".msg").querySelector(".drill-pop .drill-pop-title").textContent).toBe("23 ignored tickets");
    c2.click();
    expect(document.querySelectorAll(".drill-pop").length).toBe(1);
    expect(c2.closest(".msg").querySelector(".drill-pop")).not.toBeNull();
    expect(c1.getAttribute("aria-expanded")).toBe("false");
    document.querySelector(".drill-pop-close").click();
    expect(document.querySelector(".drill-pop")).toBeNull();
    c1.click();
    document.querySelector(".drill-pop").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".drill-pop")).toBeNull();
  });

  it("resolves an id defined by an earlier message, not a later one", () => {
    const root = mount(
      bubble("[tickets](#d:ign)", [{ id: "ign", label: "old", body_md: "old body" }]),
      bubble("again [tickets](#d:ign)", [{ id: "ign", label: "new", body_md: "new body" }]),
      bubble("ref [the tickets](#d:ign)", undefined),
      bubble("late def", [{ id: "ign", label: "later", body_md: "later body" }]),
    );
    const chips = root.querySelectorAll("button.drill-chip");
    expect(chips.length).toBe(3);
    chips[2].click();
    expect(document.querySelector(".drill-pop").textContent).toContain("new body");
    expect(document.querySelector(".drill-pop").textContent).not.toContain("later body");
  });

  it("renders an unknown id as plain label text", () => {
    const root = mount(bubble("see [mystery](#d:nope) here", undefined));
    expect(root.querySelector(".drill-chip")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("see mystery here");
  });

  it("leaves an ordinary markdown link alone", () => {
    const root = mount(bubble("[docs](https://example.com/x) and [top](#section)", DETAILS));
    expect(root.querySelectorAll("a").length).toBe(2);
    expect(root.querySelector(".drill-chip")).toBeNull();
  });
});

describe("re-resolving and clearing", () => {
  it("upgrades a plain-text ref to a chip once its definition is loaded above", () => {
    const root = mount(bubble("see [tickets](#d:ign)", undefined));
    expect(root.querySelector(".drill-chip")).toBeNull();
    expect(root.textContent).toContain("see tickets");
    const def = document.createElement("div");
    def.innerHTML = renderMessage(bubble("defs", DETAILS));
    root.insertBefore(def.firstElementChild, root.firstChild);
    linkifyDrillRefs(root, root);
    expect(root.querySelector("button.drill-chip").textContent).toBe("tickets");
    expect(root.querySelector(".drill-pending")).toBeNull();
  });

  it("an empty details list on update_message clears earlier details, an absent one keeps them", () => {
    const r = { messages: [], dirtyIndices: new Set(), _updateMsgToolUseIds: new Set() };
    handleToolUseEvent(r, { type: "tool_use", id: "tu1", tool_name: "mcp__cc_conductor__send_message", parent_tool_use_id: null, input: { text: "x", details: DETAILS } }, 1);
    const upd = { type: "tool_use", parent_tool_use_id: null, tool_name: "mcp__cc_conductor__update_message" };
    handleToolUseEvent(r, { ...upd, id: "tu2", input: { message: 1, text: "y" } }, 2);
    expect(r.messages[0].details).toEqual(DETAILS);
    handleToolUseEvent(r, { ...upd, id: "tu3", input: { message: 1, text: "z", details: [] } }, 3);
    expect(r.messages[0].details).toEqual([]);
    expect(renderMessage(r.messages[0])).not.toContain("data-details");
  });
});

describe("details mapping", () => {
  const ev = { type: "tool_use", id: "tu1", tool_name: "mcp__cc_conductor__send_message", parent_tool_use_id: null, input: { text: "x [a](#d:ign)", details: DETAILS } };

  it("survives the scrollback mapping", () => {
    expect(eventToRenderedMessage(ev).details).toEqual(DETAILS);
  });

  it("survives the live mapping and update_message keeps or replaces them", () => {
    const r = { messages: [], dirtyIndices: new Set(), _updateMsgToolUseIds: new Set() };
    handleToolUseEvent(r, ev, 1);
    expect(r.messages[0].details).toEqual(DETAILS);
    const upd = { type: "tool_use", id: "tu2", tool_name: "mcp__cc_conductor__update_message", parent_tool_use_id: null, input: { message: 1, text: "y" } };
    handleToolUseEvent(r, upd, 2);
    expect(r.messages[0].text).toBe("y");
    expect(r.messages[0].details).toEqual(DETAILS);
    const repl = [{ id: "ign", label: "n", body_md: "nb" }];
    handleToolUseEvent(r, { ...upd, id: "tu3", input: { message: 1, text: "z", details: repl } }, 3);
    expect(r.messages[0].details).toEqual(repl);
  });
});
