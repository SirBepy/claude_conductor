// @vitest-environment jsdom
// asserts: src/views/sessions/subchat-view.ts
// Opening a sub over the main chat remembers where the main chat was scrolled, and
// going back puts it there unless it sat at the bottom (chat-scroll's own limit, so
// "pinned" means the same here as for the transcript's follow-along).

import { describe, it, expect, beforeEach, vi } from "vitest";

let onOpen;
vi.mock("../src/shared/transport.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  getTransport: () => ({ listen: async (_name, cb) => { onOpen = cb; return () => {}; } }),
}));

import { installSubchatRequestListeners, backToMain } from "../src/views/sessions/subchat-view.ts";
import { SCROLL_BOTTOM_THRESHOLD } from "../src/shared/chat/chat-scroll.ts";
import { state } from "../src/views/sessions/state.ts";

function mountMessages(distanceFromBottom) {
  document.body.innerHTML = '<div id="session-pane"><div class="session-messages"></div></div>';
  const el = document.querySelector(".session-messages");
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  el.scrollTop = 2000 - 500 - distanceFromBottom;
  return el;
}

async function leaveAndReturn(distanceFromBottom) {
  const el = mountMessages(distanceFromBottom);
  const remembered = el.scrollTop;
  state.sessions = [{ session_id: "s1", subchat_of: "main" }];
  state.selectedId = "main";
  const nav = { open: vi.fn(async () => {}), reopen: vi.fn(async () => {}) };
  await installSubchatRequestListeners(nav);
  onOpen({ display_session_id: "main", sub_id: "s1" });
  el.scrollTop = 0;
  await backToMain({ session_id: "s1", subchat_of: "main" }, nav);
  return { el, remembered };
}

describe("main chat scroll across a sub opened over it", () => {
  beforeEach(() => { state.sessions = []; state.selectedId = null; });

  it("restores a scroll position left above the bottom threshold", async () => {
    const { el, remembered } = await leaveAndReturn(SCROLL_BOTTOM_THRESHOLD + 1);
    expect(el.scrollTop).toBe(remembered);
  });

  it("leaves a chat pinned to the bottom (within the threshold) for the pane's own re-pin", async () => {
    const { el } = await leaveAndReturn(SCROLL_BOTTOM_THRESHOLD);
    expect(el.scrollTop).toBe(0);
  });
});
