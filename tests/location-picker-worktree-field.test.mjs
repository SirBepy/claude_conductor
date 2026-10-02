// A project with zero additional worktrees has only one real location (the
// default) - that is not a choice, so the Worktree field in the location
// picker stays hidden entirely (todo 930, same reasoning as the account
// popover). One or more existing worktrees is a real decision (Default vs
// that worktree) and keeps the field visible and interactive, unchanged.

import { describe, it, expect } from "vitest";
import { hasWorktreeChoice } from "../src/views/sessions/location-picker.ts";

describe("hasWorktreeChoice - zero additional worktrees", () => {
  it("is false: the default is the only location, field stays hidden", () => {
    expect(hasWorktreeChoice(0)).toBe(false);
  });
});

describe("hasWorktreeChoice - exactly one additional worktree", () => {
  it("is true: Default vs that worktree is a real two-way decision", () => {
    expect(hasWorktreeChoice(1)).toBe(true);
  });
});

describe("hasWorktreeChoice - two or more additional worktrees (unchanged)", () => {
  it("is true", () => {
    expect(hasWorktreeChoice(2)).toBe(true);
    expect(hasWorktreeChoice(5)).toBe(true);
  });
});
