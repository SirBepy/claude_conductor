// Pure logic for todo 977: derive which e2e view/e2e specs assert the
// contract of which src/ module, then flag a changed module whose dependent
// specs were NOT touched in the same diff.
//
// Two link sources, combined, because neither alone covers every spec:
//
//   1. AUTO-DERIVED from the spec's own import statements - no header to
//      rot. Covers specs that reach into src/ directly:
//        - `await import("/views/.../foo.ts")` inside page.evaluate - the
//          harness's vite dev server is rooted at src/ (see harness.ts), so
//          an absolute-from-src path resolves to src/views/.../foo.ts.
//        - `from "../../src/.../foo"` - a relative static (usually
//          type-only) import.
//      This is free and can't go stale, but it only sees specs that import
//      the module they're exercising. Most view specs drive behaviour
//      through the rendered UI/mock-invoke surface instead and import
//      nothing from src/ at all.
//   2. A `// asserts: <path>[, <path>...]` header comment line, already in
//      organic use before this file existed (project-picker-add-project.view
//      .spec.ts, project-picker-favorites.view.spec.ts, added 2026-09-26,
//      ce6ff82d) for exactly the UI-driven case #1 can't see. It is also the
//      ONLY link available for wdio's e2e/specs/*.e2e.js, which drive the
//      built app over webdriver IPC and never import a src/ module - so this
//      is the convention that is "expressible for both" per todo 977's
//      Notes. Hand-written, so it rots silently unless something checks it;
//      that something is `check-view-spec-coverage.mjs`, the CLI wrapper
//      around this module.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";

const DYNAMIC_IMPORT_RE = /import\(\s*["'`](\/[^"'`]+)["'`]\s*\)/g;
const STATIC_RELATIVE_IMPORT_RE = /from\s+["'`](\.\.?\/[^"'`]+)["'`]/g;
const ASSERTS_HEADER_RE = /\/\/\s*asserts:\s*(.+)$/gm;

function toPosix(p) {
  return p.split("\\").join("/");
}

function resolveAgainstRoot(root, rawRel) {
  if (existsSync(resolve(root, rawRel))) return rawRel;
  for (const ext of [".ts", ".tsx"]) {
    if (existsSync(resolve(root, rawRel + ext))) return rawRel + ext;
  }
  return rawRel; // keep as-is; still useful for matching against a changed-file list verbatim
}

function addDependency(map, root, srcRelRaw, specRel) {
  const srcRel = toPosix(resolveAgainstRoot(root, toPosix(srcRelRaw)));
  if (!map.has(srcRel)) map.set(srcRel, new Set());
  map.get(srcRel).add(specRel);
}

function scanFileForLinks(map, root, filePath) {
  const fileRel = toPosix(relative(root, filePath));
  const text = readFileSync(filePath, "utf8");

  for (const m of text.matchAll(DYNAMIC_IMPORT_RE)) {
    addDependency(map, root, join("src", m[1]), fileRel);
  }

  for (const m of text.matchAll(STATIC_RELATIVE_IMPORT_RE)) {
    const abs = resolve(dirname(filePath), m[1]);
    const rel = toPosix(relative(root, abs));
    if (!rel.startsWith("src/")) continue; // e.g. "./harness", "./shot-dir", "node:assert"
    addDependency(map, root, rel, fileRel);
  }

  for (const m of text.matchAll(ASSERTS_HEADER_RE)) {
    for (const rawPath of m[1].split(",")) {
      const p = rawPath.trim();
      if (p.length === 0) continue;
      addDependency(map, root, p, fileRel);
    }
  }
}

function listFiles(dir, suffix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => join(dir, e.name));
}

/** Build sourceFile(repo-relative, posix) -> Set(specFile repo-relative
 *  posix) across both the Playwright view-harness and the wdio e2e specs. */
export function buildSpecDependencyMap(
  root,
  { viewHarnessDir = join(root, "e2e", "view-harness"), wdioSpecsDir = join(root, "e2e", "specs") } = {},
) {
  const map = new Map();
  for (const f of listFiles(viewHarnessDir, ".view.spec.ts")) scanFileForLinks(map, root, f);
  for (const f of listFiles(wdioSpecsDir, ".e2e.js")) scanFileForLinks(map, root, f);
  return map;
}

/** Given the changed files in a diff (repo-relative, any path separator) and
 *  the dependency map above, return { [sourceFile]: string[] specs } for
 *  every changed source file whose dependent specs were NOT also changed. */
export function findStaleSpecs(changedFiles, depMap) {
  const changed = new Set(changedFiles.map(toPosix));
  const findings = {};
  for (const [sourceFile, specs] of depMap) {
    if (!changed.has(sourceFile)) continue;
    const untouched = [...specs].filter((s) => !changed.has(s));
    if (untouched.length > 0) findings[sourceFile] = untouched.sort();
  }
  return findings;
}
