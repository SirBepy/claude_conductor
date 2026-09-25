import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** `<pid>-<procStart-ticks>`, the id `close/rename-session.ps1 -GetId` prints: the
 *  ~/.claude/sessions record whose sessionId matches this session. Global CLAUDE.md:
 *  "never hand-rolled - unstable, see todo 60."
 *
 *  This is a duplicate of `harness.ts`'s own (unexported) `sessionShotId()` - todo 958
 *  wanted `shotDir()` to import that one directly instead of re-implementing it, but
 *  `harness.ts` was owned by a different lane in the run that fixed this todo and stayed
 *  out of reach. Once `sessionShotId()`/`repoRoot()` are exported from `harness.ts`, this
 *  copy should be deleted and `shotDir()` should call those instead - see the todo 958
 *  file for the follow-up note. */
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

/** Resolve (and create) this session's throwaway screenshot directory under
 *  `.for_bepy/screenshots/<session-id>/`, the repo convention for disposable
 *  verification shots. The id is always resolved via `sessionShotId()` above, never
 *  supplied by the caller - a hand-rolled literal (a typed date string, `:` and all) is
 *  exactly what put a Windows-illegal path into three specs and aborted the whole
 *  `test:view` run at collect time (todo 958).
 *
 *  The parameter is accepted-and-ignored, not removed, purely so the existing call sites
 *  in `characters.view.spec.ts` / `projects.view.spec.ts` / `skills.view.spec.ts` (outside
 *  this fix's file scope) keep passing their old literal without a type error; it has no
 *  effect. New callers should call `shotDir()` with no argument. */
export function shotDir(_legacyCallerSuppliedId?: string): string {
  const dir = path.join(process.cwd(), ".for_bepy", "screenshots", sessionShotId());
  mkdirSync(dir, { recursive: true });
  return dir;
}
