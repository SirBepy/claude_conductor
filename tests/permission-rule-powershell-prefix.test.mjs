import { describe, it, expect } from "vitest";
import { buildRule, describeRule, isDestructive, matchesRule, parseRule } from "../src/views/sessions/permission-rules.ts";

// todo 1016: buildRule/matchesRule special-cased `toolName === "Bash"` for
// prefix-scoped "Always Allow" rules, so a PowerShell call fell into the
// generic non-Bash branch (scoped to an identifying argument, or the exact
// input JSON when there's none - see d43eb74b) instead of getting Bash's
// prefix scoping. `isDestructive` already keyed on the input having a string
// `command` field for any tool (e5b6c528); this fix makes the prefix branch
// key the same way, so PowerShell and any future shell tool share Bash's
// prefix behaviour.

describe("PowerShell Always Allow is prefix-scoped, like Bash", () => {
  const rule = buildRule("PowerShell", { command: "git status" });

  it("matches the exact approved command", () => {
    expect(matchesRule(rule, "PowerShell", { command: "git status" })).toBe(true);
  });

  it("matches a variant with extra plain arguments (prefix matching)", () => {
    expect(matchesRule(rule, "PowerShell", { command: "git status -s" })).toBe(true);
  });

  it("does not match an unrelated command", () => {
    expect(matchesRule(rule, "PowerShell", { command: "git log" })).toBe(false);
  });

  it("refuses a chained follow-on, same guard as Bash", () => {
    expect(matchesRule(rule, "PowerShell", { command: "git status; Remove-Item -Recurse -Force C:\\temp" })).toBe(
      false,
    );
  });
});

describe("a destructive PowerShell command is never matched by a remembered rule", () => {
  it("isDestructive still gates it even though the command shares the allowed prefix", () => {
    const rule = buildRule("PowerShell", { command: "Remove-Item" });
    const destructiveInput = { command: "Remove-Item -Recurse -Force C:\\temp" };
    // matchesRule alone is a pure prefix test - the caller (gating.ts) always
    // checks isDestructive first and short-circuits before matchesRule is
    // ever consulted. Prove both halves hold: the prefix technically matches,
    // but isDestructive is true, so the real auto-allow gate never fires.
    expect(matchesRule(rule, "PowerShell", destructiveInput)).toBe(true);
    expect(isDestructive("PowerShell", destructiveInput)).toBe(true);
  });
});

describe("an old-shape stored PowerShell rule keeps its old exact-match meaning", () => {
  // Before this fix, PowerShell had no IDENTIFYING_FIELD entry, so buildRule
  // fell to the exact-input-JSON fallback: the pattern is the full
  // JSON.stringify of the approved input, not a bare command string.
  const legacyInput = { command: "git status" };
  const legacyRaw = `PowerShell::${JSON.stringify(legacyInput)}`;
  const legacyRule = parseRule(legacyRaw);

  it("parses back with the full-JSON pattern intact", () => {
    expect(legacyRule.pattern).toBe(JSON.stringify(legacyInput));
  });

  it("still matches the exact identical input it was approved for", () => {
    expect(matchesRule(legacyRule, "PowerShell", { command: "git status" })).toBe(true);
  });

  it("does NOT widen into a prefix match - a variant with extra args is refused", () => {
    // Under the old (pre-1016) semantics this never matched a variant either -
    // the fix must not silently grant it new prefix powers.
    expect(matchesRule(legacyRule, "PowerShell", { command: "git status -s" })).toBe(false);
  });

  it("does not match a different command", () => {
    expect(matchesRule(legacyRule, "PowerShell", { command: "git log" })).toBe(false);
  });
});

describe("existing Bash behaviour is unchanged by keying on the command field", () => {
  it("Bash still gets prefix scoping", () => {
    const rule = buildRule("Bash", { command: "cat notes.txt" });
    expect(matchesRule(rule, "Bash", { command: "cat notes.txt --number" })).toBe(true);
  });

  it("Bash's empty-pattern rule still means 'any Bash command'", () => {
    const legacyBashRule = parseRule("Bash::");
    expect(matchesRule(legacyBashRule, "Bash", { command: "ls -la" })).toBe(true);
  });
});

describe("describeRule labels a PowerShell rule by what it matches", () => {
  it("names the command prefix for a new-shape rule", () => {
    expect(describeRule(buildRule("PowerShell", { command: "git status" }))).toBe("Always allow PowerShell: git status");
  });

  it("keeps 'exact input only' for an old-shape JSON rule", () => {
    expect(describeRule(parseRule('PowerShell::{"command":"git status"}'))).toBe("Always allow PowerShell: this exact input only");
  });
});
