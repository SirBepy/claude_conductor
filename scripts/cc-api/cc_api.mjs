#!/usr/bin/env node
// cc_api: call Joe's API tokens through the Conductor broker; the token never reaches this script.
//   node cc_api.mjs SERVICE PATH [-X METHOD] [-d JSON|@file] [-o OUT_FILE] [--download]
// Reads CC_BROKER_TOKEN and CC_BROKER_URL (set for every Conductor chat) and prints only the broker's
// masked JSON answer. Exit 0 when ok, 1 otherwise. Docs: docs/architecture/api-broker.md.
import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// node:http with its own Agent, not fetch: Node 24+ routes fetch and the global agent through
// HTTP_PROXY when NODE_USE_ENV_PROXY is set, and the token must only ever reach the loopback address.
const post = (url, headers, text) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: "POST", headers, agent: new http.Agent() }, (res) => {
    let raw = ""; res.setEncoding("utf8"); res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, raw }));
    // A daemon that dies mid-answer emits neither `end` nor `error` on the response, only `close`.
    res.on("error", reject); res.on("close", () => { if (!res.complete) reject(Object.assign(new Error("closed mid-answer"), { code: "ECONNRESET" })); });
  });
  req.setTimeout(300000, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
  req.on("error", reject); req.end(text);
});

export async function call(service, path, { method, body, outFile, download } = {}) {
  const token = process.env.CC_BROKER_TOKEN, base = process.env.CC_BROKER_URL;
  if (!token || !base) return { ok: false, error: "CC_BROKER_TOKEN and CC_BROKER_URL are set only inside a Conductor chat" };
  const text = JSON.stringify({ service, path, method, body, out_file: outFile, download: download || undefined });
  try {
    const r = await post(base.replace(/\/+$/, "") + "/hooks/api-broker-http",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }, text);
    try { return JSON.parse(r.raw); } catch { return { ok: false, error: `the broker answered HTTP ${r.status}` }; }
  } catch (e) { return { ok: false, error: `the broker is unreachable: ${e.code ?? e.message}` }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: v, positionals: [service, path] } = parseArgs({ allowPositionals: true, options: {
    method: { type: "string", short: "X" }, data: { type: "string", short: "d" }, "out-file": { type: "string", short: "o" }, download: { type: "boolean" } } });
  const text = v.data?.startsWith("@") ? readFileSync(v.data.slice(1), "utf8") : v.data;
  const result = await call(service, path, { method: v.method, body: text ? JSON.parse(text) : undefined, outFile: v["out-file"], download: v.download });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
