// Locks the shape of .github/workflows/tauri-release.yml's checks: the cargo
// `test` job and the vitest `test-frontend` job run in PARALLEL (neither needs
// the other), and `tag` waits on every check. Before the split, vitest was a
// step of `test`, so it ran after the ~21 min cargo test and kept `tag` waiting
// ~14 min after the Windows build finished. A rename, a `needs` edge between
// the two, or a dropped gate would silently undo that or ship a release without
// a check. No YAML dependency: the workflow's job blocks are cut by indentation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../.github/workflows/tauri-release.yml", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Top-level jobs: name -> block text (everything up to the next 2-space job key). */
function jobs() {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out = {};
  let name = null;
  for (const line of body.split("\n")) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      name = m[1];
      out[name] = "";
    } else if (name && !/^\s*#/.test(line)) {
      // Comments dropped: the ones above a job sit at the end of the previous
      // block and would make a prose mention of "vitest" look like a step.
      out[name] += line + "\n";
    }
  }
  return out;
}

/** The job's own `needs:` list (4-space indent), inline or block form. */
function needs(block) {
  const inline = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(block);
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(block);
  if (single) return [single[1]];
  const list = /^ {4}needs:\s*\n((?: {6}- .*\n)+)/m.exec(block);
  if (list) return list[1].split("\n").map((l) => l.replace(/^ *- /, "").trim()).filter(Boolean);
  return [];
}

describe("tauri-release.yml check jobs", () => {
  const all = jobs();

  it("has a cargo test job and a separate vitest job", () => {
    expect(all.test).toBeDefined();
    expect(all["test-frontend"]).toBeDefined();
    expect(all.test).toMatch(/cargo test /);
    expect(all["test-frontend"]).toMatch(/pnpm vitest run/);
    expect(all["test-frontend"]).not.toMatch(/cargo /);
  });

  it("keeps vitest out of the cargo job, so it no longer runs after cargo test", () => {
    expect(all.test).not.toMatch(/vitest/);
  });

  it("runs the two in parallel: neither needs the other", () => {
    expect(needs(all.test)).toEqual(["check"]);
    expect(needs(all["test-frontend"])).toEqual(["check"]);
  });

  it("keeps Typecheck with cargo (it needs the generated ipc types)", () => {
    expect(all.test).toMatch(/pnpm tsc --noEmit/);
    expect(all["test-frontend"]).not.toMatch(/tsc --noEmit/);
  });

  it("gates the tag on every check and on the Windows build", () => {
    expect([...needs(all.tag)].sort()).toEqual(["build-windows", "check", "test", "test-frontend"]);
  });

  it("does not release unless the check job says so, on the new job too", () => {
    expect(all["test-frontend"]).toMatch(/if: needs\.check\.outputs\.should_release == 'true'/);
  });
});
