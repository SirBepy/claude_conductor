// The Drafts panel opens on people, not on every draft ever written. These pin
// the sorting rules: what counts as open, who gets a row, what folds away.

import { describe, it, expect } from "vitest";

const { groupDrafts, isOpen, STALE_MS, variantFor } = await import("../src/views/sessions/drafts-grouping.ts");

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

  it("sends a person-less draft to its platform section, never to People", () => {
    const g = groupDrafts([draft({ variants: [{ platform: "Shortcut", recipient: "sc-56117 comment" }] })], [], "s1", NOW);
    expect(g.people).toHaveLength(0);
    expect(g.platforms.map((p) => p.name)).toEqual(["Shortcut"]);
  });

  it("folds a platform with nothing open and nothing this week", () => {
    const g = groupDrafts(
      [
        draft({ variants: [{ platform: "Shortcut" }] }),
        draft({ state: "copied", updated: daysAgo(10), variants: [{ platform: "Standup" }] }),
      ],
      [],
      "s1",
      NOW,
    );
    expect(g.platforms.map((p) => p.name)).toEqual(["Shortcut"]);
    expect(g.quietPlatforms.map((p) => p.name)).toEqual(["Standup"]);
  });

  it("merges platform spellings that differ only by case", () => {
    const g = groupDrafts(
      [draft({ variants: [{ platform: "Slack" }] }), draft({ variants: [{ platform: "slack" }] })],
      [],
      "s1",
      NOW,
    );
    expect(g.platforms).toHaveLength(1);
    expect(g.platforms[0].drafts).toHaveLength(2);
  });

  it("still shows a plain name the vault doesn't know as a person, unlinked", () => {
    const g = groupDrafts([draft({ variants: [{ recipient: "Stevan" }] })], [], "s1", NOW);
    expect(g.people[0]).toMatchObject({ name: "Stevan", personId: null });
  });

  it("folds people with nothing open and nothing this week behind one line", () => {
    const g = groupDrafts(
      [
        draft({ variants: [{ person: LENAR.id }] }),
        draft({ state: "copied", updated: daysAgo(20), variants: [{ recipient: "Airion" }] }),
      ],
      [LENAR],
      "s1",
      NOW,
    );
    expect(g.people.map((p) => p.name)).toEqual(["Lenar Rakhmatulin"]);
    expect(g.quietPeople.map((p) => p.name)).toEqual(["Airion"]);
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
