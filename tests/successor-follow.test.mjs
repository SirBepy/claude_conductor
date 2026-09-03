import { describe, it, expect, beforeEach } from "vitest";
import {
  findSuccessorToFollow,
  markFollowed,
  resetFollowed,
  chainRowKey,
  recordChainLinks,
  supersededPredecessors,
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

describe("sidebar row identity across a respawn", () => {
  beforeEach(() => resetFollowed());

  it("gives a fresh chat its own key", () => {
    expect(chainRowKey("a")).toBe("s:a");
  });

  it("hands a successor its predecessor's key", () => {
    recordChainLinks([sess("a"), sess("b", { successor_of: "a" })]);
    expect(chainRowKey("b")).toBe("s:a");
  });

  // The whole point: the reconciler must see ONE key across the chain, or it
  // animates a row out and another in on every respawn.
  it("keeps the root's key through a chain of respawns", () => {
    recordChainLinks([sess("b", { successor_of: "a" })]);
    recordChainLinks([sess("c", { successor_of: "b" })]);
    expect(chainRowKey("c")).toBe("s:a");
  });

  // The predecessor drops out of the list as soon as its turn ends, long
  // before the successor does - a re-derived key would change under the row.
  it("keeps a recorded key after the predecessor leaves the list", () => {
    recordChainLinks([sess("a"), sess("b", { successor_of: "a" })]);
    recordChainLinks([sess("b", { successor_of: "a" })]);
    expect(chainRowKey("b")).toBe("s:a");
  });

  it("hides a predecessor that a live successor has taken over from", () => {
    const sessions = [sess("a"), sess("b", { successor_of: "a" })];
    expect([...supersededPredecessors(sessions)]).toEqual(["a"]);
  });

  it("keeps the predecessor visible once the successor itself has ended", () => {
    const sessions = [sess("a"), sess("b", { successor_of: "a", ended_at: "2026-09-03T00:00:00Z" })];
    expect(supersededPredecessors(sessions).size).toBe(0);
  });
});
