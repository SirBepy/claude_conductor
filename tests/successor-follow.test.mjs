import { describe, it, expect, beforeEach } from "vitest";
import {
  findSuccessorToFollow,
  markFollowed,
  resetFollowed,
} from "../src/views/sessions/successor-follow.ts";

const sess = (id, extra = {}) => ({
  session_id: id,
  ended_at: null,
  successor_of: null,
  ...extra,
});

describe("findSuccessorToFollow", () => {
  beforeEach(() => resetFollowed());

  it("returns null when nothing is selected", () => {
    expect(findSuccessorToFollow([sess("b", { successor_of: "a" })], null)).toBeNull();
  });

  it("returns null when no session claims the selected one as predecessor", () => {
    expect(findSuccessorToFollow([sess("a"), sess("b")], "a")).toBeNull();
  });

  it("finds the successor of the selected session", () => {
    const sessions = [sess("a"), sess("b", { successor_of: "a" })];
    expect(findSuccessorToFollow(sessions, "a")).toBe("b");
  });

  it("ignores a successor belonging to a different chat", () => {
    const sessions = [sess("a"), sess("b", { successor_of: "other" })];
    expect(findSuccessorToFollow(sessions, "a")).toBeNull();
  });

  it("ignores an already-ended successor", () => {
    const sessions = [sess("b", { successor_of: "a", ended_at: "2026-08-22T00:00:00Z" })];
    expect(findSuccessorToFollow(sessions, "a")).toBeNull();
  });

  // The predecessor stays live until its own turn ends, so it is still in the
  // list right after the follow. Without the guard, clicking back onto it
  // would immediately bounce the user forward again.
  it("follows a given predecessor only once", () => {
    const sessions = [sess("a"), sess("b", { successor_of: "a" })];
    expect(findSuccessorToFollow(sessions, "a")).toBe("b");
    markFollowed("a");
    expect(findSuccessorToFollow(sessions, "a")).toBeNull();
  });

  it("keeps following other chats after one has been followed", () => {
    markFollowed("a");
    const sessions = [sess("d", { successor_of: "c" })];
    expect(findSuccessorToFollow(sessions, "c")).toBe("d");
  });
});
