#!/usr/bin/env python3
"""cc_api: call Joe's API tokens through the Conductor broker; the token never reaches this script.
  cc_api.py SERVICE PATH [-X METHOD] [-d JSON|@file] [-o OUT_FILE] [--download]
Reads CC_BROKER_TOKEN and CC_BROKER_URL (set for every Conductor chat) and prints only the broker's
masked JSON answer. Exit 0 when ok, 1 otherwise. Docs: docs/architecture/api-broker.md."""
import argparse, json, os, sys, urllib.error, urllib.request

def call(service, path, method=None, body=None, out_file=None, download=False):
    token, base = os.environ.get("CC_BROKER_TOKEN"), os.environ.get("CC_BROKER_URL")
    if not token or not base:
        return {"ok": False, "error": "CC_BROKER_TOKEN and CC_BROKER_URL are set only inside a Conductor chat"}
    args = {"service": service, "path": path, "method": method, "body": body, "out_file": out_file, "download": download or None}
    req = urllib.request.Request(base.rstrip("/") + "/hooks/api-broker-http", json.dumps({k: v for k, v in args.items() if v is not None}).encode(),
                                 {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:  # No proxy: the token must only ever go to the loopback address.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: return json.load(e)
        except ValueError: return {"ok": False, "error": f"the broker answered HTTP {e.code}"}
    except OSError as e:
        return {"ok": False, "error": f"the broker is unreachable: {getattr(e, 'reason', e)}"}

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("service"); p.add_argument("path")
    p.add_argument("-X", "--method"); p.add_argument("-d", "--data"); p.add_argument("-o", "--out-file"); p.add_argument("--download", action="store_true")
    a = p.parse_args()
    data = open(a.data[1:], encoding="utf-8").read() if (a.data or "").startswith("@") else a.data
    result = call(a.service, a.path, a.method, json.loads(data) if data else None, a.out_file, a.download)
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)
