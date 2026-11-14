// @vitest-environment jsdom

// A phone page left open across a PC update must reload once onto the new
// build, never loop, and never while the user holds unsent text.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const stream = vi.hoisted(() => ({ opens: new Set() }));
vi.mock("../src/shared/global-stream.ts", () => ({
  onGlobalStreamOpen: (fn) => {
    stream.opens.add(fn);
    return () => stream.opens.delete(fn);
  },
}));
vi.mock("../src/shared/link-journal.ts", () => ({ note: vi.fn() }));

const bc = await import("../src/shared/build-check.ts");

const reload = vi.fn();
const fetchMock = vi.fn();

function stamp(id) {
  document.head.innerHTML = id ? `<meta name="cc-build" content="${id}">` : "";
}
function daemonSays(build) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, build }) });
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  reload.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", { configurable: true, value: { reload } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  stream.opens.clear();
});

describe("buildVerdict", () => {
  const base = { pageBuild: "A", daemonBuild: "B", reloadedTo: null, busy: false };
  it("reloads when the daemon serves another build", () => {
    expect(bc.buildVerdict(base)).toBe("reload");
  });
  it("stays when the builds match or either is unknown", () => {
    expect(bc.buildVerdict({ ...base, daemonBuild: "A" })).toBe("stay");
    expect(bc.buildVerdict({ ...base, pageBuild: null })).toBe("stay");
    expect(bc.buildVerdict({ ...base, daemonBuild: null })).toBe("stay");
  });
  it("defers while a message box holds text", () => {
    expect(bc.buildVerdict({ ...base, busy: true })).toBe("defer");
  });
  it("never reloads twice onto the same build", () => {
    expect(bc.buildVerdict({ ...base, reloadedTo: "B" })).toBe("stay");
  });
});

describe("checkBuildOnce", () => {
  it("a page from build A against a daemon serving build B reloads once and records B", async () => {
    stamp("A");
    daemonSays("B");
    expect(await bc.checkBuildOnce()).toBe("reload");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(bc.RELOADED_TO_KEY)).toBe("B");
    // The reloaded page still reads A (a proxy kept the old page): no second reload.
    expect(await bc.checkBuildOnce()).toBe("stay");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while the composer holds unsent text, and does once it is empty", async () => {
    stamp("A");
    daemonSays("B");
    document.body.innerHTML = `<textarea class="composer-textarea"></textarea>`;
    const box = document.querySelector("textarea");
    box.value = "half a thought";
    expect(await bc.checkBuildOnce()).toBe("defer");
    expect(reload).not.toHaveBeenCalled();
    box.value = "";
    expect(await bc.checkBuildOnce()).toBe("reload");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("defers while a contenteditable editor holds text", async () => {
    stamp("A");
    daemonSays("B");
    document.body.innerHTML = `<div contenteditable="true">draft in progress</div>`;
    expect(await bc.checkBuildOnce()).toBe("defer");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing on a page served without a stamp", async () => {
    stamp(null);
    daemonSays("B");
    expect(await bc.checkBuildOnce()).toBe("stay");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreachable health probe changes nothing", async () => {
    stamp("A");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await bc.checkBuildOnce()).toBe("stay");
    expect(reload).not.toHaveBeenCalled();
  });

  it("mountBuildCheck compares on every stream open", async () => {
    stamp("A");
    daemonSays("B");
    bc.mountBuildCheck();
    expect(stream.opens.size).toBe(1);
    for (const fn of stream.opens) fn();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
