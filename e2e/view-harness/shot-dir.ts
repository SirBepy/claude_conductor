import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "@playwright/test";

/** `<pid>-<procStart-ticks>`, the id `close/rename-session.ps1 -GetId` prints: the
 *  ~/.claude/sessions record whose sessionId matches this session. Global CLAUDE.md:
 *  "never hand-rolled - unstable, see todo 60." */
function sessionShotId(): string {
  const pinned = process.env.CC_SHOT_ID;
  if (pinned) return pinned;
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const dir = path.join(homedir(), ".claude", "sessions");
  const cachePath = sid ? path.join(dir, ".getid-cache", `${sid}.txt`) : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8").trim();
    if (cached) return cached;
  }
  if (sid && existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
          sessionId?: string; pid?: number; procStart?: string;
        };
        if (rec.sessionId === sid && rec.pid && rec.procStart) {
          const id = `${rec.pid}-${rec.procStart}`;
          // First writer wins, matching rename-session.ps1's Set-CachedGetId, so whichever
          // side resolves first is authoritative for both.
          if (cachePath && !existsSync(cachePath)) {
            try {
              mkdirSync(path.dirname(cachePath), { recursive: true });
              writeFileSync(cachePath, id);
            } catch {
              /* best effort - a race with rename-session.ps1 writing the same file */
            }
          }
          return id;
        }
      } catch {
        /* a session file mid-write - skip it */
      }
    }
  }
  // Outside a Claude session (or env var unset): one bucket /disk-doctor can still age out.
  return "no-session";
}

/** `config.rootDir` is the testDir (e2e/view-harness), so climb to the directory
 *  holding playwright.config.ts, which is the repo root. `test.info()` throws outside
 *  a running test, which is the normal case here: a spec calls shotDir() at module
 *  scope during collect, and cwd is the repo root there. */
function repoRoot(): string {
  let dir: string;
  try {
    dir = test.info().config.rootDir;
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "playwright.config.ts"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/** Resolve (and create) this session's throwaway screenshot directory under
 *  `.for_bepy/screenshots/<session-id>/`, the repo convention for disposable
 *  verification shots.
 *
 *  This is the ONE place in the harness that builds a screenshot path - `capture()`
 *  routes through it too. It takes no caller-supplied id on purpose: a hand-rolled
 *  literal (a typed date string, `:` and all) is a Windows-illegal path, and three
 *  specs carrying one aborted the whole `test:view` run at collect time (todo 958). */
export function shotDir(): string {
  const dir = path.join(repoRoot(), ".for_bepy", "screenshots", sessionShotId());
  mkdirSync(dir, { recursive: true });
  return dir;
}
