// CLAUDE.md is loaded by every chat and every sub and re-sent to every live chat whenever it
// changes, so module maps live in docs/architecture/*.md and CLAUDE.md keeps one pointer line
// per area (docs/forever-chat-plan.md section 4.2). This pins the size budget and that every
// pointer resolves.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const claudeMd = readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8");
const ARCH_DIR = resolve(ROOT, "docs/architecture");

// Budget in characters. The file was ~45K before the maps moved out; raise this only after
// moving something else out, never to fit a new module map in CLAUDE.md.
const BUDGET_CHARS = 16000;

const referenced = [...claudeMd.matchAll(/docs\/architecture\/([a-z0-9-]+\.md)/g)].map((m) => m[1]);

describe("CLAUDE.md stays small, module maps live in docs/architecture", () => {
  it("is under the size budget", () => {
    expect(claudeMd.length).toBeLessThan(BUDGET_CHARS);
  });

  it("points at no fewer than the areas that moved out", () => {
    expect(new Set(referenced).size).toBeGreaterThanOrEqual(14);
  });

  it("every referenced architecture file exists", () => {
    const missing = [...new Set(referenced)].filter((f) => !existsSync(resolve(ARCH_DIR, f)));
    expect(missing).toEqual([]);
  });

  it("every architecture file is referenced from CLAUDE.md", () => {
    const unreferenced = existsSync(ARCH_DIR)
      ? readdirSync(ARCH_DIR).filter((f) => f.endsWith(".md") && !referenced.includes(f))
      : [];
    expect(unreferenced).toEqual([]);
  });

  it("every architecture file has a title and says when to read it", () => {
    const bad = [...new Set(referenced)].filter((f) => {
      const text = readFileSync(resolve(ARCH_DIR, f), "utf8");
      return !/^# \S/.test(text) || !/\nRead before /.test(text);
    });
    expect(bad).toEqual([]);
  });

  it("every pointer line names when to read the file", () => {
    const pointerLines = claudeMd.split(/\r?\n/).filter((l) => /docs\/architecture\//.test(l));
    const vague = pointerLines.filter((l) => !/(read|details in) docs\/architecture\//i.test(l));
    expect(vague).toEqual([]);
  });
});
