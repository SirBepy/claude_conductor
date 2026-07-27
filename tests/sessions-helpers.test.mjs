import { describe, it, expect } from "vitest";
import {
  projectName,
  sessionSubtitle,
  statusPriority,
  stateTooltip,
  sortSessions,
  sessionSegment,
  statusDotClass,
  statusIndicator,
  deriveQuestionSet,
  isJarvisOrWorker,
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
    bridge_session_id: null,
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
  it("busy wins over a stale question flag", () => {
    expect(statusPriority(makeInstance({ session_id: "q-id", busy: true }), unread, noAttention, question)).toBe(2);
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
    );

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
  it("idle read -> st-your-turn", () => {
    expect(cls(makeInstance({ awaiting: "done" }))).toBe("st-your-turn");
  });
  it("busy + awaiting 'question' (AUQ mid-turn) -> st-question", () => {
    // The question class must win over the busy spinner so the row keeps
    // flagging until the daemon clears awaiting on answer.
    expect(cls(makeInstance({ session_id: "auq", busy: true, awaiting: "question" }))).toBe("st-question");
  });
});

describe("statusIndicator (icons mode)", () => {
  const none = new Set();
  const esc = (s) => s;
  const icon = (i) => statusIndicator(i, none, none, deriveQuestionSet([i]), "icons", esc);

  it("busy renders the spinner", () => {
    expect(icon(makeInstance({ busy: true }))).toContain("ph-spinner");
  });
  it("awaiting 'working' renders the spinner too", () => {
    expect(icon(makeInstance({ awaiting: "working" }))).toContain("ph-spinner");
  });
  it("awaiting 'question' renders the question icon", () => {
    expect(icon(makeInstance({ session_id: "q", awaiting: "question" }))).toContain("ph-chat-circle-dots");
  });
  it("awaiting 'waiting' renders the hourglass", () => {
    expect(icon(makeInstance({ awaiting: "waiting" }))).toContain("ph-hourglass-medium");
  });
  it("idle read renders the calm check", () => {
    expect(icon(makeInstance({}))).toContain("ph-check");
  });
});

describe("stateTooltip", () => {
  const noUnread = new Set();
  const withUnread = new Set(["abc123"]);
  const noAttention = new Set();
  const noQuestion = new Set();

  it("needs permission (attention)", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123" }), noUnread, new Set(["abc123"]), noQuestion)).toBe("Needs your permission - click to answer");
  });
  it("attention overrides busy", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: true }), noUnread, new Set(["abc123"]), noQuestion)).toBe("Needs your permission - click to answer");
  });
  it("external", () => {
    expect(stateTooltip(makeInstance({ kind: "external" }), noUnread, noAttention, noQuestion)).toBe("External session (read-only)");
  });
  it("working", () => {
    expect(stateTooltip(makeInstance({ busy: true }), noUnread, noAttention, noQuestion)).toBe("Claude is running");
  });
  it("question", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: false }), noUnread, noAttention, new Set(["abc123"]))).toBe("Claude asked a question - click to answer");
  });
  it("done unread", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: false }), withUnread, noAttention, noQuestion)).toBe("Claude responded - click to read");
  });
  it("your turn", () => {
    expect(stateTooltip(makeInstance({ busy: false }), noUnread, noAttention, noQuestion)).toBe("Done - your turn");
  });
});

describe("sortSessions", () => {
  const unread = new Set(["busy-id"]);
  const noAttention = new Set();
  const noQuestion = new Set();
  const working = makeInstance({ session_id: "busy-id", busy: true, started_at: "2026-05-08T09:00:00Z", cwd: "/p/beta" });
  const yourTurn = makeInstance({ session_id: "other-id", busy: false, started_at: "2026-05-08T07:00:00Z", cwd: "/p/gamma" });
  const external = makeInstance({ session_id: "ext-id", kind: "external", started_at: "2026-05-08T06:00:00Z", cwd: "/p/delta" });

  it("status sort: working first", () => {
    const sorted = sortSessions([yourTurn, working], "status", unread, noAttention, noQuestion);
    expect(sorted[0].session_id).toBe("busy-id");
  });
  it("status sort: a chat needing permission sorts above a busy one", () => {
    const attention = new Set(["other-id"]);
    const sorted = sortSessions([working, yourTurn], "status", unread, attention, noQuestion);
    expect(sorted[0].session_id).toBe("other-id");
  });
  it("status sort: a question sorts above a busy one", () => {
    const question = new Set(["other-id"]);
    const sorted = sortSessions([working, yourTurn], "status", unread, noAttention, question);
    expect(sorted[0].session_id).toBe("other-id");
  });
  it("name sort: alphabetical by project", () => {
    const sorted = sortSessions([working, yourTurn, external], "name", unread, noAttention, noQuestion);
    expect(sorted.map(s => projectName(s))).toEqual(["beta", "delta", "gamma"]);
  });
  it("recent sort: newest started_at first", () => {
    const sorted = sortSessions([yourTurn, working, external], "recent", unread, noAttention, noQuestion);
    expect(sorted[0]).toBe(working);
  });
  it("drain sort: heaviest drainer first, unknown drain sinks to bottom", () => {
    const drainBySession = new Map([
      ["busy-id", 12], // working
      ["ext-id", 47],  // external — heaviest
      // "other-id" (yourTurn) has no entry → unknown → sinks to bottom
    ]);
    const sorted = sortSessions(
      [working, yourTurn, external],
      "drain",
      unread,
      noAttention,
      noQuestion,
      new Set(),
      drainBySession,
    );
    expect(sorted.map(s => s.session_id)).toEqual(["ext-id", "busy-id", "other-id"]);
  });
});
