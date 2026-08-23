// @vitest-environment jsdom

// The ⋮ (#viewMoreBtn) kept vanishing from the Chats header: mobile-header-
// merge.ts relocates the LIVE button, and its remembered desktop home was
// recorded once, so a view re-render (Chats -> Dashboard -> Chats) filed the
// fresh button away into the previous, detached .view-header.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyHeaderMerge } from "../src/views/sessions/mobile-header-merge.ts";

function setViewport(isMobile) {
  window.matchMedia = () => ({
    matches: isMobile,
    addEventListener() {},
    removeEventListener() {},
  });
}

/** One sessions-view render: a fresh .view-header holding both buttons. */
function renderView(tag) {
  document.body.innerHTML = `
    <div class="view view-sessions">
      <div class="view-header">
        <button class="icon-btn burger"></button>
        <button class="icon-btn sessions-back" id="sessionsBackBtn"></button>
        <h2>Chats</h2>
        <button class="icon-btn more-btn" id="viewMoreBtn"></button>
      </div>
      <main class="session-pane" id="session-pane"></main>
    </div>`;
  // Identity marker: the merge must move nodes, never re-create them, or the
  // click listeners bound at mount are lost.
  document.getElementById("viewMoreBtn").dataset.render = tag;
  return document.querySelector("#session-pane");
}

/** What active-session.ts's selectSession does: wipe the pane, then rebuild a
 *  .session-header with the two relocation slots. */
function rebuildPane(pane) {
  pane.innerHTML = `
    <header class="session-header">
      <span class="session-header-lead"></span>
      <div class="session-header-text"></div>
      <span class="session-header-trail"></span>
    </header>
    <div class="session-messages"></div>`;
}

beforeEach(() => setViewport(false));
afterEach(() => { document.body.innerHTML = ""; });

describe("desktop", () => {
  it("keeps the ⋮ in the live header across a view re-render", () => {
    renderView("first");
    applyHeaderMerge();

    // Chats -> Dashboard -> Chats: lit rebuilds the whole view.
    renderView("second");
    applyHeaderMerge();

    const more = document.getElementById("viewMoreBtn");
    expect(more?.dataset.render).toBe("second");
    expect(more?.closest(".view-header")?.isConnected).toBe(true);
  });

  it("leaves both buttons in the view-header when there is no pane header", () => {
    renderView("first");
    applyHeaderMerge();
    expect(document.querySelector(".view-header > #viewMoreBtn")).not.toBeNull();
    expect(document.querySelector(".view-header > #sessionsBackBtn")).not.toBeNull();
  });
});

describe("mobile", () => {
  it("relocates both buttons into the pane header's slots", () => {
    setViewport(true);
    const pane = renderView("first");
    rebuildPane(pane);
    applyHeaderMerge();

    expect(document.querySelector(".session-header-trail > #viewMoreBtn")).not.toBeNull();
    expect(document.querySelector(".session-header-lead > #sessionsBackBtn")).not.toBeNull();
  });

  it("survives the pane rebuild that destroys the header it was moved into", () => {
    setViewport(true);
    const pane = renderView("first");
    rebuildPane(pane);
    applyHeaderMerge();

    // Selecting another chat wipes the pane - and with it the relocated nodes.
    rebuildPane(pane);
    applyHeaderMerge();

    const more = document.querySelector(".session-header-trail > #viewMoreBtn");
    expect(more).not.toBeNull();
    expect(more.dataset.render).toBe("first");
  });

  it("hands the buttons back to the view-header when the viewport widens", () => {
    setViewport(true);
    const pane = renderView("first");
    rebuildPane(pane);
    applyHeaderMerge();

    setViewport(false);
    applyHeaderMerge();

    const more = document.querySelector(".view-header > #viewMoreBtn");
    expect(more).not.toBeNull();
    expect(more.dataset.render).toBe("first");
  });
});
