// @vitest-environment jsdom
// Multi-machine federation (docs/multi-machine.md, G6): a mirrored chat has no
// local JSONL file for the desktop's file-watcher IPC to tail, so selectSession
// must ask the daemon's relay to attach instead. Pure-predicate unit test for
// that branch (needsRelayAttach) - selectSession itself is a full-pane mount
// with composer/statusbar/renderer side effects, too heavy to drive here for
// what is a one-line condition.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const { needsRelayAttach } = await import("../src/views/sessions/active-session.ts");

function instance(machine) {
  return { session_id: "s1", cwd: "/repo", machine: machine ?? null };
}

describe("needsRelayAttach", () => {
  it("true for a mirrored session on desktop", () => {
    expect(needsRelayAttach(instance({ id: "m1", label: "Mac Mini", online: true }), false)).toBe(true);
  });

  it("false for a local session on desktop", () => {
    expect(needsRelayAttach(instance(null), false)).toBe(false);
  });

  it("false for a mirrored session on the phone - it attaches a different way", () => {
    expect(needsRelayAttach(instance({ id: "m1", label: "Mac Mini", online: true }), true)).toBe(false);
  });

  it("false for a local session on the phone", () => {
    expect(needsRelayAttach(instance(null), true)).toBe(false);
  });
});
