// @vitest-environment jsdom

// stripUrlParam is the one place that rewrites the address bar for the phone's
// boot params (`pair`, `token`, `shellv`).

import { describe, it, expect, beforeEach, vi } from "vitest";

const { stripUrlParam } = await import("../src/shared/url-params.ts");

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("stripUrlParam", () => {
  it("removes the named param and keeps the path, other params and hash", () => {
    history.replaceState(null, "", "/app/?pair=abc&x=1#top");
    stripUrlParam("pair");
    expect(location.pathname).toBe("/app/");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#top");
  });

  it("leaves no dangling ? when the stripped param was the only one", () => {
    history.replaceState(null, "", "/?token=abc");
    stripUrlParam("token");
    expect(location.href.endsWith("/")).toBe(true);
    expect(location.search).toBe("");
  });

  it("does not touch history when the param is absent", () => {
    history.replaceState(null, "", "/?x=1");
    const spy = vi.spyOn(history, "replaceState");
    stripUrlParam("pair");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
