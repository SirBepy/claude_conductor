// asserts: src/shared/chat/chat-kinds.ts

// The kinds table is the one list the Plan card draws from and per-role model routing keys on,
// and the daemon stores a kind on every sub's brief: the two lists must not drift apart.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const { CHAT_KINDS, CHAT_KIND_INFO, normalizeKind, kindFromName, guessKind } = await import("../src/shared/chat/chat-kinds.ts");

const rust = readFileSync(new URL("../src-tauri/src/daemon/subchats/kind.rs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the kinds table", () => {
  it("lists the same ids, in the same order, as the daemon's kind.rs", () => {
    const list = /pub const KINDS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1] ?? "";
    expect([...list.matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual([...CHAT_KINDS]);
  });

  it("gives every kind a Phosphor icon and a label, and no two kinds share an icon", () => {
    const icons = CHAT_KINDS.map((k) => CHAT_KIND_INFO[k].icon);
    expect(new Set(icons).size).toBe(CHAT_KINDS.length);
    for (const k of CHAT_KINDS) expect(CHAT_KIND_INFO[k].label.length).toBeGreaterThan(0);
    expect(CHAT_KIND_INFO.build.icon).toBe("code");
    expect(CHAT_KIND_INFO.gate.icon).toBe("git-merge");
  });

  it("reads the name aliases the daemon reads", () => {
    const body = /const ALIASES: \[[^\]]*\] = \[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const pairs = [...body.matchAll(/\("([a-z0-9]+)", "([a-z]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBeGreaterThan(5);
    for (const [word, kind] of pairs) expect(kindFromName(word), word).toBe(kind);
  });
});

describe("naming a kind", () => {
  it("normalizes spelling and refuses a stray word", () => {
    expect(normalizeKind(" Build ")).toBe("build");
    expect(normalizeKind("builder")).toBeNull();
    expect(normalizeKind(undefined)).toBeNull();
    expect(normalizeKind("")).toBeNull();
  });

  it("takes the earliest whole word of a name that names a kind", () => {
    expect(kindFromName("review-merged-card")).toBe("review");
    expect(kindFromName("Fix: pairing retry")).toBe("fix");
    expect(kindFromName("plan-review")).toBe("plan");
    expect(kindFromName("builder-x")).toBeNull();
  });

  it("guesses an errand for a name that says nothing, until the stored kind is read", () => {
    expect(guessKind("header tweaks")).toBe("errand");
    expect(guessKind("gate 2")).toBe("gate");
  });
});
