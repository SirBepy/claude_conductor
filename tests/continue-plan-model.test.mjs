// @vitest-environment jsdom
//
// "Continue the plan?" (pc-1806 step 6), the pure side: how the paused subs are worded, drawn as the
// `after` tree, and ticked. The checklist's cascade is the part the No path stands on: a tick on a
// target ticks what waits for it, an untick takes only that cascade back, and an unticked dependent
// of a stopped target is the one that runs without its wait (never a Blocked card).

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../src/shared/api.ts", () => ({ api: { listProjects: vi.fn(async () => []) } }));

const m = await import("../src/views/sessions/continue-plan-model.ts");
const mainChats = await import("../src/views/sessions/project-main-chats.ts");
const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");

const sub = (id, over = {}) => ({
  sub_id: id, name: id.toUpperCase(), prior: "working", needs_continue: true, machine_id: null, after: [], ...over,
});

// api -> web -> deploy: web waits for api, deploy waits for web. docs waits for nothing.
const CHAIN = [sub("api"), sub("web", { after: ["api"], prior: "held" }), sub("deploy", { after: ["web"], prior: "held" }), sub("docs", { prior: "idle", needs_continue: false })];

describe("the question's words", () => {
  it("counts the paused subs and names the first three", () => {
    expect(m.questionLine([sub("a")])).toBe("1 sub was paused when this chat was put away: A.");
    expect(m.questionLine([sub("a"), sub("b"), sub("c"), sub("d"), sub("e")])).toBe(
      "5 subs were paused when this chat was put away: A, B, C, and 2 more.",
    );
    expect(m.questionLine([])).toBe("");
  });

  it("names a sub with no name by the start of its id", () => {
    expect(m.subLabel(sub("12345678-aaaa", { name: null }))).toBe("12345678");
    expect(m.subLabel(sub("x", { name: "  " }))).toBe("x");
  });

  it("says what the pause froze", () => {
    expect(m.priorWords(sub("a", { prior: "held" }))).toBe("has not started");
    expect(m.priorWords(sub("a"))).toBe("was working");
    expect(m.priorWords(sub("a", { prior: "idle", needs_continue: false }))).toBe("was between turns");
    expect(m.priorWords(sub("a", { prior: "unknown", needs_continue: false }))).toBe("paused");
  });
});

describe("the checklist tree", () => {
  it("draws a sub under the sub it waits for, in reading order", () => {
    const rows = m.checklistRows(CHAIN).map((r) => [r.sub.sub_id, r.depth]);
    expect(rows).toEqual([["api", 0], ["web", 1], ["deploy", 2], ["docs", 0]]);
  });

  it("a sub that waits only for something not in the list is a root", () => {
    const rows = m.checklistRows([sub("a", { after: ["gone"] })]).map((r) => [r.sub.sub_id, r.depth]);
    expect(rows).toEqual([["a", 0]]);
  });

  it("a cycle never loops and every sub still gets one row", () => {
    const rows = m.checklistRows([sub("a", { after: ["b"] }), sub("b", { after: ["a"] })]);
    expect(rows.map((r) => r.sub.sub_id).sort()).toEqual(["a", "b"]);
  });

  it("finds dependents at any depth, once", () => {
    expect(m.dependentsOf(CHAIN, "api").sort()).toEqual(["deploy", "web"]);
    expect(m.dependentsOf(CHAIN, "web")).toEqual(["deploy"]);
    expect(m.dependentsOf(CHAIN, "docs")).toEqual([]);
  });
});

describe("ticking", () => {
  it("ticking a target ticks everything that waits for it, and untick takes the cascade back", () => {
    let t = m.toggle(CHAIN, m.NO_TICKS, "api");
    expect([...t.ticked].sort()).toEqual(["api", "deploy", "web"]);
    t = m.toggle(CHAIN, t, "api");
    expect([...t.ticked]).toEqual([]);
  });

  it("a dependent can be unticked: it then runs without waiting, the rest of the cascade stays", () => {
    let t = m.toggle(CHAIN, m.NO_TICKS, "api");
    t = m.toggle(CHAIN, t, "deploy");
    expect([...t.ticked].sort()).toEqual(["api", "web"]);
    expect(m.releasedSubs(CHAIN, t.ticked).map((s) => s.sub_id)).toEqual(["deploy"]);
  });

  it("untick of the target leaves a tick the user made by hand", () => {
    let t = m.toggle(CHAIN, m.NO_TICKS, "deploy"); // by hand, first
    t = m.toggle(CHAIN, t, "api"); // cascade tries web and deploy
    t = m.toggle(CHAIN, t, "api"); // takes back only its own: web
    expect([...t.ticked]).toEqual(["deploy"]);
  });

  it("a sub nobody waits for is released by nothing", () => {
    const t = m.toggle(CHAIN, m.NO_TICKS, "docs");
    expect(m.releasedSubs(CHAIN, t.ticked)).toEqual([]);
  });

  it("the confirm button says what it will do", () => {
    expect(m.confirmLabel(CHAIN, new Set())).toBe("Resume all");
    expect(m.confirmLabel(CHAIN, new Set(["api", "web"]))).toBe("Stop 2, resume 2");
    expect(m.confirmLabel(CHAIN, new Set(["api", "web", "deploy", "docs"]))).toBe("Stop all 4");
    expect(m.confirmLabel([sub("only")], new Set(["only"]))).toBe("Stop it");
  });

  it("the toast after an answer", () => {
    expect(m.answeredToast(0, 3)).toBe("Resuming 3 subs");
    expect(m.answeredToast(0, 1)).toBe("Resuming 1 sub");
    expect(m.answeredToast(2, 1)).toBe("Stopped 2, resuming 1");
    expect(m.answeredToast(2, 0)).toBe("Stopped 2");
  });
});

describe("which chat a draft or the dashboard reopens", () => {
  const inst = (over = {}) => ({
    session_id: "main", pid: 1, cwd: "C:/Projects/cv", project_id: "p-cv", kind: "interactive", is_remote: false,
    started_at: "2026-11-12T10:00:00Z", transcript_path: null, name: "CV redesign", ended_at: null, end_reason: null,
    closing: false, machine: null, subchat_of: null, hidden_at: null, ...over,
  });
  const away = inst({ hidden_at: "2026-11-21T10:00:00Z" });
  const subs = [inst({ session_id: "s1", subchat_of: "main" }), inst({ session_id: "s2", subchat_of: "main", subchat_finished: true })];

  function setup() {
    adoptSubchatsOn("main");
    mainChats.setProjectMainChatsForTest([{ id: "p-cv", path: "C:/Projects/cv", name: "cv-site", mainChatId: "main" }]);
  }

  it("a put-away main chat is a reopen target with its paused count, never a plain route", () => {
    setup();
    expect(mainChats.mainChatFor("C:/Projects/cv", [away, ...subs])).toBeNull();
    const t = mainChats.reopenTargetFor("C:/Projects/cv", [away, ...subs]);
    expect(t?.chat.session_id).toBe("main");
    expect(t?.paused).toBe(1);
    expect(mainChats.reopenLine(t).paused).toBe(": paused, 1 sub");
  });

  it("a live main chat is not a reopen target", () => {
    setup();
    expect(mainChats.reopenTargetFor("C:/Projects/cv", [inst()])).toBeNull();
    expect(mainChats.mainChatFor("C:/Projects/cv", [inst()])?.chat.session_id).toBe("main");
  });

  it("the dashboard door finds the main chat live or put away, and none for a closing or mirrored one", () => {
    setup();
    expect(mainChats.openableMainFor("C:/Projects/cv", [inst()])).toMatchObject({ putAway: false, paused: 0 });
    expect(mainChats.openableMainFor("C:/Projects/cv", [away, ...subs])).toMatchObject({ putAway: true, paused: 1 });
    expect(mainChats.openableMainFor("C:/Projects/cv", [inst({ closing: true })])).toBeNull();
    expect(mainChats.openableMainFor("C:/Projects/cv", [inst({ machine: { id: "m", name: "x" } })])).toBeNull();
  });

  it("the line has no count when nothing is paused", () => {
    setup();
    const t = mainChats.reopenTargetFor("C:/Projects/cv", [away]);
    expect(mainChats.reopenLine(t).paused).toBe("");
  });
});
