#!/usr/bin/env node
// cc_api: call Joe's API tokens through the Conductor broker; the token never reaches this script.
//   node cc_api.mjs SERVICE PATH [-X METHOD] [-d JSON|@file] [-o OUT_FILE] [--download]
// Reads CC_BROKER_TOKEN and CC_BROKER_URL (set for every Conductor chat) and prints only the broker's
// masked JSON answer. Exit 0 when ok, 1 otherwise. Docs: docs/architecture/api-broker.md.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export async function call(service, path, { method, body, outFile, download } = {}) {
  const token = process.env.CC_BROKER_TOKEN, base = process.env.CC_BROKER_URL;
  if (!token || !base) return { ok: false, error: "CC_BROKER_TOKEN and CC_BROKER_URL are set only inside a Conductor chat" };
  const args = { service, path, method, body, out_file: outFile, download: download || undefined };
  try { // fetch ignores proxy env vars: the token only ever goes to the loopback address.
    const r = await fetch(base.replace(/\/+$/, "") + "/hooks/api-broker-http", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return await r.json().catch(() => ({ ok: false, error: `the broker answered HTTP ${r.status}` }));
  } catch (e) { return { ok: false, error: `the broker is unreachable: ${e.cause?.code ?? e.message}` }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: v, positionals: [service, path] } = parseArgs({ allowPositionals: true, options: {
    method: { type: "string", short: "X" }, data: { type: "string", short: "d" }, "out-file": { type: "string", short: "o" }, download: { type: "boolean" } } });
  const text = v.data?.startsWith("@") ? readFileSync(v.data.slice(1), "utf8") : v.data;
  const result = await call(service, path, { method: v.method, body: text ? JSON.parse(text) : undefined, outFile: v["out-file"], download: v.download });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
