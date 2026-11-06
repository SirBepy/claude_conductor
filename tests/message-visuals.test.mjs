// @vitest-environment jsdom
// asserts: src/shared/chat/message-visuals.ts, src/shared/chat/message-visuals-render.ts, src/shared/chat/chat-message-card.ts

// A send_message can carry `visuals` (table, bar, line, donut, timeline) that the
// card draws under its body. The daemon validates the shape; the chat is lenient,
// escapes everything and keeps the card when a visual is malformed.

import { describe, it, expect } from "vitest";

const { parseVisuals, parseClock } = await import("../src/shared/chat/message-visuals.ts");
const { renderVisuals } = await import("../src/shared/chat/message-visuals-render.ts");
const { parseMessageCard, reviseCard } = await import("../src/shared/chat/chat-message-kinds.ts");
const { renderMessage } = await import("../src/shared/chat/chat-transforms.ts");

const TABLE = { type: "table", title: "Cost by model", columns: ["Model", "Cost"], rows: [["Opus", "$18.40"], ["Sonnet", 9.75]] };
const BAR = { type: "bar", unit: "s", data: [{ label: "a", value: 9.2 }, { label: "b", value: 4.6 }] };
const LINE = { type: "line", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Opus", values: [1, 3, 2] }, { name: "Sonnet", values: [2, 2, 2] }] };
const DONUT = { type: "donut", data: [{ label: "Done", value: 3 }, { label: "Blocked", value: 1 }] };
const TIMELINE = { type: "timeline", rows: [{ label: "Mon", blocks: [{ start: "09:00", end: "12:30", label: "Review" }, { start: "13:30", end: "15:00" }] }] };

const html = (v) => renderVisuals(parseVisuals({ visuals: [v] }));
const asHtml = (s) => {
  const d = document.createElement("div");
  d.innerHTML = s;
  return d;
};

describe("parseVisuals", () => {
  it("reads every type and keeps the order", () => {
    const v = parseVisuals({ visuals: [TABLE, BAR, LINE] });
    expect(v.map((x) => x.type)).toEqual(["table", "bar", "line"]);
  });

  it("is undefined when the key is absent and [] when the list is explicit but unusable", () => {
    expect(parseVisuals({ text: "x" })).toBeUndefined();
    expect(parseVisuals({ visuals: [{ type: "pie" }, "nope", null] })).toEqual([]);
  });

  it("drops a malformed visual and keeps its siblings", () => {
    const v = parseVisuals({ visuals: [{ type: "table", columns: ["a"], rows: [] }, BAR] });
    expect(v.map((x) => x.type)).toEqual(["bar"]);
  });

  it("drops table rows that do not match the columns, and keeps the rest", () => {
    const v = parseVisuals({ visuals: [{ type: "table", columns: ["a", "b"], rows: [["x"], ["y", "z"]] }] });
    expect(v[0].rows).toEqual([["y", "z"]]);
  });

  it("refuses a line whose series has the wrong number of values and a donut with a zero slice", () => {
    expect(parseVisuals({ visuals: [{ ...LINE, series: [{ name: "n", values: [1, 2] }] }] })).toEqual([]);
    const donut = parseVisuals({ visuals: [{ type: "donut", data: [{ label: "a", value: 1 }, { label: "b", value: 0 }] }] });
    expect(donut).toEqual([]);
  });

  it("caps a message at three visuals", () => {
    expect(parseVisuals({ visuals: [BAR, BAR, BAR, BAR] })).toHaveLength(3);
  });

  it("parses 24-hour clock text and nothing else", () => {
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("24:00")).toBe(1440);
    for (const bad of ["9:30", "25:00", "12:60", "noon", 930, undefined]) expect(parseClock(bad)).toBeUndefined();
  });

  it("drops a timeline block that ends before it starts", () => {
    const v = parseVisuals({ visuals: [{ type: "timeline", rows: [{ label: "d", blocks: [{ start: "10:00", end: "09:00" }] }] }] });
    expect(v).toEqual([]);
  });
});

describe("renderVisuals", () => {
  it("draws a table with its title, headers and the shared fullscreen button", () => {
    const d = asHtml(html(TABLE));
    expect(d.querySelector("figcaption").textContent).toBe("Cost by model");
    expect([...d.querySelectorAll("th")].map((t) => t.textContent.replace(/\s+/g, ""))).toEqual(["Model", "Cost"]);
    expect(d.querySelector(".table-wrap .table-fs-btn")).not.toBeNull();
  });

  it("right-aligns a numeric column and leaves a text column alone", () => {
    const d = asHtml(html(TABLE));
    const heads = [...d.querySelectorAll("th")];
    expect(heads[0].classList.contains("mv-num")).toBe(false);
    expect(heads[1].classList.contains("mv-num")).toBe(true);
  });

  it("formats a numeric cell", () => {
    const d = asHtml(html({ type: "table", columns: ["n"], rows: [[1234.567]] }));
    expect(d.querySelector("td").textContent.replace(/\s+/g, "")).toBe("1,234.57");
  });

  it("sizes bars against the largest value and prints the unit", () => {
    const d = asHtml(html(BAR));
    const fills = [...d.querySelectorAll(".mv-bar-track i")].map((i) => i.getAttribute("style"));
    expect(fills[0]).toContain("width:100.0%");
    expect(fills[1]).toContain("width:50.0%");
    expect(d.querySelector(".mv-bar-row b").textContent).toBe("9.2s");
  });

  it("draws one polyline per series and a legend only for several", () => {
    const d = asHtml(html(LINE));
    expect(d.querySelectorAll("polyline")).toHaveLength(2);
    expect(d.querySelectorAll(".mv-key")).toHaveLength(2);
    const one = asHtml(html({ ...LINE, series: [LINE.series[0]] }));
    expect(one.querySelector(".mv-legend")).toBeNull();
  });

  it("draws donut slices with percentages and the total in the middle", () => {
    const d = asHtml(html(DONUT));
    expect(d.querySelectorAll("circle")).toHaveLength(2);
    expect([...d.querySelectorAll(".mv-key b")].map((b) => b.textContent)).toEqual(["75%", "25%"]);
    expect(d.querySelector(".mv-donut-n").textContent).toBe("4");
  });

  it("places timeline blocks by percent of the shown hours and totals each row", () => {
    const d = asHtml(html(TIMELINE));
    const blocks = [...d.querySelectorAll(".mv-block")];
    expect(blocks).toHaveLength(2);
    // 09:00 to 15:00 shown: the first block starts at the left edge and is 3.5h of 6h wide.
    expect(blocks[0].getAttribute("style")).toContain("left:0.00%");
    expect(blocks[0].getAttribute("style")).toContain("width:58.33%");
    expect(d.querySelector(".mv-tl-row b").textContent).toBe("5h");
    expect(blocks[0].getAttribute("title")).toBe("Review, 09:00 to 12:30 (3h 30m)");
  });

  it("escapes every string the model wrote", () => {
    const evil = '<img src=x onerror=alert(1)>';
    const out = html({ type: "table", title: evil, columns: [evil], rows: [[evil]] }) + html({ type: "bar", unit: evil, data: [{ label: evil, value: 1 }] });
    expect(out).not.toContain("<img");
    expect(asHtml(out).querySelector("img")).toBeNull();
  });

  it("draws nothing for no visuals", () => {
    expect(renderVisuals(undefined)).toBe("");
    expect(renderVisuals([])).toBe("");
  });
});

describe("the card", () => {
  const input = { kind: "answer", verdict: "Opus costs most", text: "Cost per model", visuals: [TABLE, BAR] };
  const draw = (card) => renderMessage({ kind: "message", text: input.text, card, id: "x", ts: 0, parentToolUseId: null });

  it("carries visuals in the full card, under the body", () => {
    const d = asHtml(draw(parseMessageCard(input)));
    expect(d.querySelectorAll(".mc-full .mv-fig")).toHaveLength(2);
    expect(d.querySelectorAll(".mc-mini .mv-fig")).toHaveLength(0);
  });

  it("draws no visuals on an ack", () => {
    expect(parseMessageCard({ ...input, kind: "ack" }).visuals).toBeUndefined();
  });

  it("a plain card has no visuals block at all", () => {
    const d = asHtml(draw(parseMessageCard({ kind: "answer", verdict: "Yes", text: "Cost per model" })));
    expect(d.querySelector(".mv-visuals")).toBeNull();
  });

  it("update_message replaces visuals when given, clears them on an empty list, and keeps them when absent", () => {
    const base = parseMessageCard(input);
    expect(reviseCard(base, { message: 1, text: "x" }).visuals).toHaveLength(2);
    expect(reviseCard(base, { message: 1, visuals: [DONUT] }).visuals.map((v) => v.type)).toEqual(["donut"]);
    expect(reviseCard(base, { message: 1, visuals: [] }).visuals).toBeUndefined();
    expect(reviseCard(undefined, { visuals: [DONUT] })).toBeUndefined();
  });
});
