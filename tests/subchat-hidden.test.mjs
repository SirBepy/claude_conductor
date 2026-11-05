// A hidden sub is told apart from every other chat by `subchat_of` alone. It
// is not a Jarvis worker (`worker_of`): the two have different wake rules, and
// the lists that hide one must not accidentally hide, or fail to hide, the other.

import { describe, it, expect } from "vitest";
import { isSubchat, isJarvisOrWorker } from "../src/views/sessions/sessions-helpers.ts";

describe("isSubchat", () => {
  it("is true only for a row with a parent main chat", () => {
    expect(isSubchat({ subchat_of: "main-1" })).toBe(true);
    expect(isSubchat({ subchat_of: null })).toBe(false);
    expect(isSubchat({})).toBe(false);
  });

  it("is independent of the Jarvis helper", () => {
    expect(isJarvisOrWorker({ subchat_of: "main-1" })).toBe(false);
    expect(isSubchat({ worker_of: "jarvis", subchat_of: null })).toBe(false);
    expect(isSubchat({ jarvis: true, subchat_of: null })).toBe(false);
  });

  it("a finished sub is still a sub", () => {
    expect(isSubchat({ subchat_of: "main-1", subchat_finished: true })).toBe(true);
  });
});
