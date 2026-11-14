// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/quick-view.ts

// The Project memory read view renders MEMORY.md, whose entries are relative
// links (`[x](feedback_x.md)`). A click on one used to load that path into the
// app's own webview (pc-1746): it must open the file inside the dialog instead,
// and a link that names no file must go nowhere.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { openQuickView, closeQuickView } = await import("../src/views/sessions/chat-dashboard/quick-view.ts");
const { installExternalLinkInterceptor } = await import("../src/shared/external-links.ts");
installExternalLinkInterceptor();

const DATA = {
  view: "memory",
  title: "Project memory",
  message: "",
  docs: [
    { name: "MEMORY.md", body: "- [Fact A](a.md) - first\n- [Fact B](./sub/B.md#top) - second\n- [Gone](missing.md)\n- [Home](/index.html)" },
    { name: "a.md", body: "# Fact A\nbody a" },
    { name: "B.md", body: "# Fact B\nbody b" },
  ],
};

function click(el) {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("Project memory links", () => {
  beforeEach(() => {
    closeQuickView();
    document.body.innerHTML = "";
    openQuickView(DATA);
  });

  const link = (text) => [...document.querySelectorAll(".cdash-qvm-doc a")].find((a) => a.textContent === text);

  it("opens a linked memory file inside the dialog", () => {
    const ev = click(link("Fact A"));
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector(".cdash-qvm-doc").textContent).toContain("body a");
    expect(document.querySelector(".cdash-qvm-file.on").textContent).toBe("a.md");
  });

  it("matches the file name through a relative path and a fragment, ignoring case", () => {
    click(link("Fact B"));
    expect(document.querySelector(".cdash-qvm-doc").textContent).toContain("body b");
  });

  it("a link naming no file leaves the dialog as it was and never navigates", () => {
    for (const text of ["Gone", "Home"]) {
      const ev = click(link(text));
      expect(ev.defaultPrevented, text).toBe(true);
      expect(document.querySelector(".cdash-qvm-file.on").textContent).toBe("MEMORY.md");
    }
  });
});
