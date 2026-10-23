// Pure helpers behind the compact dashboard: plan-item summaries, report
// sentences, the sidebar's chat groups, the offerable quick actions, and the
// chip track's page arithmetic (fake chip boxes, no layout needed).

import { describe, it, expect } from "vitest";
import { chatGroupOf, firstSentence, offerableCommands, summarize } from "../src/views/sessions/projects-tab/format.ts";
import { atEnd, fitsAll, nextStart, prevStart } from "../src/views/sessions/projects-tab/quick-track.ts";

describe("summarize", () => {
  it("cuts at the first ' - ', '; ', '. ' or '(' that leaves a real headline", () => {
    expect(summarize("low priority: Shortcut hygiene - close sc-54841")).toBe("low priority: Shortcut hygiene");
    expect(summarize("wire the Amplitude SDK; then the login events")).toBe("wire the Amplitude SDK");
    expect(summarize("Retry failed ACH payouts. Then notify the borrower")).toBe("Retry failed ACH payouts");
    expect(summarize("Amplitude overview (insights, nav, Intercom)")).toBe("Amplitude overview");
  });

  it("takes whichever cut comes first", () => {
    expect(summarize("Android push via FCM (blocked); needs a key - ask Joe")).toBe("Android push via FCM");
  });

  it("skips a cut that would leave a bare label and keeps the whole line when none is left", () => {
    expect(summarize("[P] - BP Amplitude team invite / remove events")).toBe("[P] - BP Amplitude team invite / remove events");
    expect(summarize("Short one")).toBe("Short one");
  });

  it("ellipsizes a long line with no cut point", () => {
    const out = summarize("x".repeat(120));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(70);
  });
});

describe("firstSentence", () => {
  it("stops after the first sentence once it is long enough to read", () => {
    expect(firstSentence("**Shipped** the phone sheet fix in `dd1af90`, vitest green. Not pushed yet."))
      .toBe("Shipped the phone sheet fix in dd1af90, vitest green.");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
  });

  it("keeps reading past an opener too short to say anything", () => {
    expect(firstSentence("Hi. Claude has the full context from earlier: the 5 spawned chats. More."))
      .toBe("Hi. Claude has the full context from earlier: the 5 spawned chats.");
    expect(firstSentence("Retrospective. **Verdict:** mid. The right answer landed."))
      .toBe("Retrospective. Verdict: mid. The right answer landed.");
  });
});

describe("chat groups and quick actions", () => {
  it("maps statuses onto the sidebar's segments", () => {
    expect(["question", "working", "waiting", "your_turn", "ended"].map(chatGroupOf)).toEqual(["input", "progress", "progress", "done", null]);
  });

  it("never offers /close, with or without arguments, but keeps similarly named commands", () => {
    expect(offerableCommands(["/close", "/pickup", "/close now", "/closeout", "/Close"])).toEqual(["/pickup", "/closeout"]);
  });
});

describe("quick-action track paging", () => {
  // Six 80px chips, 6px apart, in a 300px window: chips 0-2 fit, 3-5 are the next page.
  const chips = Array.from({ length: 6 }, (_, i) => ({ left: i * 86, width: 80 }));

  it("the next page starts at the first chip that does not fully fit", () => {
    expect(nextStart(chips, 0, 300)).toBe(3);
    expect(nextStart(chips, 3, 300)).toBe(3);
  });

  it("the previous page ends right before the current start", () => {
    expect(prevStart(chips, 3, 300)).toBe(0);
    expect(prevStart(chips, 0, 300)).toBe(0);
    // two chips (166px) fit a 170px window, so the page before chip 4 starts at chip 2
    expect(prevStart(chips, 4, 170)).toBe(2);
  });

  it("knows when everything fits and when the last chip is already showing", () => {
    expect(fitsAll(chips, 300)).toBe(false);
    expect(fitsAll(chips, 600)).toBe(true);
    expect(fitsAll([], 10)).toBe(true);
    expect(atEnd(chips, 0, 300)).toBe(false);
    expect(atEnd(chips, 3, 300)).toBe(true);
  });
});
