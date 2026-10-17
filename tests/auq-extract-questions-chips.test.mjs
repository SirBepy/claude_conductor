// Regression for todo 565: extractQuestions rebuilt each question field by field
// and silently dropped `domain` + option `badges`, so the chips never rendered.
// Whitelisted, not passed through - both land in a CSS var / class name.

import { describe, it, expect } from "vitest";
import { extractQuestions } from "../src/views/sessions/permission-modal/question-ui.ts";

describe("extractQuestions chip fields", () => {
  it("preserves domain and per-option badges", () => {
    const out = extractQuestions({
      questions: [{
        question: "Which way?",
        header: "Approach",
        domain: "arch",
        options: [
          { label: "A", description: "first", badges: ["recommended", "long_term"] },
          { label: "B" },
        ],
      }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("arch");
    expect(out[0].options[0].badges).toEqual(["recommended", "long_term"]);
    expect(out[0].options[1].badges).toBeUndefined();
  });

  it("drops values outside the whitelists instead of forwarding them", () => {
    const out = extractQuestions({
      questions: [{
        question: "Which way?",
        domain: "not-a-domain",
        options: [{ label: "A", badges: ["recommended", "made-up"] }],
      }],
    });
    expect(out[0].domain).toBeUndefined();
    expect(out[0].options[0].badges).toEqual(["recommended"]);
  });

  it("keeps an option's preview HTML and drops a blank or non-string one", () => {
    const out = extractQuestions({
      questions: [{
        question: "Which look?",
        domain: "ux",
        options: [
          { label: "A", preview: "<div class='row'>A</div>" },
          { label: "B", preview: "   " },
          { label: "C", preview: 7 },
        ],
      }],
    });
    expect(out[0].options[0].preview).toBe("<div class='row'>A</div>");
    expect(out[0].options[1].preview).toBeUndefined();
    expect(out[0].options[2].preview).toBeUndefined();
  });

  it("a non-array badges value is ignored, not crashed on", () => {
    const out = extractQuestions({
      questions: [{ question: "Q?", options: [{ label: "A", badges: "recommended" }] }],
    });
    expect(out[0].options[0].badges).toBeUndefined();
  });
});
