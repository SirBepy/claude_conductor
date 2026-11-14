// @vitest-environment jsdom

// The global link interceptor swallows every external tap. On the desktop the
// URL opens through the daemon's open_external; on the phone that would open it
// on the PC, so the phone's own browser must get it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { openExternal, remote } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}), remote: { value: false } }));
vi.mock("../src/shared/api.ts", () => ({ api: { openExternal } }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.value }));

const { installExternalLinkInterceptor } = await import("../src/shared/external-links.ts");
installExternalLinkInterceptor();

function tap(href) {
  const a = document.createElement("a");
  a.href = href;
  a.setAttribute("href", href);
  document.body.appendChild(a);
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  return ev;
}

describe("external link interceptor", () => {
  let open;
  beforeEach(() => {
    delete window.ConductorLinks;
    openExternal.mockClear();
    open = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("desktop: hands the URL to open_external and never opens a window", () => {
    remote.value = false;
    const ev = tap("https://example.com/x");
    expect(ev.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
    expect(open).not.toHaveBeenCalled();
  });

  it("phone: opens the URL in the phone's own browser, not on the PC", () => {
    remote.value = true;
    const ev = tap("https://play.google.com/apps/internaltest/1");
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://play.google.com/apps/internaltest/1", "_blank", "noopener");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("phone: prefers the Android shell bridge over window.open when it exists", () => {
    remote.value = true;
    const bridge = vi.fn();
    window.ConductorLinks = { openExternal: bridge };
    const ev = tap("https://example.com/y");
    expect(ev.defaultPrevented).toBe(true);
    expect(bridge).toHaveBeenCalledWith("https://example.com/y");
    expect(open).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("phone: a file: link is swallowed and opens nothing", () => {
    remote.value = true;
    const bridge = vi.fn();
    window.ConductorLinks = { openExternal: bridge };
    const ev = tap("file:///C:/Users/joe/notes.txt");
    expect(ev.defaultPrevented).toBe(true);
    expect(bridge).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  // Markdown `[x](notes.md)` rendered anywhere in the app would otherwise load
  // that path into the app's own webview with no way back (pc-1746).
  it("cancels a relative link so the main frame never navigates", () => {
    for (const href of ["feedback_x.md", "./a.md#top", "/old/dashboard.html", "../up.md", "C:\\proj\\notes.md", "C:/proj/notes.md"]) {
      expect(tap(href).defaultPrevented, href).toBe(true);
    }
    expect(openExternal).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves in-page fragments and download links alone", () => {
    expect(tap("#section").defaultPrevented).toBe(false);
    const a = document.createElement("a");
    a.setAttribute("href", "report.csv");
    a.setAttribute("download", "");
    document.body.appendChild(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
