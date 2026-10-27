// @vitest-environment jsdom

// The transcript registers its file-ref context-menu handler on the whole chat
// container. On a phone a long-press fires `contextmenu`, and preventDefault on
// it suppresses the system selection / Copy menu, so the handler must leave
// every event that is not over a file chip untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => true }));

const { linkifyFilePaths, handleFileRefContextMenu } = await import("../src/shared/chat/file-refs.ts");

let container;
beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.className = "session-messages";
  container.innerHTML = `<div class="msg assistant"><p id="plain">Some plain text with <a id="lnk" href="https://example.com">a link</a> in it</p><p id="ref">/home/joe/project/a.rs</p></div>`;
  document.body.appendChild(container);
  linkifyFilePaths(container);
  container.addEventListener("contextmenu", handleFileRefContextMenu);
});

function longPress(el) {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe("contextmenu on the transcript container", () => {
  it("is not prevented over a plain message paragraph", () => {
    expect(longPress(container.querySelector("#plain")).defaultPrevented).toBe(false);
  });

  it("is not prevented over a regular link", () => {
    expect(longPress(container.querySelector("#lnk")).defaultPrevented).toBe(false);
  });

  it("is not prevented over the container itself", () => {
    expect(longPress(container).defaultPrevented).toBe(false);
  });

  it("is still prevented over a file chip, which gets its own menu", () => {
    const chip = container.querySelector(".file-ref");
    expect(chip).not.toBeNull();
    expect(longPress(chip).defaultPrevented).toBe(true);
    document.querySelectorAll(".session-more-menu").forEach((n) => n.remove());
  });
});

describe("transcript selection styles", () => {
  const css = readFileSync("src/views/sessions/sessions.css", "utf8");
  const block = /\n\.session-messages \{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("keeps text selectable and the long-press callout on, since body is user-select none", () => {
    expect(block).toMatch(/(^|[\s;])user-select:\s*text/);
    expect(block).toMatch(/-webkit-user-select:\s*text/);
    expect(block).toMatch(/-webkit-touch-callout:\s*default/);
  });
});
