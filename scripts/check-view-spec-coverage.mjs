#!/usr/bin/env node
// CLI for todo 977: fail when a changed src/ file has view/e2e specs that
// depend on it (per view-spec-coverage.mjs) and were NOT touched in the
// same diff. Pure static scan - no vite/playwright boot, so it adds nothing
// to what `pnpm run test:view` already costs at a barrier (that cost is
// exactly why test:view itself stays out of the fast floor; see the todo's
// Notes).
//
// Usage:
//   node scripts/check-view-spec-coverage.mjs            # diffs HEAD
//   node scripts/check-view-spec-coverage.mjs <file> ...  # explicit set (tests, CI with a known base)

import { execFileSync } from "node:child_process";
import { buildSpecDependencyMap, findStaleSpecs } from "./view-spec-coverage.mjs";

const ROOT = process.cwd();

function changedFiles() {
  const explicit = process.argv.slice(2);
  if (explicit.length > 0) return explicit;
  const out = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

const depMap = buildSpecDependencyMap(ROOT);
const findings = findStaleSpecs(changedFiles(), depMap);
const entries = Object.entries(findings);

if (entries.length > 0) {
  console.error(
    `check-view-spec-coverage: ${entries.length} changed source file${entries.length === 1 ? "" : "s"} with an untouched dependent spec:\n`,
  );
  for (const [sourceFile, specs] of entries) {
    console.error(`  ${sourceFile}`);
    for (const spec of specs) console.error(`    -> ${spec}`);
  }
  console.error(
    "\nReview whether each spec's asserted contract still holds. If it does, touch the spec file " +
      "(even a comment) to clear this check - that is the same signal a real behaviour change needs.",
  );
  process.exit(1);
}

console.log(`check-view-spec-coverage: ${depMap.size} source file(s) mapped to a view/e2e spec, none stale for this diff.`);
