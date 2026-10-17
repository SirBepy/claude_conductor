// The Drafts panel opens on people, not on every draft ever written. These pin
// the sorting rules: what counts as open, who gets a row, which ticket tracker
// gets a tab.

import { describe, it, expect } from "vitest";

const { groupDrafts, isOpen, STALE_MS, variantFor, variantOn, withoutTicket } = await import("../src/views/sessions/drafts-grouping.ts");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

let seq = 0;
function draft({ topic = "t", state = "needs-you", updated = daysAgo(0), origin = "s1", variants }) {
  seq++;
  return {
    id: `d${seq}`,
    topic,
    brief: "",
    receipts: [],
    variants: variants.map((v, i) => ({
      recipient: v.recipient ?? v.person ?? v.platform,
      handle_n: i + 1,
      versions: [{ n: 1, body: "hi", author: "ai", note: "", created_at: updated }],
      current: 1,
      person: v.person ?? null,
      platform: v.platform ?? null,
    })),
    state,
    origin_session_id: origin,
    origin_label: origin,
    created_at: updated,
    updated_at: updated,
    seen_by_origin: true,
  };
}

const LENAR = { id: "Lenar Rakhmatulin", name: "Lenar Rakhmatulin", aliases: ["Lenar"], relationship: "coworker (Zirtue QA)" };

describe("isOpen", () => {
  it("retires copied, archived, and week-old drafts", () => {
    expect(isOpen(draft({ variants: [{ person: "x" }] }), NOW)).toBe(true);
    expect(isOpen(draft({ state: "copied", variants: [{ person: "x" }] }), NOW)).toBe(false);
    expect(isOpen(draft({ state: "archived", variants: [{ person: "x" }] }), NOW)).toBe(false);
    expect(isOpen(draft({ updated: new Date(NOW - STALE_MS - 1).toISOString(), variants: [{ person: "x" }] }), NOW)).toBe(false);
  });
});

describe("groupDrafts", () => {
  it("pins only this chat's open drafts on top", () => {
    const mine = draft({ origin: "s1", variants: [{ person: LENAR.id }] });
    const sent = draft({ origin: "s1", state: "copied", variants: [{ person: LENAR.id }] });
    const other = draft({ origin: "s2", variants: [{ person: LENAR.id }] });
    const g = groupDrafts([mine, sent, other], [LENAR], "s1", NOW);
    expect(g.mine.map((d) => d.id)).toEqual([mine.id]);
  });

  it("gives a vault person one row with their real name, relationship, and open count", () => {
    const g = groupDrafts(
      [draft({ variants: [{ person: LENAR.id }] }), draft({ state: "copied", variants: [{ person: LENAR.id }] })],
      [LENAR],
      "s1",
      NOW,
    );
    expect(g.people).toHaveLength(1);
    expect(g.people[0]).toMatchObject({ name: "Lenar Rakhmatulin", relationship: "coworker (Zirtue QA)", open: 1 });
    expect(g.people[0].drafts).toHaveLength(2);
  });

  it("sends a person-less draft to its place, never to People", () => {
    const g = groupDrafts([draft({ variants: [{ platform: "Standup", recipient: "standup" }] })], [], "s1", NOW);
    expect(g.people).toHaveLength(0);
    expect(g.places.map((p) => p.name)).toEqual(["Standup"]);
    expect(g.places[0].open).toBe(1);
  });

  it("lists a place with something open before one with nothing open", () => {
    const g = groupDrafts(
      [
        draft({ state: "copied", updated: daysAgo(0), variants: [{ platform: "Standup" }] }),
        draft({ updated: daysAgo(2), variants: [{ platform: "Prompts" }] }),
      ],
      [],
      "s1",
      NOW,
    );
    expect(g.places.map((p) => p.name)).toEqual(["Prompts", "Standup"]);
  });

  it("merges platform spellings that differ only by case", () => {
    const g = groupDrafts(
      [draft({ variants: [{ platform: "Slack" }] }), draft({ variants: [{ platform: "slack" }] })],
      [],
      "s1",
      NOW,
    );
    expect(g.places).toHaveLength(1);
    expect(g.places[0].drafts).toHaveLength(2);
  });

  it("still shows a plain name the vault doesn't know as a person, unlinked", () => {
    const g = groupDrafts([draft({ variants: [{ recipient: "Stevan" }] })], [], "s1", NOW);
    expect(g.people[0]).toMatchObject({ name: "Stevan", personId: null });
  });

  it("keeps people with nothing open in the list, after the ones with something open", () => {
    const g = groupDrafts(
      [
        draft({ state: "copied", updated: daysAgo(20), variants: [{ recipient: "Airion" }] }),
        draft({ variants: [{ person: LENAR.id }] }),
      ],
      [LENAR],
      "s1",
      NOW,
    );
    expect(g.people.map((p) => [p.name, p.open])).toEqual([["Lenar Rakhmatulin", 1], ["Airion", 0]]);
  });

  it("puts people with something open above people who are all sent, then newest first", () => {
    const g = groupDrafts(
      [
        draft({ state: "copied", updated: daysAgo(0), variants: [{ recipient: "Stevan" }] }),
        draft({ updated: daysAgo(3), variants: [{ recipient: "Johanna" }] }),
        draft({ updated: daysAgo(1), variants: [{ person: LENAR.id }] }),
      ],
      [LENAR],
      "s1",
      NOW,
    );
    expect(g.people.map((p) => p.name)).toEqual(["Lenar Rakhmatulin", "Johanna", "Stevan"]);
  });

  it("lists a two-recipient card under both people, each excerpting their own variant", () => {
    const d = draft({ variants: [{ recipient: "Stevan" }, { person: LENAR.id }] });
    const g = groupDrafts([d], [LENAR], "s1", NOW);
    expect(g.people).toHaveLength(2);
    const lenarKey = g.people.find((p) => p.personId === LENAR.id).key;
    expect(variantFor(d, lenarKey).person).toBe(LENAR.id);
  });
});

// The user's rule: a tracker tab holds what gets POSTED on the tracker, one row
// per ticket, and a comment to a person shows under that person too.
describe("tracker tabs", () => {
  it("puts a Shortcut comment to a person under the person AND under its ticket", () => {
    const d = draft({ topic: "sc-56157 retest note", variants: [{ person: LENAR.id, platform: "Shortcut" }] });
    const g = groupDrafts([d], [LENAR], "s1", NOW);
    expect(g.people.map((p) => p.name)).toEqual(["Lenar Rakhmatulin"]);
    expect(g.trackers.map((t) => t.name)).toEqual(["Shortcut"]);
    expect(g.trackers[0].tickets[0]).toMatchObject({ ticket: "sc-56157", label: "retest note", people: ["Lenar Rakhmatulin"], open: 1 });
  });

  it("keeps a ticket-wide comment under its ticket only", () => {
    const g = groupDrafts([draft({ topic: "Blocked reason", variants: [{ platform: "Shortcut", recipient: "Shortcut ticket sc-56117" }] })], [], "s1", NOW);
    expect(g.people).toHaveLength(0);
    expect(g.places).toHaveLength(0);
    expect(g.trackers[0].tickets[0]).toMatchObject({ ticket: "sc-56117", people: [] });
  });

  it("reads a plain name on a tracker as a person, not as a ticket-wide comment", () => {
    const g = groupDrafts([draft({ topic: "sc-56167 overridden result", variants: [{ platform: "Shortcut", recipient: "Johanna" }] })], [], "s1", NOW);
    expect(g.people.map((p) => p.name)).toEqual(["Johanna"]);
    expect(g.trackers[0].tickets[0].people).toEqual(["Johanna"]);
  });

  it("groups by ticket, reading a bare leading number as a Shortcut id", () => {
    const g = groupDrafts(
      [
        draft({ topic: "56159 two-drafts repro", variants: [{ person: LENAR.id, platform: "Shortcut" }] }),
        draft({ topic: "sc-56159 follow-up", updated: daysAgo(1), variants: [{ person: LENAR.id, platform: "Shortcut" }] }),
      ],
      [LENAR],
      "s1",
      NOW,
    );
    expect(g.trackers[0].tickets).toHaveLength(1);
    expect(g.trackers[0].tickets[0].drafts).toHaveLength(2);
  });

  it("gives no tab to a tracker nothing was posted on, and none to a draft only ABOUT a ticket", () => {
    const g = groupDrafts([draft({ topic: "Lender DOB, sc-56160", variants: [{ recipient: "Stevan" }] })], [], "s1", NOW);
    expect(g.trackers).toEqual([]);
  });

  it("orders tracker tabs Shortcut then Linear, and reads a Linear id", () => {
    const g = groupDrafts(
      [
        draft({ topic: "REV-7345 copy", variants: [{ platform: "Linear", recipient: "Linear comment on REV-7345" }] }),
        draft({ topic: "sc-1 x", variants: [{ platform: "Shortcut", recipient: "sc-1 comment" }] }),
      ],
      [],
      "s1",
      NOW,
    );
    expect(g.trackers.map((t) => t.name)).toEqual(["Shortcut", "Linear"]);
    expect(g.trackers[1].tickets[0].ticket).toBe("REV-7345");
  });

  it("a ticket speaks for the variant posted on its tracker, not the card's first one", () => {
    const d = draft({ topic: "sc-7 note", variants: [{ platform: "Email", recipient: "Ana" }, { person: LENAR.id, platform: "Shortcut" }] });
    const g = groupDrafts([d], [LENAR], "s1", NOW);
    expect(g.trackers[0].tickets[0]).toMatchObject({ tracker: "Shortcut", people: ["Lenar Rakhmatulin"] });
    expect(variantOn(d, "Shortcut").person).toBe(LENAR.id);
  });

  it("puts tickets with something open first", () => {
    const g = groupDrafts(
      [
        draft({ topic: "sc-1 old", state: "copied", variants: [{ platform: "Shortcut", recipient: "sc-1 comment" }] }),
        draft({ topic: "sc-2 new", updated: daysAgo(2), variants: [{ platform: "Shortcut", recipient: "sc-2 comment" }] }),
      ],
      [],
      "s1",
      NOW,
    );
    expect(g.trackers[0].tickets.map((t) => t.ticket)).toEqual(["sc-2", "sc-1"]);
  });
});

describe("withoutTicket", () => {
  it("drops the id and the bare number, keeping what it is about", () => {
    expect(withoutTicket("sc-56160 phone gap on claim", "sc-56160")).toBe("phone gap on claim");
    expect(withoutTicket("Lender under-13 DOB, sc-56160", "sc-56160")).toBe("Lender under-13 DOB");
    expect(withoutTicket("56159 + 55930 questions", "sc-56159")).toBe("55930 questions");
    expect(withoutTicket("sc-1", "sc-1")).toBe("sc-1");
  });
});
