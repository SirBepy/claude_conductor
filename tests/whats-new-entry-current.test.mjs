// asserts: src/changelog/entries.ts

// The in-app "What's new" panel must announce every release that shipped. The
// panel auto-opens only when an entry's version equals the version the app just
// updated to, so a release whose entry was forgotten is simply never announced
// (0.2.155 and 0.2.156 shipped that way, 2026-11-19). This test fails when the
// newest entry in src/changelog/entries.ts is older than the newest released
// version git can see: the latest `VERSION: x.y.z` commit subject or the newest
// `tauri-v*` tag. The entry is committed BEFORE the VERSION bump, so a release
// in progress passes. How to write the entry: docs/architecture/release-shape.md
// (What's new section).
//
// It skips (never fails) where git cannot answer: no git binary, no repository,
// a shallow checkout (CI clones with depth 1, the release history is cut off),
// or no VERSION commit or tag in sight. Offline is fine: nothing here fetches.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { ENTRIES } = await import("../src/changelog/entries.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Versions whose release had NO visible change, so no entry was written on purpose.
 *  Add the version here (with a reason) instead of inventing a card. A newer entry
 *  also covers every older release, so this stays empty most of the time. */
const NO_ENTRY_ON_PURPOSE = [];

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The newest released version git can read, or null where it cannot say. */
function newestReleased() {
  try {
    if (git("rev-parse", "--is-shallow-repository") !== "false") return null;
    const found = [];
    for (const subject of git("log", "--format=%s", "--grep=^VERSION: ").split("\n")) {
      const v = parse(subject.replace(/^VERSION:\s*/, "").trim());
      if (v) found.push(v);
    }
    for (const tag of git("tag", "--list", "tauri-v*").split("\n")) {
      const v = parse(tag.replace(/^tauri-v/, "").trim());
      if (v) found.push(v);
    }
    return found.length ? found.sort(cmp).at(-1) : null;
  } catch {
    return null;
  }
}

const released = newestReleased();
const newestEntry = parse(ENTRIES[0]?.version ?? "");

describe("What's new has an entry for the newest release", () => {
  it("the newest entry has a readable version", () => {
    expect(newestEntry, `ENTRIES[0].version is ${JSON.stringify(ENTRIES[0]?.version)}`).not.toBeNull();
  });

  it.skipIf(released === null)("is not older than the newest released version", () => {
    const releasedText = released.join(".");
    const skipped = NO_ENTRY_ON_PURPOSE.map(parse).some((v) => v && cmp(v, released) === 0);
    expect(
      skipped || cmp(newestEntry, released) >= 0,
      `The newest What's new entry is v${ENTRIES[0].version} but v${releasedText} already shipped, so that release was ` +
        `never announced in the app. Add an entry at the TOP of ENTRIES in src/changelog/entries.ts (pictures in ` +
        `src/changelog/img/<version>/) BEFORE the VERSION: commit, as docs/architecture/release-shape.md describes ` +
        `(What's new section). A release with no visible change goes in NO_ENTRY_ON_PURPOSE in this test instead.`,
    ).toBe(true);
  });
});
