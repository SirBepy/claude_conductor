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
});
