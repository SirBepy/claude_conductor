// @vitest-environment jsdom
// jsdom: projectName reads settings off `window` for the "No project" check.

import { describe, it, expect } from "vitest";
import {
  projectName,
  sessionSubtitle,
  statusPriority,
  sessionSegment,
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

describe("statusPriority", () => {
  const unread = new Set(["unread-id"]);
  const noAttention = new Set();
  const attention = new Set(["attn-id"]);
  const noQuestion = new Set();
  const question = new Set(["q-id"]);

  it("returns 0 for a session needing permission (attention)", () => {
    expect(statusPriority(makeInstance({ session_id: "attn-id" }), unread, attention, noQuestion)).toBe(0);
  });
  it("attention wins over busy and external", () => {
    expect(statusPriority(makeInstance({ session_id: "attn-id", busy: true, kind: "external" }), unread, attention, noQuestion)).toBe(0);
  });
  it("returns 1 for a non-busy question (Claude waiting on user)", () => {
    expect(statusPriority(makeInstance({ session_id: "q-id", busy: false }), unread, noAttention, question)).toBe(1);
  });
  it("question sorts above busy", () => {
    const q = statusPriority(makeInstance({ session_id: "q-id", busy: false }), unread, noAttention, question);
    const b = statusPriority(makeInstance({ busy: true }), unread, noAttention, noQuestion);
    expect(q).toBeLessThan(b);
  });
  it("returns 2 for busy interactive", () => {
    expect(statusPriority(makeInstance({ busy: true }), unread, noAttention, noQuestion)).toBe(2);
  });
  it("question outranks busy even when the instance is still marked busy (permission prompt pending)", () => {
    // A permission-shaped prompt never sets awaiting="question", so busy stays
    // true the whole time it's pending - question must still win (2026-08-10 fix).
    expect(statusPriority(makeInstance({ session_id: "q-id", busy: true }), unread, noAttention, question)).toBe(1);
  });
  it("returns 3 for a session parked on an external process (waiting)", () => {
    expect(statusPriority(makeInstance({ session_id: "wait-id", busy: false, awaiting: "waiting" }), unread, noAttention, noQuestion)).toBe(3);
  });
  it("returns 4 for unread not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "unread-id", busy: false }), unread, noAttention, noQuestion)).toBe(4);
  });
  it("returns 5 for read not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "other-id", busy: false }), unread, noAttention, noQuestion)).toBe(5);
  });
  it("returns 6 for external", () => {
    expect(statusPriority(makeInstance({ kind: "external" }), unread, noAttention, noQuestion)).toBe(6);
  });
  it("external wins over busy", () => {
    expect(statusPriority(makeInstance({ kind: "external", busy: true }), unread, noAttention, noQuestion)).toBe(6);
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

describe("statusPriority - awaiting/busy interaction matrix", () => {
  const none = new Set();

  it("awaiting 'working' (background subagents running) is Working, not Waiting", () => {
    expect(statusPriority(makeInstance({ busy: false, awaiting: "working" }), none, none, none)).toBe(2);
  });
  it("busy with a leftover awaiting 'waiting' is still Working", () => {
    // A new turn started before the daemon cleared the old verdict: busy wins.
    expect(statusPriority(makeInstance({ busy: true, awaiting: "waiting" }), none, none, none)).toBe(2);
  });
  it("busy with a leftover awaiting 'done' is still Working", () => {
    expect(statusPriority(makeInstance({ busy: true, awaiting: "done" }), none, none, none)).toBe(2);
  });
  it("busy + awaiting 'question' (AUQ mid-turn) surfaces as Question", () => {
    const i = makeInstance({ session_id: "auq", busy: true, awaiting: "question" });
    const question = deriveQuestionSet([i]);
    expect(statusPriority(i, none, none, question)).toBe(1);
  });
  it("idle + awaiting 'question' surfaces as Question", () => {
    const i = makeInstance({ session_id: "q", busy: false, awaiting: "question" });
    expect(statusPriority(i, none, none, deriveQuestionSet([i]))).toBe(1);
  });
});

/** Every set here is empty on purpose: these pin what a surface that never
 *  received the prompt broadcast (the phone, a second window, a fresh reload)
 *  renders from `Instance` alone. The daemon-side writers are
 *  `Registry::mark_turn_live` and `hooks_server::permission`. */
describe("daemon-authoritative status with no window-local state", () => {
  const none = new Set();
  const seg = (i) => sessionSegment(i, none, none, deriveQuestionSet([i]), none);

  it("a live turn is In Progress (chat 20176: this rendered as Done)", () => {
    const i = makeInstance({ session_id: "live", busy: true, awaiting: null });
    expect(seg(i)).toBe(2);
    expect(statusDotClass(i, none, none, deriveQuestionSet([i]))).toBe("st-working");
  });

  it("a self-resumed turn does not inherit the previous turn's 'done'", () => {
    // mark_turn_live clears awaiting, so the row cannot sit in Done while the
    // session works. The pre-fix shape is the second assertion.
    const after = makeInstance({ session_id: "bg", busy: true, awaiting: null });
    const before = makeInstance({ session_id: "bg", busy: false, awaiting: "done" });
    expect(seg(after)).toBe(2);
    expect(seg(before)).toBe(1);
  });

  it("a blocking permission prompt is Input Needed on every surface", () => {
    const i = makeInstance({ session_id: "perm", busy: true, awaiting: "question" });
    expect(seg(i)).toBe(0);
  });

  it("answering the prompt hands the row straight back to In Progress", () => {
    const i = makeInstance({ session_id: "perm", busy: true, awaiting: null });
    expect(seg(i)).toBe(2);
  });
});

describe("sessionSegment", () => {
  const none = new Set();
  const seg = (i, opts = {}) =>
    sessionSegment(
      i,
      opts.unread ?? none,
      opts.attention ?? none,
      opts.question ?? deriveQuestionSet([i]),
      opts.closing ?? none,
      opts.rateLimited ?? none,
      opts.scheduled ?? none,
    );

  it("a Done chat (idle or unread) with a pending scheduled message is Scheduled", () => {
    const idle = makeInstance({ session_id: "s1", busy: false, awaiting: "done" });
    expect(seg(idle, { scheduled: new Set(["s1"]) })).toBe(6);
    const unreadChat = makeInstance({ session_id: "s2", busy: false, awaiting: "done" });
    expect(seg(unreadChat, { unread: new Set(["s2"]), scheduled: new Set(["s2"]) })).toBe(6);
  });
  it("Input Needed still beats Scheduled", () => {
    const i = makeInstance({ session_id: "s3", busy: false, awaiting: "question" });
    expect(seg(i, { scheduled: new Set(["s3"]) })).toBe(0);
  });
  it("closing and rate-limited still beat Scheduled", () => {
    const i = makeInstance({ session_id: "s4", busy: false });
    expect(seg(i, { closing: new Set(["s4"]), scheduled: new Set(["s4"]) })).toBe(3);
    expect(seg(i, { rateLimited: new Set(["s4"]), scheduled: new Set(["s4"]) })).toBe(4);
  });

  it("closing overrides everything", () => {
    const i = makeInstance({ session_id: "c", busy: true, awaiting: "question" });
    expect(seg(i, { closing: new Set(["c"]) })).toBe(3);
  });
  it("rate-limited (and not closing) is Waiting for Reset", () => {
    const i = makeInstance({ session_id: "r" });
    expect(seg(i, { rateLimited: new Set(["r"]) })).toBe(4);
  });
  it("busy is In Progress", () => {
    expect(seg(makeInstance({ busy: true }))).toBe(2);
  });
  it("awaiting 'working' is In Progress, NOT Waiting", () => {
    expect(seg(makeInstance({ busy: false, awaiting: "working" }))).toBe(2);
  });
  it("awaiting 'waiting' is the Waiting segment", () => {
    expect(seg(makeInstance({ busy: false, awaiting: "waiting" }))).toBe(5);
  });
  it("awaiting 'question' is Input Needed", () => {
    expect(seg(makeInstance({ session_id: "q", busy: false, awaiting: "question" }))).toBe(0);
  });
  it("busy + awaiting 'question' (AUQ mid-turn) is Input Needed", () => {
    expect(seg(makeInstance({ session_id: "auq", busy: true, awaiting: "question" }))).toBe(0);
  });
  it("idle with awaiting 'done' is Done", () => {
    expect(seg(makeInstance({ busy: false, awaiting: "done" }))).toBe(1);
  });
  it("idle with no verdict is Done", () => {
    expect(seg(makeInstance({ busy: false }))).toBe(1);
  });
  it("frozen is not its own segment - falls through to its real state (rendered as a chip instead)", () => {
    expect(seg(makeInstance({ busy: false, frozen: true }))).toBe(1);
  });
  it("a rate-limit auto-freeze segments as Scheduled - it already has a resume queued", () => {
    const i = makeInstance({ session_id: "fr", frozen: true, auto_frozen: true });
    expect(seg(i, { rateLimited: new Set(["fr"]) })).toBe(6);
  });
  it("plain rate-limited (not auto-frozen) still segments as Waiting for Reset", () => {
    const i = makeInstance({ session_id: "r2", frozen: false, auto_frozen: false });
    expect(seg(i, { rateLimited: new Set(["r2"]) })).toBe(4);
  });
  // 2026-08-16 correction: Remote is driven by `kind` (a process this app
  // didn't spawn - terminal `claude` or a channel bridge), not `is_remote`
  // (which only means "reached over remote transport", e.g. phone/tailnet).
  it("kind 'external' (terminal-started) is Remote, wins over other state", () => {
    const i = makeInstance({ session_id: "ext", kind: "external", busy: true });
    expect(seg(i)).toBe(7);
  });
  it("kind 'automated' (channel bridge) is Remote", () => {
    expect(seg(makeInstance({ kind: "automated" }))).toBe(7);
  });
  it("is_remote alone (phone/tailnet transport) does NOT trigger Remote", () => {
    const i = makeInstance({ session_id: "phone", is_remote: true, busy: false });
    expect(seg(i)).toBe(1); // Done, same as any other idle interactive session
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
  it("statusPriority: awaiting==='question' fallback fires even when the question set omits the id", () => {
    const i = makeInstance({ session_id: "missing-from-set", busy: false, awaiting: "question" });
    expect(statusPriority(i, new Set(), new Set(), new Set())).toBe(1);
  });
  it("statusDotClass: has no such fallback - falls through to idle when the question set omits the id", () => {
    const i = makeInstance({ session_id: "missing-from-set", busy: false, awaiting: "question" });
    expect(statusDotClass(i, new Set(), new Set(), new Set())).toBe("st-your-turn");
  });
  it("statusDotClass: 'automated' kind shares 'external's class", () => {
    expect(statusDotClass(makeInstance({ kind: "automated" }), new Set(), new Set(), new Set())).toBe("st-external");
  });
});
