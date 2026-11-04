// @vitest-environment jsdom

// A `/skill` mention in a chat message opens that skill's detail through the
// one shared opener (open-skill-detail.ts), so every skill link sets the
// target and routes the same way. A detached chat window never navigates.

import { describe, it, expect, vi, beforeEach } from "vitest";

const openSkillDetail = vi.fn();
vi.mock("../src/shared/open-skill-detail.ts", () => ({ openSkillDetail: (s) => openSkillDetail(s) }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn() }));

const { handleSlashClick } = await import("../src/shared/chat/chat-click-handlers.ts");

function clickOn(html) {
  document.body.innerHTML = html;
  const target = document.body.querySelector("[data-test-target]");
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "target", { value: target });
  handleSlashClick(ev);
  return ev;
}

describe("handleSlashClick", () => {
  beforeEach(() => {
    openSkillDetail.mockClear();
    window.location.hash = "";
  });

  it("opens the mentioned skill through the shared opener and swallows the click", () => {
    const ev = clickOn(`<span class="slash-mention" data-skill-target="plug:brainstorm" data-test-target>/brainstorm</span>`);
    expect(openSkillDetail).toHaveBeenCalledWith("plug:brainstorm");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores a mention that has no skill detail (a command or builtin)", () => {
    clickOn(`<span class="slash-mention" data-test-target>/help</span>`);
    expect(openSkillDetail).not.toHaveBeenCalled();
  });

  it("does not navigate from a detached chat window", () => {
    window.location.hash = "#detached?session=abc";
    clickOn(`<span class="slash-mention" data-skill-target="brainstorm" data-test-target>/brainstorm</span>`);
    expect(openSkillDetail).not.toHaveBeenCalled();
  });
});
