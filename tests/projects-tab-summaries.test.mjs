// Pure helpers behind the compact dashboard: plan-item summaries, report
// sentences, the sidebar's chat groups and the offerable quick actions.

import { describe, it, expect } from "vitest";
import { chatGroupOf, offerableCommands, summarize } from "../src/views/sessions/projects-tab/format.ts";

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

describe("chat groups and quick actions", () => {
  it("maps statuses onto the sidebar's segments", () => {
    expect(["question", "working", "waiting", "your_turn", "ended"].map(chatGroupOf)).toEqual(["input", "progress", "progress", "done", null]);
  });

  it("never offers /close, with or without arguments, but keeps similarly named commands", () => {
    expect(offerableCommands(["/close", "/pickup", "/close now", "/closeout", "/Close"])).toEqual(["/pickup", "/closeout"]);
  });
});
