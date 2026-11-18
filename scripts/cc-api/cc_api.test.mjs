// Run: node --test scripts/cc-api/cc_api.test.mjs
// Both clients against a fake loopback front: the request they send, what they print, and that a
// token canary never shows up in anything they print.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Random per run: a fixed token-shaped literal in a test file is what the secret scan exists to stop.
const TOKEN = `canary-${randomUUID()}`;
const python = process.platform === "win32" ? "python" : "python3";
let server, base, seen, reply;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.text);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ok = { status: 200, text: JSON.stringify({ ok: true, status: 200, body: "{}" }) };
// Async, never spawnSync: the fake front lives in this process, and a blocked loop could not answer.
const exec = (cmd, args, env) =>
  new Promise((resolve) =>
    execFile(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8" }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
const runners = {
  mjs: (args, env) => exec(process.execPath, [join(here, "cc_api.mjs"), ...args], env),
  py: (args, env) => exec(python, ["-I", join(here, "cc_api.py"), ...args], env),
};
const env = (extra = {}) => ({ CC_BROKER_TOKEN: TOKEN, CC_BROKER_URL: base, ...extra });

for (const [name, run] of Object.entries(runners)) {
  test(`${name}: sends the bearer token and only the fields given, prints the answer`, async () => {
    reply = ok;
    const r = await run(["figma", "/v1/files/abc"], env());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, status: 200, body: "{}" });
    assert.equal(seen.url, "/hooks/api-broker-http");
    assert.equal(seen.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(seen.body, { service: "figma", path: "/v1/files/abc" });
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  });

  test(`${name}: method, body, out file and download are passed through`, async () => {
    reply = ok;
    const dir = mkdtempSync(join(tmpdir(), "cc-api-"));
    const file = join(dir, "body.json");
    writeFileSync(file, '{"name":"from a file"}');
    await run(["trello", "/1/cards", "-X", "POST", "-d", "@" + file, "-o", "out.json", "--download"], env());
    assert.deepEqual(seen.body, { service: "trello", path: "/1/cards", method: "POST", body: { name: "from a file" }, out_file: "out.json", download: true });
    await run(["shortcut", "/api/v3/search", "-X", "POST", "-d", '{"query":"x"}'], env());
    assert.deepEqual(seen.body.body, { query: "x" });
  });

  test(`${name}: an ok:false answer exits 1 and a 401 is read as the answer`, async () => {
    reply = { status: 401, text: JSON.stringify({ ok: false, error: "the broker token is missing, malformed, revoked or not from this session" }) };
    const r = await run(["figma", "/v1/me"], env());
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /revoked/);
    reply = { status: 502, text: "<html>not json</html>" };
    const html = await run(["figma", "/v1/me"], env());
    assert.equal(html.status, 1);
    assert.match(JSON.parse(html.stdout).error, /HTTP 502/);
  });

  test(`${name}: no env or an unreachable daemon is an error that never prints the token`, async () => {
    const none = await run(["figma", "/v1/me"], { CC_BROKER_TOKEN: "", CC_BROKER_URL: "" });
    assert.equal(none.status, 1);
    assert.match(JSON.parse(none.stdout).error, /only inside a Conductor chat/);
    const dead = await run(["figma", "/v1/me"], env({ CC_BROKER_URL: "http://127.0.0.1:1" }));
    assert.equal(dead.status, 1);
    assert.match(JSON.parse(dead.stdout).error, /unreachable/);
    for (const r of [none, dead]) assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  });

  test(`${name}: a proxy in the environment is never used for the loopback call`, async () => {
    reply = ok;
    // A proxy that is not listening: if the client used it, the call would fail as unreachable.
    const proxy = "http://127.0.0.1:1";
    const r = await run(["figma", "/v1/me"], env({ HTTP_PROXY: proxy, http_proxy: proxy, ALL_PROXY: proxy, NO_PROXY: "", NODE_USE_ENV_PROXY: "1" }));
    assert.equal(r.status, 0, r.stdout);
  });
}
