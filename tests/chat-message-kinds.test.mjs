// @vitest-environment jsdom
// asserts: src/shared/chat/chat-message-kinds.ts, src/shared/chat/chat-message-card.ts

// A send_message that declares a `kind` draws as a verdict card; one that does
// not (every old transcript) renders exactly the plain bubble it always did.

import { describe, it, expect, beforeEach } from "vitest";

const { parseMessageCard, headlineOf, bodyOf } = await import("../src/shared/chat/chat-message-kinds.ts");
const { renderMessage, renderTextBlock } = await import("../src/shared/chat/chat-transforms.ts");
const { eventToRenderedMessage } = await import("../src/shared/chat/chat-event-to-message.ts");
const { handleToolUseEvent } = await import("../src/shared/chat/chat-event-handler-tools.ts");
const { linkifyDrillRefs } = await import("../src/shared/chat/drill-links.ts");

const TOOL = "mcp__cc_conductor__send_message";

const REPORT_INPUT = {
  kind: "report",
  verdict: "Built, not pushed",
  text: "sc-56605 committed as `c083bd89`\nA second line of detail.",
  done: ["Analyze", "Unit tests", "e2e", "Link goes to the biller", " "],
  not_done: ["Biller turned off mid-flow"],
  waiting_on: ["Gate chat"],
  your_move: ["Ask Lenar about QA"],
};

function card(input) {
  return parseMessageCard(input);
}
function msg(input, extra = {}) {
  const ev = { type: "tool_use", tool_name: TOOL, input, id: "t1", timestamp: 1, parent_tool_use_id: null };
  return { ...eventToRenderedMessage(ev), ...extra };
}
function mount(m) {
  const root = document.createElement("div");
  root.innerHTML = renderMessage(m);
  document.body.appendChild(root);
  linkifyDrillRefs(root, root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("parseMessageCard", () => {
  it("is undefined without a valid kind, so the message stays a plain bubble", () => {
    expect(card({ text: "hi" })).toBeUndefined();
    expect(card({ text: "hi", kind: "progress" })).toBeUndefined();
    expect(card({ text: "hi", kind: 7 })).toBeUndefined();
    expect(card({ text: "hi", kind: "REPORT" })).toBeUndefined();
    expect(card(null)).toBeUndefined();
    expect(card("report")).toBeUndefined();
  });

  it("reads every field of a report and drops malformed rows", () => {
    expect(card(REPORT_INPUT)).toEqual({
      kind: "report",
      verdict: "Built, not pushed",
      tone: undefined,
      points: undefined,
      done: ["Analyze", "Unit tests", "e2e", "Link goes to the biller"],
      notDone: ["Biller turned off mid-flow"],
      waitingOn: ["Gate chat"],
      yourMove: ["Ask Lenar about QA"],
    });
  });

  it("drops a wrongly-typed field instead of failing the card", () => {
    const c = card({ kind: "answer", verdict: 5, tone: "loud", points: "one", done: ["x"] });
    expect(c).toEqual({ kind: "answer", verdict: undefined, tone: undefined, points: undefined });
    expect(card({ kind: "report", done: "nope", not_done: [1, null, ""] })?.done).toBeUndefined();
    expect(card({ kind: "report", not_done: [1, null, ""] })?.notDone).toBeUndefined();
  });

  it("keeps a verdict off the kinds that carry none, and the ack bare", () => {
    expect(card({ kind: "plan", verdict: "Ready" }).verdict).toBeUndefined();
    expect(card({ kind: "handoff", verdict: "Ready" }).verdict).toBeUndefined();
    expect(card({ kind: "artifact", verdict: "Ready" }).verdict).toBeUndefined();
    expect(card({ kind: "ack", verdict: "Ready", points: ["a"] })).toEqual({ kind: "ack", tone: undefined });
  });

  it("takes `was` only on a correction and `copy` only on do_this, copy untrimmed", () => {
    expect(card({ kind: "correction", was: " old claim " }).was).toBe("old claim");
    expect(card({ kind: "answer", was: "x" }).was).toBeUndefined();
    expect(card({ kind: "do_this", copy: "git push\n" }).copy).toBe("git push\n");
    expect(card({ kind: "answer", copy: "x" }).copy).toBeUndefined();
    expect(card({ kind: "do_this", copy: "  " }).copy).toBeUndefined();
  });

  it("splits the text into a headline and a muted body", () => {
    expect(headlineOf("  First line \nsecond\nthird")).toBe("First line");
    expect(bodyOf("First line\nsecond\nthird")).toBe("second\nthird");
    expect(bodyOf("only one line")).toBe("");
  });
});

describe("the mappers carry the card", () => {
  it("sets card on the older-page path and the live path alike", () => {
    const ev = { type: "tool_use", tool_name: TOOL, input: REPORT_INPUT, id: "t1", timestamp: 1, parent_tool_use_id: null };
    expect(eventToRenderedMessage(ev).card?.kind).toBe("report");
    const r = { messages: [] };
    handleToolUseEvent(r, ev, 1);
    expect(r.messages[0].card?.kind).toBe("report");
    expect(r.messages[0].card).toEqual(eventToRenderedMessage(ev).card);
  });

  it("leaves a kindless send_message without a card", () => {
    const ev = { type: "tool_use", tool_name: TOOL, input: { text: "hello" }, id: "t1", timestamp: 1, parent_tool_use_id: null };
    expect(eventToRenderedMessage(ev).card).toBeUndefined();
  });
});

describe("a message with no kind", () => {
  it("renders byte for byte the plain bubble", () => {
    const m = { kind: "message", text: "Pushed 3 commits.", id: "t", ts: 1, parentToolUseId: null };
    const expected = `<div class="msg assistant"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${renderTextBlock("Pushed 3 commits.")}</div>`;
    expect(renderMessage(m)).toBe(expected);
    expect(renderMessage({ ...m, card: undefined })).toBe(expected);
    // An unrecognised kind parses to no card, so it is the same bubble.
    expect(renderMessage(msg({ text: "Pushed 3 commits.", kind: "status" }))).toBe(expected);
  });

  it("keeps the details attribute and the dimmed class", () => {
    const details = [{ id: "a", label: "A", body_md: "x" }];
    const html = renderMessage({ kind: "message", text: "x", dimmed: true, details });
    expect(html).toContain('class="msg assistant dimmed"');
    expect(html).toContain("data-details=");
  });
});

describe("the report card", () => {
  it("prints verdict, headline, a Your move section and chips with no words", () => {
    const root = mount(msg(REPORT_INPUT));
    const full = root.querySelector(".mc-full");
    expect(full.querySelector(".mc-verdict").textContent).toBe("Built, not pushed");
    expect(full.querySelector(".mc-head").textContent).toContain("sc-56605 committed as");
    expect(full.querySelector(".mc-head code").textContent).toBe("c083bd89");
    expect(full.querySelector(".mc-body").textContent).toContain("A second line of detail.");
    const yours = full.querySelector(".mc-pad > .mc-secs .mc-sec--yours");
    expect(yours.querySelector(".mc-sec-label").textContent).toBe("Your move");
    expect(yours.textContent).toContain("Ask Lenar about QA");

    const chips = [...full.querySelectorAll(".mc-more > summary .mc-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["4", "1", "1"]);
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["4 done", "1 not done", "1 waiting"]);
    expect(chips.map((c) => c.getAttribute("title"))).toEqual(["4 done", "1 not done", "1 waiting"]);
    expect(chips.map((c) => c.querySelector("i").className)).toEqual(["ph ph-check", "ph ph-warning-circle", "ph ph-hourglass-medium"]);
    // The summary reads as numbers only, never a word.
    expect(full.querySelector(".mc-more > summary").textContent.trim()).toMatch(/^[\d\s]+$/);
  });

  it("opens onto Not done, Waiting on and Done sections", () => {
    const root = mount(msg(REPORT_INPUT));
    const secs = [...root.querySelectorAll(".mc-full .mc-more > .mc-secs .mc-sec")];
    expect(secs.map((s) => s.querySelector(".mc-sec-label").textContent)).toEqual(["Not done", "Waiting on", "Done"]);
    expect(secs[2].querySelectorAll(".mc-row").length).toBe(4);
  });

  it("omits a chip for a type with no rows, and the details when there are no rows at all", () => {
    const root = mount(msg({ kind: "report", verdict: "Fixed", text: "The popover fix is in", done: ["a", "b"] }));
    expect([...root.querySelectorAll(".mc-full .mc-chip")].map((c) => c.getAttribute("aria-label"))).toEqual(["2 done"]);
    const bare = mount(msg({ kind: "report", verdict: "Fixed", text: "Nothing to add" }));
    expect(bare.querySelector(".mc-full .mc-more")).toBeNull();
    expect(bare.querySelector(".mc-full .mc-secs")).toBeNull();
  });

  it("shows no Your move section without your_move rows", () => {
    const root = mount(msg({ ...REPORT_INPUT, your_move: undefined }));
    expect(root.querySelector(".mc-full .mc-sec--yours")).toBeNull();
  });

  it("colours the verdict by its rows: split when something is open, green when nothing is", () => {
    const split = mount(msg(REPORT_INPUT)).querySelector(".mc-full .mc-verdict");
    expect(split.querySelector(".mc-t-good").textContent).toBe("Built,");
    expect(split.querySelector(".mc-t-warn").textContent).toBe("not pushed");

    document.body.innerHTML = "";
    const noComma = mount(msg({ kind: "report", verdict: "Built", text: "x", waiting_on: ["a gate"] })).querySelector(".mc-full .mc-verdict");
    expect(noComma.querySelector(".mc-t-warn").textContent).toBe("Built");
    expect(noComma.querySelector(".mc-t-good")).toBeNull();

    document.body.innerHTML = "";
    const clean = mount(msg({ kind: "report", verdict: "Fixed, nothing for you", text: "x", done: ["a"] })).querySelector(".mc-full .mc-verdict");
    expect(clean.querySelectorAll(".mc-t-good").length).toBe(1);
    expect(clean.querySelector(".mc-t-warn")).toBeNull();
    expect(clean.textContent).toBe("Fixed, nothing for you");
  });

  it("renders each details entry as the existing drill chip", () => {
    const details = [{ id: "calls", label: "3 calls to check", body_md: "- a" }];
    const root = mount(msg(REPORT_INPUT, { details }));
    const chip = root.querySelector(".mc-full .mc-more .drill-chip");
    expect(chip.textContent).toBe("3 calls to check");
    expect(root.querySelector(".mc-root").getAttribute("data-details")).toContain("calls");
  });

  it("shows details chips even when the report has no rows to fold them behind", () => {
    const details = [{ id: "calls", label: "3 calls", body_md: "- a" }];
    const root = mount(msg({ kind: "report", verdict: "Fixed", text: "x" }, { details }));
    expect(root.querySelector(".mc-full > .mc-clip .mc-drills .drill-chip")).not.toBeNull();
    expect(root.querySelector(".mc-full .mc-more")).toBeNull();
  });
});

describe("the other kinds", () => {
  const cases = [
    ["answer", "Answer to you", "mc-k-answer"],
    ["blocker", "Blocked", "mc-k-blocker"],
    ["do_this", "Your turn", "mc-k-do_this"],
    ["plan", "Plan for you", "mc-k-plan"],
    ["rating", "Rating", "mc-k-rating"],
    ["correction", "Correction", "mc-k-correction"],
    ["call", "Claude's call", "mc-k-call"],
    ["handoff", "Handoff", "mc-k-handoff"],
    ["artifact", "Ready to look at", "mc-k-artifact"],
    ["discovery", "Approach changed", "mc-k-discovery"],
  ];
  it.each(cases)("%s prints the label %s", (kind, label, cls) => {
    const root = mount(msg({ kind, verdict: "Yes", text: "Headline here" }));
    expect(root.querySelector(`.mc-card.${cls}`)).not.toBeNull();
    expect(root.querySelector(".mc-full .mc-label").textContent).toBe(label);
    expect(root.querySelector(".mc-full .mc-head").textContent.trim()).toBe("Headline here");
  });

  it("marks call, handoff, artifact and discovery as the quiet one-size-down form", () => {
    for (const kind of ["call", "handoff", "artifact", "discovery"]) {
      document.body.innerHTML = "";
      expect(mount(msg({ kind, text: "x" })).querySelector(".mc-root").classList.contains("mc-fyi")).toBe(true);
    }
    document.body.innerHTML = "";
    expect(mount(msg({ kind: "answer", text: "x" })).querySelector(".mc-root").classList.contains("mc-fyi")).toBe(false);
  });

  it("draws no verdict on a plan, even if the model sent one", () => {
    const root = mount(msg({ kind: "plan", verdict: "Ready", text: "Thu plan is ready" }));
    expect(root.querySelector(".mc-verdict")).toBeNull();
    expect(root.querySelector(".mc-head--main")).not.toBeNull();
  });

  it("maps tone onto the verdict colour, with blocker and do_this fixed", () => {
    const tone = (input) => {
      document.body.innerHTML = "";
      return mount(msg(input)).querySelector(".mc-full .mc-verdict span").className;
    };
    expect(tone({ kind: "answer", verdict: "Yes", tone: "good", text: "x" })).toBe("mc-t-good");
    expect(tone({ kind: "rating", verdict: "3/10", tone: "bad", text: "x" })).toBe("mc-t-bad");
    expect(tone({ kind: "answer", verdict: "No", text: "x" })).toBe("mc-t-neutral");
    expect(tone({ kind: "blocker", verdict: "Stuck", tone: "good", text: "x" })).toBe("mc-t-bad");
    expect(tone({ kind: "do_this", verdict: "Get the token", tone: "bad", text: "x" })).toBe("mc-t-warn");
  });

  it("puts the earlier claim of a correction struck through above the card", () => {
    const root = mount(msg({ kind: "correction", verdict: "Wrong", text: "You were right", was: "Pushing deploys nothing" }));
    const was = root.querySelector(".mc-root > .mc-was");
    expect(was.querySelector("s").textContent).toBe("Pushing deploys nothing");
    expect(was.nextElementSibling.classList.contains("mc-card")).toBe(true);
  });

  it("uses the existing copyable block for a do_this payload", () => {
    const root = mount(msg({ kind: "do_this", verdict: "Run it", text: "In a terminal", copy: "git push origin <branch>" }));
    const block = root.querySelector(".mc-full .copyable-block pre");
    expect(block.textContent).toBe("git push origin <branch>");
    expect(root.querySelector(".mc-full .copyable-block .copy-btn")).not.toBeNull();
  });

  it("puts points behind a details that counts them", () => {
    const root = mount(msg({ kind: "answer", verdict: "Yes", text: "Because", points: ["one", "two"] }));
    const d = root.querySelector(".mc-full details.mc-points");
    expect(d.querySelector("summary").textContent.trim()).toBe("2 more points");
    expect([...d.querySelectorAll("li")].map((li) => li.textContent.trim())).toEqual(["one", "two"]);
    document.body.innerHTML = "";
    const one = mount(msg({ kind: "call", text: "x", points: ["only"] }));
    expect(one.querySelector("details.mc-points summary").textContent.trim()).toBe("1 more point");
  });

  it("keeps file chips working in card text", () => {
    const root = mount(msg({ kind: "answer", verdict: "Yes", text: "See <file:C:/a/b.txt>" }));
    expect(root.querySelector(".mc-full .mc-head .block.text")).not.toBeNull();
  });
});

describe("ack", () => {
  it("draws nothing by default and is tagged as narration so raw activity reveals it", () => {
    const html = renderMessage(msg({ kind: "ack", text: "On it." }));
    const root = mount(msg({ kind: "ack", text: "On it." }));
    const el = root.firstElementChild;
    expect(el.classList.contains("chat-narration")).toBe(true);
    expect(el.querySelector(".mc-card")).toBeNull();
    expect(html).toContain("On it.");
  });
});

describe("the mini card", () => {
  it("keeps the verdict coloured, the headline, and the open rows as amber text", () => {
    const root = mount(msg(REPORT_INPUT));
    const row = root.querySelector(".mc-mini .mc-mini-row");
    expect(row.querySelector(".mc-mini-lead").textContent).toBe("Built, not pushed");
    expect(row.querySelector(".mc-mini-lead .mc-t-warn")).not.toBeNull();
    expect(row.querySelector(".mc-mini-head").textContent).toBe("sc-56605 committed as c083bd89");
    expect(row.querySelector(".mc-mini-open").textContent).toBe("your move, 1 not done, 1 waiting");
  });

  it("is green and carries no amber text when nothing is open", () => {
    const row = mount(msg({ kind: "report", verdict: "Fixed", text: "x", done: ["a"] })).querySelector(".mc-mini-row");
    expect(row.querySelector(".mc-t-good")).not.toBeNull();
    expect(row.querySelector(".mc-mini-open")).toBeNull();
  });

  it("holds the content behind a native details so a click reopens it in place", () => {
    const root = mount(msg(REPORT_INPUT));
    const d = root.querySelector(".mc-mini details.mc-mini-d");
    expect(d.open).toBe(false);
    expect(d.querySelector(".mc-mini-body .mc-sec--yours")).not.toBeNull();
    expect(d.querySelector(".mc-mini-body .mc-sec--done")).not.toBeNull();
    d.querySelector("summary").click();
    expect(d.open).toBe(true);
  });

  it("names a verdict-less kind by its label", () => {
    const row = mount(msg({ kind: "handoff", text: "The new chat has the context" })).querySelector(".mc-mini-row");
    expect(row.querySelector(".mc-mini-lead").textContent).toBe("Handoff");
  });
});

describe("failed and retracted rows", () => {
  it("a retracted row draws its pill ahead of any card, a rejected send draws nothing", () => {
    expect(renderMessage(msg(REPORT_INPUT, { failed: true }))).toBe('<div class="msg system failed-marker"></div>');
    expect(renderMessage(msg(REPORT_INPUT, { retracted: true }))).toContain("retracted-marker");
  });
});
