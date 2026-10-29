// @vitest-environment jsdom
//
// refreshAuthorRowTexts swaps the wake placeholder in an already-rendered
// peer-message strip for the real channel text, using only the DOM: the fold
// marker lists each run's authors in row order.

import { describe, it, expect } from "vitest";

const { refreshAuthorRowTexts } = await import("../src/shared/chat/author-message-group.ts");

function stripWithRows(marker, rowCount) {
  const host = document.createElement("div");
  host.dataset.authoredFoldMarker = marker;
  const bucket = document.createElement("div");
  bucket.className = "tool-strip-group author-group-panel";
  bucket.dataset.tool = "peer-msgs";
  bucket.innerHTML = Array.from(
    { length: rowCount },
    () => `<div class="author-group-row"><div class="author-group-row-body"><div class="author-group-row-text">wake placeholder</div></div></div>`,
  ).join("");
  const panel = document.createElement("div");
  panel.appendChild(bucket);
  host.appendChild(panel);
  const container = document.createElement("div");
  container.appendChild(host);
  return container;
}

const post = (session_id, text) => ({ id: text, session_id, author: session_id, text, posted_at: "2026-10-29T00:00:00Z" });

describe("refreshAuthorRowTexts", () => {
  it("gives each row its author's next real post, in channel order", () => {
    const container = stripWithRows("m1:alice|m2:bob|m3:alice", 3);
    refreshAuthorRowTexts(container, [post("alice", "first"), post("bob", "only"), post("alice", "second")]);
    const texts = [...container.querySelectorAll(".author-group-row-text")].map((el) => el.textContent);
    expect(texts).toEqual(["first", "only", "second"]);
  });

  it("shows the aged-out note for a row with no surviving post", () => {
    const container = stripWithRows("m1:alice|m2:alice", 2);
    refreshAuthorRowTexts(container, [post("alice", "kept")]);
    const texts = [...container.querySelectorAll(".author-group-row-text")].map((el) => el.textContent);
    expect(texts[0]).toBe("kept");
    expect(texts[1]).toContain("aged out");
  });

  it("reads the author after the LAST colon of an entry, since a message id can contain one", () => {
    const container = stripWithRows("msg:1:alice", 1);
    refreshAuthorRowTexts(container, [post("alice", "hello")]);
    expect(container.querySelector(".author-group-row-text").textContent).toBe("hello");
  });
});
