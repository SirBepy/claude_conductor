// scripts/test-progress.mjs (pc-1684): the output parsers for vitest and cargo test, how
// a finished command is reported, where the session id comes from, and one run of the real
// script against a loopback server that stands in for the daemon.

import { describe, it, expect } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { createTracker, endState, sessionFrom, parseArgs, detectRunner, stripAnsi } = await import("../scripts/test-progress.mjs");
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test-progress.mjs");

const feedAll = (t, text) => text.split("\n").forEach((l) => t.feed(l));

describe("vitest output", () => {
  const sample = [
    " RUN  v2.1.9 C:/repo",
    "",
    " ✓ tests/a.test.mjs (12 tests) 5ms",
    " ❯ tests/b.test.mjs (4 tests | 1 failed | 1 skipped) 12ms",
    "   × suite > fails here 4ms",
    "     → expected 1 to be 2 // Object.is equality",
    " ✓ tests/c.test.mjs (3 tests) 2ms",
  ].join("\n");

  it("counts per file as each file finishes and names the failing tests", () => {
    const t = createTracker("vitest");
    feedAll(t, sample);
    expect([t.passed, t.failed]).toEqual([12 + 2 + 3, 1]);
    expect(t.failing).toEqual(["suite > fails here"]);
    expect(t.report("running").total).toBe(0);
  });

  it("takes the run's own totals from the summary and reports the total of a finished run", () => {
    const t = createTracker("vitest");
    feedAll(t, `${sample}\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 17 passed | 1 skipped (19)`);
    expect([t.passed, t.failed]).toEqual([17, 1]);
    expect(t.report("failed")).toMatchObject({ runner: "vitest", passed: 17, failed: 1, total: 18, state: "failed" });
  });

  it("does not count the failed-tests recap that follows, nor its FAIL lines", () => {
    const t = createTracker("vitest");
    feedAll(t, `${sample}\n\n⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯\n\n FAIL  tests/b.test.mjs > suite > fails here\nAssertionError: x\n    × not a test line`);
    expect(t.failing).toEqual(["suite > fails here"]);
    expect(t.failed).toBe(1);
  });

  it("reads through colour codes", () => {
    const t = createTracker("vitest");
    t.feed("\u001b[32m ✓\u001b[39m tests/a.test.mjs \u001b[2m(5 tests)\u001b[22m 3ms");
    expect(t.passed).toBe(5);
    expect(stripAnsi("\u001b[1mx\u001b[0m")).toBe("x");
  });
});

describe("cargo test output", () => {
  const sample = [
    "running 4 tests",
    "test a::ok_one ... ok",
    "test a::bad ... FAILED",
    "test a::skipped ... ignored",
    "test a::ok_two ... ok",
    "",
    "test result: FAILED. 2 passed; 1 failed; 1 ignored",
    "running 2 tests",
    "test b::x ... ok",
  ].join("\n");

  it("adds each binary's announced total and counts as the lines arrive", () => {
    const t = createTracker("cargo test");
    feedAll(t, sample);
    expect([t.passed, t.failed]).toEqual([3, 1]);
    // 4 + 2 announced, one of them ignored.
    expect(t.report("running")).toMatchObject({ total: 5, failing: ["a::bad"] });
  });

  it("keeps twelve failing names and counts the rest", () => {
    const t = createTracker("cargo test");
    for (let i = 0; i < 20; i++) t.feed(`test m::t${i} ... FAILED`);
    expect(t.failing).toHaveLength(12);
    expect(t.failingMore).toBe(8);
    expect(t.failed).toBe(20);
  });
});

describe("how a command ended", () => {
  it("a non-zero exit with nothing failed is an error, never a pass", () => {
    const t = createTracker("cargo test");
    expect(endState(t, 101)).toBe("error");
    expect(endState(t, 0)).toBe("passed");
    t.feed("test a ... FAILED");
    expect(endState(t, 101)).toBe("failed");
    expect(endState(t, 0)).toBe("failed");
  });
});

describe("arguments and session", () => {
  it("splits the options from the command", () => {
    expect(parseArgs(["--runner", "cargo", "--", "cargo", "test", "-p", "x"])).toMatchObject({ runner: "cargo", cmd: ["cargo", "test", "-p", "x"] });
    expect(parseArgs(["pnpm", "vitest", "run"]).cmd).toEqual(["pnpm", "vitest", "run"]);
  });

  it("detects the runner from the command", () => {
    expect(detectRunner(["pnpm", "vitest", "run"])).toBe("vitest");
    expect(detectRunner(["node", "node_modules/vitest/vitest.mjs"])).toBe("vitest");
    expect(detectRunner(["cargo", "test", "--lib"])).toBe("cargo test");
    expect(detectRunner(["cargo", "build"])).toBeNull();
  });

  it("takes the session id from the flag, the env, or the broker token's own field, never the token", () => {
    expect(sessionFrom({ session: "flag" }, { CC_SESSION_ID: "env" })).toBe("flag");
    expect(sessionFrom({}, { CC_SESSION_ID: "env" })).toBe("env");
    // Built from parts: a made-up token shape, and no literal for the secret scan to flag.
    const shaped = ["ccb1", "sess-9", "chat", "shortcut", "3", "0f0f"].join(".");
    expect(sessionFrom({}, { CC_BROKER_TOKEN: shaped })).toBe("sess-9");
    expect(sessionFrom({}, { CC_BROKER_TOKEN: "not-a-token" })).toBe("");
    expect(sessionFrom({}, {})).toBe("");
  });
});

/** A server standing in for the daemon: collects each POST body and answers `{ok:true}`. */
async function fakeDaemon() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      bodies.push({ url: req.url, body: JSON.parse(data) });
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { bodies, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function runScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, CC_SESSION_ID: "", CC_BROKER_TOKEN: "", CC_BROKER_URL: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the script against a daemon", () => {
  const fake = ["-e", "console.log('running 3 tests');console.log('test a::ok ... ok');console.log('test a::bad ... FAILED');console.log('test a::ok2 ... ok')"];

  it("reports running first and the final state last, passes the output through, keeps the exit code", async () => {
    const d = await fakeDaemon();
    try {
      const r = await runScript(["--runner", "cargo", "--session", "chat-1", "--url", d.url, "--", process.execPath, ...fake], {});
      expect(r.code).toBe(0);
      expect(r.out).toContain("test a::bad ... FAILED");
      expect(d.bodies.length).toBeGreaterThanOrEqual(2);
      expect(d.bodies.every((b) => b.url === "/hooks/test-progress" && b.body.session_id === "chat-1")).toBe(true);
      expect(d.bodies[0].body.state).toBe("running");
      const last = d.bodies.at(-1).body;
      expect(last).toMatchObject({ runner: "cargo test", passed: 2, failed: 1, total: 3, failing: ["a::bad"], state: "failed" });
    } finally {
      await d.close();
    }
  });

  it("keeps the command's own exit code", async () => {
    const d = await fakeDaemon();
    try {
      const r = await runScript(["--runner", "cargo", "--session", "chat-1", "--url", d.url, "--", process.execPath, "-e", "process.exit(7)"], {});
      expect(r.code).toBe(7);
      expect(d.bodies.at(-1).body.state).toBe("error");
    } finally {
      await d.close();
    }
  });

  it("still runs the command when the daemon is not there", async () => {
    const r = await runScript(["--runner", "cargo", "--session", "chat-1", "--url", "http://127.0.0.1:9", "--", process.execPath, ...fake], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("running 3 tests");
  });

  it("runs the command and says so when it is not inside a chat", async () => {
    const r = await runScript(["--runner", "cargo", "--", process.execPath, ...fake], {});
    expect(r.code).toBe(0);
    expect(r.err).toContain("no chat session id");
  });
});
