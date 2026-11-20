// @vitest-environment jsdom
// jsdom: projectName reads settings off `window` for the "No project" check.

import { describe, it, expect } from "vitest";
import {
  projectName,
  sessionSubtitle,
  statusDotClass,
  deriveQuestionSet,
  isJarvisOrWorker,
  isMirrored,
} from "../src/views/sessions/sessions-helpers.ts";

function makeInstance(overrides = {}) {
  return {
    session_id: "abc123",
    pid: 1,
    cwd: "/home/user/my-project",
    project_id: "proj1",
    kind: "interactive",
    is_remote: false,
    started_at: "2026-05-08T10:00:00Z",
    transcript_path: null,
    name: null,
    ended_at: null,
    end_reason: null,
    busy: false,
    ...overrides,
  };
}

describe("projectName", () => {
  it("returns last path segment on unix paths", () => {
    expect(projectName(makeInstance({ cwd: "/home/user/my-project" }))).toBe("my-project");
  });
  it("returns last path segment on windows paths", () => {
    expect(projectName(makeInstance({ cwd: "C:\\Users\\joe\\my-app" }))).toBe("my-app");
  });
  it("handles trailing slash", () => {
    expect(projectName(makeInstance({ cwd: "/home/user/project/" }))).toBe("project");
  });
});

describe("sessionSubtitle", () => {
  it("returns instance name when set", () => {
    expect(sessionSubtitle(makeInstance({ name: "Fix auth bug" }))).toBe("Fix auth bug");
  });
  it("returns 'New chat' when name is null", () => {
    expect(sessionSubtitle(makeInstance({ name: null }))).toBe("New chat");
  });
  it("returns 'New chat' when name is empty string", () => {
    expect(sessionSubtitle(makeInstance({ name: "" }))).toBe("New chat");
  });
});


// The question set is derived from ONE source: the registry's `awaiting`
// field. The old second source (a frontend set fed by the open chat's marker
// detection) is gone - these tests pin the derivation and the full display
// matrix so the sidebar can't silently regress into contradictory states.
describe("deriveQuestionSet", () => {
  it("includes only sessions with awaiting === 'question'", () => {
    const sessions = [
      makeInstance({ session_id: "q1", awaiting: "question" }),
      makeInstance({ session_id: "d1", awaiting: "done" }),
      makeInstance({ session_id: "w1", awaiting: "waiting" }),
      makeInstance({ session_id: "wk1", awaiting: "working" }),
      makeInstance({ session_id: "n1" }),
    ];
    expect([...deriveQuestionSet(sessions)]).toEqual(["q1"]);
  });
  it("empty input gives an empty set", () => {
    expect(deriveQuestionSet([]).size).toBe(0);
  });
});

// Jarvis (todo 272) + its worker sub-sessions are hidden from the Chats
// sidebar list (sidebar.ts's renderSidebar) via this one predicate.
describe("isJarvisOrWorker", () => {
  it("is false for an ordinary session", () => {
    expect(isJarvisOrWorker(makeInstance())).toBe(false);
  });
  it("is true when jarvis is true", () => {
    expect(isJarvisOrWorker(makeInstance({ jarvis: true }))).toBe(true);
  });
  it("is true when worker_of is a session id", () => {
    expect(isJarvisOrWorker(makeInstance({ worker_of: "jarvis-session-id" }))).toBe(true);
  });
  it("is false when worker_of is explicitly null", () => {
    expect(isJarvisOrWorker(makeInstance({ jarvis: false, worker_of: null }))).toBe(false);
  });
});

// The one predicate for "hosted on a paired peer machine" - every call site
// used to inline `sess.machine != null`/`== null` itself.
describe("isMirrored", () => {
  it("is false for a locally-hosted session (machine: null)", () => {
    expect(isMirrored(makeInstance({ machine: null }))).toBe(false);
  });
  it("is true when machine is set", () => {
    expect(isMirrored(makeInstance({ machine: { id: "peer-1", label: "Laptop", online: true } }))).toBe(true);
  });
  it("is false for a missing/undefined instance (a lookup that found nothing)", () => {
    expect(isMirrored(undefined)).toBe(false);
    expect(isMirrored(null)).toBe(false);
  });
});

/** Every set here is empty on purpose: these pin what a surface that never
 *  received the prompt broadcast (the phone, a second window, a fresh reload)
 *  renders from `Instance` alone. The daemon-side writers are
 *  `Registry::mark_turn_live` and `hooks_server::permission`. */
describe("daemon-authoritative status with no window-local state", () => {
  const none = new Set();
  const dot = (i) => statusDotClass(i, none, none, deriveQuestionSet([i]));

  it("a live turn is working (chat 20176: this rendered as Done)", () => {
    const i = makeInstance({ session_id: "live", busy: true, awaiting: null });
    expect(dot(i)).toBe("st-working");
  });

  it("a self-resumed turn does not inherit the previous turn's 'done'", () => {
    // mark_turn_live clears awaiting, so the row cannot sit in Done while the
    // session works. The pre-fix shape is the second assertion.
    const after = makeInstance({ session_id: "bg", busy: true, awaiting: null });
    const before = makeInstance({ session_id: "bg", busy: false, awaiting: "done" });
    expect(dot(after)).toBe("st-working");
    expect(dot(before)).toBe("st-your-turn");
  });

  it("a blocking permission prompt is Input Needed on every surface", () => {
    const i = makeInstance({ session_id: "perm", busy: true, awaiting: "question" });
    expect(dot(i)).toBe("st-question");
  });

  it("answering the prompt hands the row straight back to In Progress", () => {
    const i = makeInstance({ session_id: "perm", busy: true, awaiting: null });
    expect(dot(i)).toBe("st-working");
  });
});

describe("statusDotClass", () => {
  const none = new Set();
  const cls = (i, question = deriveQuestionSet([i])) => statusDotClass(i, none, none, question);

  it("busy -> st-working", () => {
    expect(cls(makeInstance({ busy: true }))).toBe("st-working");
  });
  it("awaiting 'working' -> st-working (spinner, not hourglass)", () => {
    expect(cls(makeInstance({ awaiting: "working" }))).toBe("st-working");
  });
  it("awaiting 'question' -> st-question", () => {
    expect(cls(makeInstance({ session_id: "q", awaiting: "question" }))).toBe("st-question");
  });
  it("awaiting 'waiting' -> st-waiting", () => {
    expect(cls(makeInstance({ awaiting: "waiting" }))).toBe("st-waiting");
  });
  it("an awaiting value the frontend does not know draws as a plain idle chat", () => {
    expect(cls(makeInstance({ awaiting: "close_failed" }))).toBe("st-your-turn");
    expect(cls(makeInstance({ awaiting: "something_new" }))).toBe("st-your-turn");
  });
  it("idle read -> st-your-turn", () => {
    expect(cls(makeInstance({ awaiting: "done" }))).toBe("st-your-turn");
  });
  it("busy + awaiting 'question' (AUQ mid-turn) -> st-question", () => {
    // The question class must win over the busy spinner so the row keeps
    // flagging until the daemon clears awaiting on answer.
    expect(cls(makeInstance({ session_id: "auq", busy: true, awaiting: "question" }))).toBe("st-question");
  });
});

// Full precedence-table pin for todo 283's classifier extraction: locks in
// every per-function quirk found reading the pre-refactor cascades so the
// unified classifier can't silently normalize one function into another.
describe("precedence table quirks (pre-refactor pin, todo 283)", () => {
  it("statusDotClass: has no such fallback - falls through to idle when the question set omits the id", () => {
    const i = makeInstance({ session_id: "missing-from-set", busy: false, awaiting: "question" });
    expect(statusDotClass(i, new Set(), new Set(), new Set())).toBe("st-your-turn");
  });
  it("statusDotClass: 'automated' kind shares 'external's class", () => {
    expect(statusDotClass(makeInstance({ kind: "automated" }), new Set(), new Set(), new Set())).toBe("st-external");
  });
});
