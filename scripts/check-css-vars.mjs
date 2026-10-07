#!/usr/bin/env node
// Build-time check for `var(--name)` references with no matching declaration.
// An undeclared custom property with a fallback (`var(--x, red)`) fails
// completely silently at runtime, which is why this bug class was swept by
// hand twice (61ba939d, 5ee6dc0c / todo 998) before it got a script.
//
// "Declared" means one of:
//   1. `--name:` in a src/**/*.css or vendor/tauri_kit/**/*.css declaration
//      block (not inside a class name like `.host--composer` and not a
//      var() fallback reference, which is followed by `,`/`)`, never `:`).
//   2. Set at runtime from src/ or vendor/tauri_kit/frontend/ TS, detected
//      generically:
//        - `.setProperty("--name", ...)` (any object's setProperty)
//        - `--name:` inside a template-string `style="..."` attribute
//          (same colon shape as #1, so the same regex catches it)
//   3. Explicitly allowlisted below, for the handful of cases neither of
//      the above can see.
//
// Zero dependencies, ESM (package.json has "type": "module").

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// Names the generic detection above cannot see, one reason each.
const ALLOWLIST = {
  "--shiki-dark": "emitted inline by shiki's codeToTokens() with defaultColor:false, never assigned via setProperty or a style=\"...\" literal",
  "--shiki-light": "emitted inline by shiki's codeToTokens() with defaultColor:false, never assigned via setProperty or a style=\"...\" literal",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "vendor"]);

function walk(dir, exts, skipDirs) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walk(full, exts, skipDirs));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// A declaration/assignment is `--name:` not preceded by a word/hyphen char,
// so it excludes both a BEM class fragment (`.host--composer:hover`, the
// "t" before "--" fails the lookbehind) and a var() fallback name (which is
// followed by `,`/`)`, never reaches a `:` at all).
const DECL_RE = /(?<![\w-])--([A-Za-z0-9_-]+)\s*:/g;
const SET_PROPERTY_RE = /\.setProperty\(\s*["'`]--([A-Za-z0-9_-]+)["'`]/g;
// Captures `$` too, so a template placeholder like `--color-domain-${domain}`
// is visible in the raw match; such a name is skipped below, never flagged.
const VAR_REF_RE = /var\(\s*--([A-Za-z0-9_$-]+)/g;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function collectDeclared(files) {
  const declared = new Set(Object.keys(ALLOWLIST));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(DECL_RE)) declared.add(`--${m[1]}`);
    for (const m of text.matchAll(SET_PROPERTY_RE)) declared.add(`--${m[1]}`);
  }
  return declared;
}

function collectReferences(files) {
  const refs = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(VAR_REF_RE)) {
      const name = m[1];
      if (name.includes("$")) continue; // template placeholder, e.g. --color-domain-${domain}
      refs.push({ name: `--${name}`, file, line: lineOf(text, m.index) });
    }
  }
  return refs;
}

const srcCssFiles = walk(join(ROOT, "src"), [".css"], SKIP_DIRS);
const vendorCssFiles = walk(join(ROOT, "vendor", "tauri_kit"), [".css"], new Set());
const srcTsFiles = walk(join(ROOT, "src"), [".ts"], SKIP_DIRS);
const vendorTsFiles = walk(join(ROOT, "vendor", "tauri_kit", "frontend"), [".ts"], new Set(["node_modules"]));
const srcHtmlFiles = walk(join(ROOT, "src"), [".html"], SKIP_DIRS);

const declared = collectDeclared([...srcCssFiles, ...vendorCssFiles, ...srcTsFiles, ...vendorTsFiles]);
const references = collectReferences([...srcCssFiles, ...srcTsFiles, ...srcHtmlFiles]);

const undeclared = references.filter((r) => !declared.has(r.name));

if (undeclared.length > 0) {
  console.error(`check-css-vars: ${undeclared.length} undeclared custom propert${undeclared.length === 1 ? "y" : "ies"} referenced:\n`);
  for (const r of undeclared) {
    console.error(`  ${relative(ROOT, r.file)}:${r.line} ${r.name}`);
  }
  process.exit(1);
}

console.log(`check-css-vars: declared ${declared.size}, referenced ${new Set(references.map((r) => r.name)).size}, undeclared: none`);
