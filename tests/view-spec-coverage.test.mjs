// Regression coverage for todo 977: a contract change to a src/ file must
// surface the view/e2e specs that depend on it, in a check that actually
// runs (not a header nobody greps). Exercises the real repo tree - no
// fixtures - so the test fails for real if either link source (import scan
// or `// asserts:` header) stops resolving.

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildSpecDependencyMap, findStaleSpecs } from "../scripts/view-spec-coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const depMap = buildSpecDependencyMap(ROOT);

const QUESTION_UI = "src/views/sessions/permission-modal/question-ui.ts";
const ESC_NO_SKIP_SPEC = "e2e/view-harness/auq-esc-no-skip.view.spec.ts";
const PROJECT_PICKER = "src/views/sessions/project-picker.ts";
const PROJECTS_ROOT = "src/views/sessions/projects-root.ts";
const ADD_PROJECT_SPEC = "e2e/view-harness/project-picker-add-project.view.spec.ts";
const FAVORITES_SPEC = "e2e/view-harness/project-picker-favorites.view.spec.ts";
const NO_PROJECT_SPEC = "e2e/view-harness/project-picker-no-project.view.spec.ts";

describe("view-spec-coverage: import-derived link (auto, no header)", () => {
  it("maps question-ui.ts to the spec that dynamically imports it", () => {
    expect(depMap.get(QUESTION_UI)).toBeDefined();
    expect(depMap.get(QUESTION_UI).has(ESC_NO_SKIP_SPEC)).toBe(true);
  });

  it("replays deb213a8's shape: touching only the source signals the untouched spec", () => {
    // auq-esc-lightbox-guard.view.spec.ts (todo 976) was the real casualty:
    // question-ui.ts's Escape contract changed, that spec wasn't touched,
    // and nothing caught it. auq-esc-no-skip.view.spec.ts is its live
    // replacement and is the correct dependent today.
    const findings = findStaleSpecs([QUESTION_UI], depMap);
    expect(findings[QUESTION_UI]).toContain(ESC_NO_SKIP_SPEC);
  });

  it("clears once the dependent spec is touched in the same diff", () => {
    // question-ui.ts has other dependents too (auq-flow.view.spec.ts, etc.) -
    // those staying flagged is correct. The regression is specifically about
    // auq-esc-no-skip.view.spec.ts, so assert it drops out of the list.
    const findings = findStaleSpecs([QUESTION_UI, ESC_NO_SKIP_SPEC], depMap);
    expect(findings[QUESTION_UI] ?? []).not.toContain(ESC_NO_SKIP_SPEC);
  });

  it("stays quiet when the changed file has no view/e2e dependent at all", () => {
    const findings = findStaleSpecs(["src/some/unrelated/file-not-in-any-spec.ts"], depMap);
    expect(findings).toEqual({});
  });
});

describe("view-spec-coverage: header-derived link (// asserts:, for UI-driven specs with no import)", () => {
  it("maps project-picker.ts and projects-root.ts via the existing `// asserts:` header", () => {
    // project-picker-add-project.view.spec.ts drives the UI only (mock
    // invoke + clicks) - it imports nothing from src/, so the header is the
    // ONLY link source that can see this pairing at all.
    expect(depMap.get(PROJECT_PICKER).has(ADD_PROJECT_SPEC)).toBe(true);
    expect(depMap.get(PROJECTS_ROOT).has(ADD_PROJECT_SPEC)).toBe(true);
  });

  it("signals when project-picker.ts changes without its header-linked specs", () => {
    const findings = findStaleSpecs([PROJECT_PICKER], depMap);
    expect(findings[PROJECT_PICKER]).toEqual(expect.arrayContaining([ADD_PROJECT_SPEC, FAVORITES_SPEC]));
  });

  it("clears once every header-linked spec is in the same diff", () => {
    const findings = findStaleSpecs([PROJECT_PICKER, ADD_PROJECT_SPEC, FAVORITES_SPEC, NO_PROJECT_SPEC], depMap);
    expect(findings[PROJECT_PICKER]).toBeUndefined();
  });
});
