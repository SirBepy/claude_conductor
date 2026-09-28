import { describe, it, expect } from "vitest";
import { buildRule, describeRule, matchesRule, parseRule } from "../src/views/sessions/permission-rules.ts";

// Confirmed CRITICAL from the security audit: a non-Bash "Always Allow" used
// to return { pattern: "" } for every tool, and matchesRule's leading
// `if (!rule.pattern) return true` then matched ANY future input for that
// tool - one click on Write to a single file authorized Write to every file
// in the project. This suite locks the fix: a non-Bash rule scopes to that
// tool's identifying argument (or the exact input, for a tool with none), and
// old pre-fix rules are invalidated rather than silently reinterpreted.

describe("a Write rule scopes to the approved file only", () => {
  const rule = buildRule("Write", { file_path: "C:/repo/notes.txt", content: "hi" });

  it("matches the same file again", () => {
    expect(matchesRule(rule, "Write", { file_path: "C:/repo/notes.txt", content: "different content" })).toBe(true);
  });

  it("does NOT match a different file - the bug this fix closes", () => {
    expect(matchesRule(rule, "Write", { file_path: "C:/repo/other.txt", content: "hi" })).toBe(false);
  });

  it("does not fall for a path that merely starts with the approved one", () => {
    expect(matchesRule(rule, "Write", { file_path: "C:/repo/notes.txt.bak" })).toBe(false);
  });
});

describe("Edit/Read mirror the same file_path scoping", () => {
  it("Edit", () => {
    const rule = buildRule("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" });
    expect(matchesRule(rule, "Edit", { file_path: "/a/b.ts", old_string: "p", new_string: "q" })).toBe(true);
    expect(matchesRule(rule, "Edit", { file_path: "/a/c.ts", old_string: "x", new_string: "y" })).toBe(false);
  });
  it("Read", () => {
    const rule = buildRule("Read", { file_path: "/a/b.ts" });
    expect(matchesRule(rule, "Read", { file_path: "/a/b.ts" })).toBe(true);
    expect(matchesRule(rule, "Read", { file_path: "/a/b-2.ts" })).toBe(false);
  });
});

describe("Grep/Glob scope to the approved pattern only", () => {
  it("Grep", () => {
    const rule = buildRule("Grep", { pattern: "TODO", path: "src" });
    expect(matchesRule(rule, "Grep", { pattern: "TODO", path: "elsewhere" })).toBe(true);
    expect(matchesRule(rule, "Grep", { pattern: "SECRET_KEY", path: "src" })).toBe(false);
  });
  it("Glob", () => {
    const rule = buildRule("Glob", { pattern: "**/*.ts" });
    expect(matchesRule(rule, "Glob", { pattern: "**/*.ts" })).toBe(true);
    expect(matchesRule(rule, "Glob", { pattern: "**/*.env" })).toBe(false);
  });
});

describe("the existing Bash metacharacter guard still holds (no regression)", () => {
  it("rejects a chained follow-on after the approved command", () => {
    const rule = buildRule("Bash", { command: "cat notes.txt" });
    expect(matchesRule(rule, "Bash", { command: "cat notes.txt && rm -rf /tmp/x" })).toBe(false);
  });
  it("still allows extra plain arguments (prefix matching)", () => {
    const rule = buildRule("Bash", { command: "cat notes.txt" });
    expect(matchesRule(rule, "Bash", { command: "cat notes.txt --number" })).toBe(true);
  });
});

describe("a tool with no known identifying argument never matches everything", () => {
  it("Task: a different input for the same tool does not match", () => {
    const rule = buildRule("Task", { description: "look up X", prompt: "find X in the repo" });
    expect(matchesRule(rule, "Task", { description: "look up Y", prompt: "find Y in the repo" })).toBe(false);
  });
  it("Task: the identical input does match (exact-input fallback, not 'no rule at all')", () => {
    const input = { description: "look up X", prompt: "find X in the repo" };
    const rule = buildRule("Task", input);
    expect(matchesRule(rule, "Task", { description: "look up X", prompt: "find X in the repo" })).toBe(true);
  });
  it("an unrecognized tool with an empty object input still doesn't match a different input", () => {
    const rule = buildRule("SomeFutureTool", {});
    expect(matchesRule(rule, "SomeFutureTool", { anything: "else" })).toBe(false);
  });
});

describe("old pre-fix rules (empty pattern, non-Bash) are invalidated, not reinterpreted", () => {
  it("a persisted Write::  (empty pattern) rule no longer matches any Write", () => {
    const legacyRule = parseRule("Write::");
    expect(legacyRule.pattern).toBe("");
    expect(matchesRule(legacyRule, "Write", { file_path: "/anything/at/all.txt" })).toBe(false);
  });

  it("Bash's own empty-pattern shape is untouched - still means 'any Bash command'", () => {
    const legacyBashRule = parseRule("Bash::");
    expect(matchesRule(legacyBashRule, "Bash", { command: "ls -la" })).toBe(true);
  });
});

describe("describeRule tells the truth about the new, narrower breadth", () => {
  it("names the scoped file for a Write rule, not just the tool", () => {
    const rule = buildRule("Write", { file_path: "/a/b.txt" });
    expect(describeRule(rule)).toContain("/a/b.txt");
  });

  it("says 'this exact input only' for a tool with no identifying argument", () => {
    const rule = buildRule("Task", { description: "x" });
    expect(describeRule(rule)).toContain("this exact input only");
  });

  it("flags an old empty-pattern rule as no longer applying, never as 'matches everything'", () => {
    const legacyRule = parseRule("Write::");
    const text = describeRule(legacyRule);
    expect(text).not.toMatch(/matches everything|any input/i);
    expect(text.toLowerCase()).toContain("no longer applies");
  });
});
