// asserts: src/shared/chat/dashboard/subs-model.ts

// The Subchats card's "N queued" count and popup list (Joe, 2026-11-18): a sub the daemon holds
// has no process, so it is counted apart from the stuck ones, ordered by when it starts, and
// described by what it waits for.

import { describe, it, expect } from "vitest";
import { cardCounts, queuedSubs, startsAfterText, QUEUED_FOOTNOTE, type SubCardItem } from "./subs-model";

const item = (id: string, kind: SubCardItem["kind"], extra: Partial<SubCardItem> = {}): SubCardItem => ({
  id, name: id, kind, closing: false, model: "claude-sonnet-4-6", effort: "high",
  progress: "", startedAt: null, finishedAt: null, ring: { kind: "none" }, ...extra,
});
const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((i) => i.id);
const q = (id: string, over: Partial<SubCardItem> = {}, queue: Partial<{ waitingFor: string | null; place: number | null; behind: string | null }> = {}): SubCardItem => item(id, "queued", {
  startedAt: "2026-11-18T10:00:00Z",
  hover: { stateWord: "Queued", step: null, plan: null, action: null, queue: { waitingFor: null, place: null, behind: null, ...queue }, resetsAt: null, gaming: false },
  ...over,
});

describe("queued subs are not stuck", () => {
  it("counts queued subs apart from the stuck ones, which keep their wording", () => {
    const c = cardCounts([item("w", "working"), item("a", "asking"), q("q1"), q("q2"), q("q3"), item("p", "paused"), item("s", "stopped"), item("l", "limited"), item("d", "finished")]);
    expect(c).toEqual({ lead: "1 working · 1 asking · 3 stuck or waiting", queued: 3 });
  });

  it("a card of only queued subs has no lead words, and one with none has a queued count of 0", () => {
    expect(cardCounts([q("q1"), q("q2")])).toEqual({ lead: "", queued: 2 });
    expect(cardCounts([item("w", "working"), item("s", "stopped")])).toEqual({ lead: "1 working · 1 stuck or waiting", queued: 0 });
    expect(cardCounts([])).toEqual({ lead: "", queued: 0 });
    expect(cardCounts([item("d", "finished")])).toEqual({ lead: "", queued: 0 });
  });
});

describe("the queued list", () => {
  it("lists only queued subs: the writer line by place, then the held ones by when they were created", () => {
    const list = queuedSubs([
      item("w", "working"),
      q("late", { startedAt: "2026-11-18T10:05:00Z" }),
      q("two", {}, { place: 2 }),
      q("early", { startedAt: "2026-11-18T10:01:00Z" }),
      q("one", {}, { place: 1 }),
      q("nodate", { startedAt: null }),
    ]);
    expect(ids(list)).toEqual(["one", "two", "early", "late", "nodate"]);
  });

  it("does not reorder the list it is given", () => {
    const given = [q("b", { startedAt: "2026-11-18T10:05:00Z" }), q("a", { startedAt: "2026-11-18T10:01:00Z" })];
    queuedSubs(given);
    expect(ids(given)).toEqual(["b", "a"]);
  });

  it("says what a queued sub waits for: one name, a count for a list, the writer holder, else later", () => {
    expect(startsAfterText(q("a", {}, { waitingFor: "waiting for header" }))).toBe("Starts after header");
    expect(startsAfterText(q("a", {}, { waitingFor: "Footer" }))).toBe("Starts after Footer");
    expect(startsAfterText(q("a", {}, { waitingFor: "waiting for header, footer, form" }))).toBe("Starts after 3 chats");
    expect(startsAfterText(q("a", {}, { waitingFor: "waiting for the writer before it", behind: "Auth" }))).toBe("Starts after Auth");
    expect(startsAfterText(q("a", {}, { behind: "Auth", place: 1 }))).toBe("Starts after Auth");
    expect(startsAfterText(q("a", {}, { behind: "Auth", place: 3 }))).toBe("Starts after 3 chats");
    expect(startsAfterText(q("a", {}, { waitingFor: "waiting on its main chat for a" }))).toBe("Starts later");
    expect(startsAfterText(q("a"))).toBe("Starts later");
    expect(startsAfterText(item("w", "working"))).toBe("Starts later");
  });

  it("keeps the footnote the popup shows", () => {
    expect(QUEUED_FOOTNOTE).toBe("Queued chats have no process and use no memory until they start.");
  });
});
