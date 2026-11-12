// Which `claude-conductor.exe --daemon` pids wdio's onComplete may kill.
//
// The INSTALLED app runs the same command line as the harness daemon, so the
// only safe rule is "kill a pid only if a snapshot taken before the run proves
// it did not exist then". A missing or unreadable snapshot proves nothing, so
// it kills nothing: on 2026-11-07 onComplete ran after onPrepare threw before
// the snapshot was taken, read the missing env as "no daemons existed", and
// killed Joe's live daemon ten times in four minutes.

/**
 * @param {string | undefined} snapshotEnv CC_WDIO_PREEXISTING_DAEMON_PIDS. An
 *   empty string is a valid snapshot (no daemon existed); undefined or anything
 *   that is not a comma-separated list of integer pids is not.
 * @param {string[] | null | undefined} nowPids daemon pids running now, or null
 *   when listing them failed.
 * @returns {string[]} pids that did not exist at snapshot time.
 */
export function pidsToKill(snapshotEnv, nowPids) {
  if (typeof snapshotEnv !== "string") return [];
  if (!Array.isArray(nowPids)) return [];
  const tokens = snapshotEnv === "" ? [] : snapshotEnv.split(",");
  if (!tokens.every((t) => /^\d+$/.test(t.trim()))) return [];
  const before = new Set(tokens.map((t) => t.trim()));
  return nowPids.map((p) => String(p).trim()).filter((p) => /^\d+$/.test(p) && !before.has(p));
}

/**
 * The value to store in CC_WDIO_PREEXISTING_DAEMON_PIDS, or undefined when the
 * pid listing failed (the env must then stay unset so nothing is killed).
 * @param {string[] | null | undefined} nowPids
 */
export function snapshotValue(nowPids) {
  return Array.isArray(nowPids) ? nowPids.join(",") : undefined;
}
