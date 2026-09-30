// @vitest-environment jsdom

// Side-by-side diff: both halves of a line live in one table row, so they can
// never drift apart, and a deletion sits across from the addition replacing it.

import { describe, it, expect } from "vitest";

const { parseUnifiedDiff, pairSplitRows, renderSplitDiffHtml, applyDiffHighlight } = await import(
  "../src/shared/chat/file-surface-diff.ts"
);

const DIFF = [
  "diff --git a/x.ts b/x.ts",
  "@@ -1,4 +1,5 @@",
  " keep 1",
  "-old a",
  "-old b",
  "+new a",
  "+new b",
  "+new c",
  " keep 2",
  "-gone",
  " keep 3",
].join("\n");

const shape = (l) =>
  "hunk" in l ? "hunk" : `${l.left?.row.text ?? "_"} | ${l.right?.row.text ?? "_"}`;

describe("pairSplitRows", () => {
  it("pairs a deletion run with the additions after it, padding the shorter side", () => {
    expect(pairSplitRows(parseUnifiedDiff(DIFF)).map(shape)).toEqual([
      "hunk",
      "keep 1 | keep 1",
      "old a | new a",
      "old b | new b",
      "_ | new c",
      "keep 2 | keep 2",
      "gone | _",
      "keep 3 | keep 3",
    ]);
  });

  it("starts a new change block when a deletion follows additions", () => {
    const rows = [
      { kind: "add", text: "a1", newLine: 1 },
      { kind: "del", text: "d1", oldLine: 1 },
      { kind: "add", text: "a2", newLine: 2 },
    ];
    expect(pairSplitRows(rows).map(shape)).toEqual(["_ | a1", "d1 | a2"]);
  });
});

describe("renderSplitDiffHtml", () => {
  it("renders one table row per line with old and new cells side by side", () => {
    const rows = parseUnifiedDiff(DIFF);
    const host = document.createElement("div");
    host.innerHTML = renderSplitDiffHtml(rows);
    const trs = [...host.querySelectorAll("table.fs-sdiff tr")];
    expect(trs).toHaveLength(8);
    const changed = trs[2];
    expect(changed.querySelector('.fs-code[data-side="old"]').textContent).toBe("old a");
    expect(changed.querySelector('.fs-code[data-side="new"]').textContent).toBe("new a");
    expect(trs[4].querySelectorAll(".fs-pad")).toHaveLength(2);
  });

  it("applies highlight per side, so a context row gets each side's markup", () => {
    const rows = parseUnifiedDiff(DIFF);
    const host = document.createElement("div");
    host.innerHTML = renderSplitDiffHtml(rows);
    const old = new Map(rows.filter((r) => r.kind !== "add" && r.kind !== "hunk").map((r) => [r, `<b>o:${r.text}</b>`]));
    const neu = new Map(rows.filter((r) => r.kind !== "del" && r.kind !== "hunk").map((r) => [r, `<b>n:${r.text}</b>`]));
    applyDiffHighlight(host, rows, { old, new: neu });
    const first = host.querySelectorAll("table.fs-sdiff tr")[1];
    expect(first.querySelector('[data-side="old"]').textContent).toBe("o:keep 1");
    expect(first.querySelector('[data-side="new"]').textContent).toBe("n:keep 1");
  });
});
