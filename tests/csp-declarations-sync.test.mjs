// Guards against src/index.html's CSP meta tag and src-tauri/tauri.conf.json's
// security.csp silently drifting apart - they already have once (6a75d2a7), and
// a mismatch only fails at runtime (resources blocked), never at build time.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const htmlPath = path.join(repoRoot, "src", "index.html");
const tauriConfPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");

// CSP fetch directives that fall back to a base directive when absent (CSP
// spec fallback list, not every directive falls back). A directive missing
// on one side is only tolerated if it legitimately inherits from its base
// directive there, and that base directive's values already match the other
// side's explicit declaration of the fallback directive.
const FALLBACK_TO = {
  "style-src-elem": "style-src",
  "style-src-attr": "style-src",
  "script-src-elem": "script-src",
  "script-src-attr": "script-src",
};

function parseCsp(csp) {
  const map = new Map();
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [directive, ...values] = trimmed.split(/\s+/);
    map.set(directive, new Set(values));
  }
  return map;
}

function extractHtmlCsp(html) {
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/,
  );
  if (!match) {
    throw new Error(`No CSP meta tag found in ${htmlPath}`);
  }
  return match[1];
}

function extractTauriCsp(confJson) {
  const csp = confJson?.app?.security?.csp;
  if (typeof csp !== "string" || !csp) {
    throw new Error(`No app.security.csp string found in ${tauriConfPath}`);
  }
  return csp;
}

describe("CSP declarations stay in sync (src/index.html vs tauri.conf.json)", () => {
  it("agree on every directive's value set, honoring CSP fallback rules", () => {
    const htmlCsp = extractHtmlCsp(fs.readFileSync(htmlPath, "utf8"));
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
    const tauriCsp = extractTauriCsp(tauriConf);

    const htmlMap = parseCsp(htmlCsp);
    const tauriMap = parseCsp(tauriCsp);
    const allDirectives = new Set([...htmlMap.keys(), ...tauriMap.keys()]);

    for (const directive of allDirectives) {
      const inHtml = htmlMap.has(directive);
      const inTauri = tauriMap.has(directive);

      if (inHtml && inTauri) {
        const htmlValues = [...htmlMap.get(directive)].sort();
        const tauriValues = [...tauriMap.get(directive)].sort();
        expect(
          htmlValues,
          `"${directive}" differs between src/index.html and src-tauri/tauri.conf.json`,
        ).toEqual(tauriValues);
        continue;
      }

      // Only one side declares this directive - acceptable only if it falls
      // back to a base directive whose value there already matches the
      // other side's explicit declaration of this directive.
      const fallbackBase = FALLBACK_TO[directive];
      const missingSideMap = inTauri ? htmlMap : tauriMap;
      const presentSideMap = inTauri ? tauriMap : htmlMap;
      const missingSideLabel = inTauri
        ? "src/index.html"
        : "src-tauri/tauri.conf.json";

      if (!fallbackBase) {
        throw new Error(
          `Directive "${directive}" is declared in only one CSP source ` +
            `(missing from ${missingSideLabel}) and has no CSP fallback rule ` +
            `to justify the gap.`,
        );
      }

      const fallbackValues = missingSideMap.get(fallbackBase);
      expect(
        fallbackValues,
        `"${directive}" is missing from ${missingSideLabel}, and its fallback ` +
          `base "${fallbackBase}" is also missing there - nothing for it to inherit from`,
      ).toBeDefined();

      expect(
        [...fallbackValues].sort(),
        `"${directive}" is only declared in one file; its fallback ` +
          `("${fallbackBase}" in ${missingSideLabel}) doesn't match the ` +
          `explicit "${directive}" value on the other side`,
      ).toEqual([...presentSideMap.get(directive)].sort());
    }
  });
});
