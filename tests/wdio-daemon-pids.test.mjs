// wdio's onComplete runs even when onPrepare throws. It must kill only daemons
// the pre-run snapshot proves are new, never the installed app's live daemon
// (incident 2026-11-07: the preflight threw before the snapshot was taken).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { pidsToKill, snapshotValue } from "../e2e/helpers/daemon-pids.js";

describe("pidsToKill", () => {
  it("kills nothing when the snapshot env is unset", () => {
    expect(pidsToKill(undefined, ["111", "222"])).toEqual([]);
  });

  it.each(["abc", "1,two,3", "1;2", " ", "1,,2", "12.5", "-4"])("kills nothing for garbage snapshot %j", (env) => {
    expect(pidsToKill(env, ["111", "222"])).toEqual([]);
  });

  it("kills nothing when the current pid listing failed", () => {
    expect(pidsToKill("111", null)).toEqual([]);
    expect(pidsToKill("111", undefined)).toEqual([]);
  });

  it("kills only pids absent from the snapshot", () => {
    expect(pidsToKill("111,222", ["111", "222", "333", "444"])).toEqual(["333", "444"]);
  });

  it("treats an empty snapshot as 'no daemon existed' and kills every new pid", () => {
    expect(pidsToKill("", ["333"])).toEqual(["333"]);
  });

  it("tolerates whitespace and numeric pids", () => {
    expect(pidsToKill("111, 222", [111, " 333 "])).toEqual(["333"]);
  });

  it("kills nothing when every running pid pre-existed", () => {
    expect(pidsToKill("111,222", ["111", "222"])).toEqual([]);
  });
});

describe("snapshotValue", () => {
  it("is undefined when the listing failed, so the env stays unset", () => {
    expect(snapshotValue(null)).toBeUndefined();
  });
  it("joins pids, and an empty listing is an empty (valid) snapshot", () => {
    expect(snapshotValue(["1", "2"])).toBe("1,2");
    expect(snapshotValue([])).toBe("");
  });
});

describe("wdio.conf.js onPrepare ordering", () => {
  const src = fs.readFileSync(new URL("../e2e/wdio.conf.js", import.meta.url), "utf8");
  const onPrepare = src.slice(src.indexOf("onPrepare:"), src.indexOf("onComplete:"));

  it("sets the instance env and takes the snapshot before anything that can throw", () => {
    const snap = onPrepare.indexOf("CC_WDIO_PREEXISTING_DAEMON_PIDS");
    expect(snap).toBeGreaterThan(-1);
    expect(onPrepare.indexOf("CC_DAEMON_INSTANCE")).toBeLessThan(snap);
    for (const risky of ["checkEdgeDriverVersion(", "execSync(", "waitForServer(", "spawn("]) {
      expect(onPrepare.indexOf(risky), risky).toBeGreaterThan(snap);
    }
  });

  it("onComplete delegates the pid filter to pidsToKill", () => {
    const onComplete = src.slice(src.indexOf("onComplete:"), src.indexOf("beforeSession:"));
    expect(onComplete).toContain("pidsToKill(");
  });
});
