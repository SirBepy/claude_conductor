// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sessionSegment, statusPriority } from "../src/views/sessions/sessions-helpers.ts";

const NONE = () => new Set();

function inst(over = {}) {
  return { session_id: "s1", kind: "interactive", busy: false, awaiting: null, is_remote: false, ...over };
}

describe("statusPriority - awaiting=question without a client-side prompt entry", () => {
  it("reports Input Needed when the window has not seen the prompt", () => {
    const i = inst({ busy: true, awaiting: "question" });
    expect(statusPriority(i, NONE(), NONE(), NONE())).toBe(1);
  });

  it("segments to Input Needed, not Done", () => {
    const i = inst({ busy: true, awaiting: "question" });
    expect(sessionSegment(i, NONE(), NONE(), NONE(), NONE())).toBe(0);
  });

  // The bug Joe hit: the row's segment changed depending on which chat was
  // selected, because only the selected one populated `question`.
  it("is stable whether or not the prompt is in the question set", () => {
    const i = inst({ busy: true, awaiting: "question" });
    const seen = sessionSegment(i, NONE(), NONE(), new Set(["s1"]), NONE());
    const unseen = sessionSegment(i, NONE(), NONE(), NONE(), NONE());
    expect(unseen).toBe(seen);
  });

  it("still reports In Progress for a plain busy session", () => {
    expect(statusPriority(inst({ busy: true }), NONE(), NONE(), NONE())).toBe(2);
  });

  it("still reports Done for an idle session", () => {
    expect(statusPriority(inst(), NONE(), NONE(), NONE())).toBe(5);
  });

  it("keeps awaiting=working in the In Progress tier", () => {
    expect(statusPriority(inst({ awaiting: "working" }), NONE(), NONE(), NONE())).toBe(2);
  });

  it("keeps awaiting=waiting in its own tier", () => {
    expect(statusPriority(inst({ awaiting: "waiting" }), NONE(), NONE(), NONE())).toBe(3);
  });
});
