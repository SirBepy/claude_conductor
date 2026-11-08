import { describe, it, expect } from "vitest";
import { rankCommands } from "../src/views/command-palette/rank.ts";

const cmd = (id, title, extra = {}) => ({ id, title, group: "Test", icon: "x", run: () => {}, ...extra });
const ids = (list) => list.map((c) => c.id);

describe("rankCommands", () => {
  const all = [
    cmd("a", "Change account"),
    cmd("b", "Change character"),
    cmd("c", "Go to Home"),
    cmd("d", "Mute sounds", { detail: "Settings › Notifications" }),
    cmd("e", "Switch branch", { keywords: ["checkout"] }),
  ];

  it("lists everything in source order when the query is empty and nothing is recent", () => {
    expect(ids(rankCommands(all, "", []))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("puts recents first, newest first, then the rest in source order", () => {
    expect(ids(rankCommands(all, "", ["d", "b"]))).toEqual(["d", "b", "a", "c", "e"]);
  });

  it("ignores a recent id no source produced this time", () => {
    expect(ids(rankCommands(all, "", ["gone", "c"]))).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("ranks a title prefix above a mid-title match", () => {
    expect(ids(rankCommands(all, "change", []))).toEqual(["a", "b"]);
    expect(rankCommands(all, "account", [])[0].id).toBe("a");
  });

  it("matches words that are not the title's start", () => {
    expect(ids(rankCommands(all, "home", []))).toEqual(["c"]);
  });

  it("matches a fuzzy abbreviation", () => {
    expect(rankCommands(all, "chacc", [])[0].id).toBe("a");
  });

  it("finds a row by its keywords and by its detail, after title hits", () => {
    expect(ids(rankCommands(all, "checkout", []))).toEqual(["e"]);
    expect(ids(rankCommands(all, "notifications", []))).toEqual(["d"]);
  });

  it("needs every word of a multi-word query", () => {
    expect(ids(rankCommands(all, "settings sounds", []))).toEqual(["d"]);
    expect(rankCommands(all, "settings zebra", [])).toEqual([]);
  });

  it("breaks a tier tie toward the more recently run command", () => {
    const tie = [cmd("x", "Open aaaa"), cmd("y", "Open bbbb")];
    expect(ids(rankCommands(tie, "open", ["y"]))).toEqual(["y", "x"]);
    expect(ids(rankCommands(tie, "open", []))).toEqual(["x", "y"]);
  });

  it("sorts rows that cannot run after the ones that can, whatever matches better", () => {
    const rows = [
      cmd("dead", "Deploy", { run: undefined, disabledReason: "No workflow" }),
      cmd("live", "Run deploy script"),
    ];
    expect(ids(rankCommands(rows, "deploy", []))).toEqual(["live", "dead"]);
    expect(ids(rankCommands(rows, "", []))).toEqual(["live", "dead"]);
  });

  it("never lists a recent row that cannot run in the recent block", () => {
    const rows = [cmd("dead", "Deploy", { run: undefined, disabledReason: "No workflow" }), cmd("live", "Other")];
    expect(ids(rankCommands(rows, "", ["dead"]))).toEqual(["live", "dead"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 200 }, (_, i) => cmd(`n${i}`, `Item ${i}`));
    expect(rankCommands(many, "", []).length).toBe(60);
    expect(rankCommands(many, "item", []).length).toBe(60);
  });
});
