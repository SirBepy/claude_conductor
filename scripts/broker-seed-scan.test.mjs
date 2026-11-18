// Run: node --test scripts/broker-seed-scan.test.mjs
// (Outside the vitest `tests/` glob on purpose; plain node:test, no dependencies.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRows, callTexts, extractCalls, isLinearOpName, pathShape, redact, scan } from "./broker-seed-scan.mjs";

// Made-up canary, never a real token shape.
const CANARY = "CANARYtok3nAAAA1111BBBB2222CCCC3333";

describe("redact", () => {
  it("replaces a long mixed letter and digit run and leaves words and shapes alone", () => {
    assert.equal(redact(`Shortcut-Token: ${CANARY}`), "Shortcut-Token: [REDACTED]");
    assert.equal(redact("^/api/v3/stories/\\d+/comments$"), "^/api/v3/stories/\\d+/comments$");
    assert.equal(redact("^/v1/files/[^/]+/comments$ [0-9a-f]{24}"), "^/v1/files/[^/]+/comments$ [0-9a-f]{24}");
    assert.equal(redact("a-very-long-plain-word-with-dashes-only"), "a-very-long-plain-word-with-dashes-only");
  });
});

describe("pathShape", () => {
  it("keeps the service prefix and turns ids into classes", () => {
    assert.equal(pathShape("/api/v3/stories/123/comments?x=1", "/api/v3/"), "^/api/v3/stories/\\d+/comments$");
    assert.equal(pathShape("/api/v3/groups/6f1c2a3b-0000-4000-8000-123456789abc", "/api/v3/"), "^/api/v3/groups/[0-9a-f-]{36}$");
    assert.equal(
      pathShape("/api/v1/workspaces/5f0123456789abcdef012345/time-entries", "/api/v1/"),
      "^/api/v1/workspaces/[0-9a-f]{24}/time-entries$",
    );
    assert.equal(pathShape("/v1/files/AbC123xyz/comments", "/v1/"), "^/v1/files/[^/]+/comments$");
  });

  it("gives a shell variable the id class of its service, never a wide segment", () => {
    assert.equal(pathShape("/api/v3/stories/$id", "/api/v3/", "shortcut"), "^/api/v3/stories/\\d+$");
    assert.equal(pathShape("/api/v3/stories/${e}/comments", "/api/v3/", "shortcut"), "^/api/v3/stories/\\d+/comments$");
  });
});

describe("extractCalls", () => {
  it("reads an explicit verb, a body flag and a -G query, per curl invocation", () => {
    const t = [
      'curl -s -X POST -H "Shortcut-Token: $T" https://api.app.shortcut.com/api/v3/stories/12/comments -d \'{"text":"x"}\'',
      'curl -s -H "Shortcut-Token: $T" https://api.app.shortcut.com/api/v3/stories/12',
      'curl -sG -H "Shortcut-Token: $T" https://api.app.shortcut.com/api/v3/search/stories --data-urlencode "query=a"',
      "curl -s --request PUT https://api.app.shortcut.com/api/v3/stories/12 -d '{}'",
    ].join("\n");
    assert.deepEqual(
      extractCalls(t).calls.map((c) => `${c.method} ${c.path}`),
      ["POST /api/v3/stories/12/comments", "GET /api/v3/stories/12", "GET /api/v3/search/stories", "PUT /api/v3/stories/12"],
    );
  });

  it("does not take cut -d for a request body", () => {
    const t = 'T=$(grep X ~/f | cut -d= -f2-); curl -s -H "Shortcut-Token: $T" https://api.app.shortcut.com/api/v3/member | python -c "x"';
    assert.deepEqual(extractCalls(t).calls.map((c) => c.method), ["GET"]);
  });

  it("does not take curl -D (dump headers) for -d, and skips a URL built from a variable", () => {
    const t = [
      'curl -s -D hdr.txt -H "X-Figma-Token: $T" "https://api.figma.com/v1/files/AbC123?depth=2" -o out.json',
      "r = urllib.request.Request('https://api.app.shortcut.com/api/v3/' + p, data=b)",
    ].join("\n");
    assert.deepEqual(extractCalls(t).calls.map((c) => `${c.method} ${c.path}`), ["GET /v1/files/AbC123?depth=2"]);
  });

  it("reads PowerShell -Method and -Body", () => {
    const t = [
      'Invoke-RestMethod -Uri "https://api.clockify.me/api/v1/workspaces/5f0123456789abcdef012345/time-entries" -Method Post -Body $b',
      'Invoke-RestMethod -Uri "https://api.clockify.me/api/v1/user"',
    ].join("\n");
    assert.deepEqual(extractCalls(t).calls.map((c) => c.method), ["POST", "GET"]);
  });

  it("collects Linear mutation names and ignores code words", () => {
    const t =
      'curl https://api.linear.app/graphql -d \'{"query":"mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }"}\' ; mutation { let x }';
    assert.deepEqual(extractCalls(t).linearOps, ["commentCreate"]);
    assert.equal(isLinearOpName("issueUpdate"), true);
    assert.equal(isLinearOpName("return"), false);
  });
});

describe("callTexts", () => {
  it("reads shell commands and script files, not repo source or test fixtures", () => {
    const len = (part) => [...callTexts(part)].length;
    assert.equal(len({ name: "Bash", input: { command: "curl https://api.figma.com/v1/me" } }), 1);
    assert.equal(len({ name: "Write", input: { file_path: "C:/x/src-tauri/src/a.rs", content: "https://api.figma.com/v1/me" } }), 0);
    assert.equal(len({ name: "Write", input: { file_path: "C:/x/get.py", content: "requests.post('https://api.figma.com/v1/me')" } }), 1);
    assert.equal(len({ name: "Bash", input: { command: "cat <<EOF\n#[tokio::test]\nhttps://api.figma.com/v1/me\nEOF" } }), 0);
  });
});

describe("buildRows", () => {
  const counts = (...keys) => new Map(keys.map((k) => [JSON.stringify(k), 1]));
  it("seeds writes only, never deletes or bulk, asks for an owner on Shortcut stories, always adds the search row", () => {
    const rows = buildRows(
      counts(
        ["shortcut", "GET", "^/api/v3/stories/\\d+$"],
        ["shortcut", "PUT", "^/api/v3/stories/\\d+$"],
        ["shortcut", "POST", "^/api/v3/stories$"],
        ["shortcut", "DELETE", "^/api/v3/stories/\\d+$"],
        ["shortcut", "POST", "^/api/v3/stories/bulk$"],
        ["clockify", "POST", "^/api/v1/workspaces/[0-9a-f]{24}/time-entries$"],
      ),
      new Map([
        ["commentCreate", 3],
        ["issueDelete", 1],
      ]),
    );
    const key = (r) => `${r.service} ${r.method || r.op} ${r.path || ""} ${r.require_owner}`;
    assert.deepEqual(
      rows.map(key).sort(),
      [
        "clockify POST ^/api/v1/workspaces/[0-9a-f]{24}/time-entries$ false",
        "linear commentCreate  true",
        "shortcut POST ^/api/v3/search$ false",
        "shortcut POST ^/api/v3/stories$ false",
        "shortcut PUT ^/api/v3/stories/\\d+$ true",
      ].sort(),
    );
  });
});

describe("scan", () => {
  it("reads only recent files and only tool_use commands, so a tool result echo is never looked at", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seedscan-"));
    try {
      const line = (content) => JSON.stringify({ timestamp: new Date().toISOString(), message: { content } });
      fs.writeFileSync(
        path.join(dir, "a.jsonl"),
        [
          line([
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "curl -X POST -H \"Shortcut-Token: $T\" https://api.app.shortcut.com/api/v3/stories/9/comments -d '{}'" },
            },
          ]),
          line([{ type: "tool_result", content: `curl -X PUT https://api.app.shortcut.com/api/v3/epics/9 ${CANARY}` }]),
        ].join("\n"),
      );
      const old = path.join(dir, "old.jsonl");
      fs.writeFileSync(old, line([{ type: "tool_use", name: "Bash", input: { command: "curl -X POST https://api.app.shortcut.com/api/v3/labels" } }]));
      const longAgo = new Date(Date.now() - 90 * 86400000);
      fs.utimesSync(old, longAgo, longAgo);
      const { callCounts, stats } = await scan({ roots: [dir], days: 30 });
      assert.deepEqual([...callCounts.keys()], [JSON.stringify(["shortcut", "POST", "^/api/v3/stories/\\d+/comments$"])]);
      assert.equal(stats.files, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
