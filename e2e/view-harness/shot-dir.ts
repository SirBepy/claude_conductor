import { mkdirSync } from "node:fs";
import path from "node:path";

/** Resolve (and create) this chat's throwaway screenshot directory under
 *  `.for_bepy/screenshots/<session-id>/`, the repo convention for disposable
 *  verification shots.
 *
 *  Sanitising is the point. A session id is meant to be `<pid>-<ticks>`, but a
 *  hand-rolled one can carry a date string, and `:` is legal in that label
 *  while illegal in a Windows path component. Specs call this at module scope,
 *  so an unsanitised id fails at COLLECT time - which takes down the whole
 *  `test:view` run, not just the file that used it. */
export function shotDir(sessionId: string): string {
  const dir = path.join(
    process.cwd(),
    ".for_bepy",
    "screenshots",
    sessionId.replace(/[<>:"/\\|?*]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
