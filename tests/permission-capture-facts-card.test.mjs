// @vitest-environment jsdom
// asserts: src/views/sessions/permission-modal/capture-facts.ts

// The approval card for `capture_secret_from_page` draws the page, the element and its text
// length open, because a hostile page can offer look-alike elements and the details dump is
// collapsed. The page words some of those fields, so they must come out escaped.

import { describe, it, expect } from "vitest";
import { captureFactsHtml, CAPTURE_TOOL } from "../src/views/sessions/permission-modal/capture-facts.ts";

const INPUT = {
  label: "OVH client secret",
  file: "C:\\chat\\.env.ovh",
  key: "OVH_SECRET",
  element: "#client-secret",
  page: "https://console.example.com/keys",
  found: '<input id="client-secret" type="password">',
  length: 27,
  temporary: false,
};

describe("captureFactsHtml", () => {
  it("draws the page, the element, the length, the file and the key as visible rows", () => {
    const host = document.createElement("div");
    host.innerHTML = captureFactsHtml(INPUT);
    const rows = [...host.querySelectorAll(".prompt-card__fact")].map((r) => [r.querySelector("dt").textContent, r.querySelector("dd").textContent]);
    expect(rows).toEqual([
      ["Save", "OVH client secret"],
      ["Page", "https://console.example.com/keys"],
      ["Element", '<input id="client-secret" type="password">'],
      ["Length", "27 characters"],
      ["Into file", "C:\\chat\\.env.ovh"],
      ["As key", "OVH_SECRET"],
    ]);
  });

  it("escapes page-worded fields so they cannot add markup to the card", () => {
    const host = document.createElement("div");
    host.innerHTML = captureFactsHtml({ ...INPUT, found: '<img src=x onerror=alert(1)>', page: '"><script>x</script>' });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says a temporary save is removed again, and draws nothing for an empty input", () => {
    const host = document.createElement("div");
    host.innerHTML = captureFactsHtml({ ...INPUT, temporary: true });
    expect(host.querySelector(".prompt-card__fact-note").textContent).toMatch(/removed again/);
    expect(captureFactsHtml(undefined)).toBe("");
  });

  it("names the same tool the gating rule keys on", () => {
    expect(CAPTURE_TOOL).toBe("mcp__cc_conductor__capture_secret_from_page");
  });
});
