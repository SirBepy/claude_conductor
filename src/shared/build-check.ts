/**
 * Phone only: a page left open across a PC update reloads itself once the PC
 * serves a different build. The daemon restarts on every update and embeds a new
 * bundle whose hashed chunks the old page no longer finds, so without this the
 * old page keeps running old code against the new daemon.
 *
 * The page's own build id is the `<meta name="cc-build">` the daemon injects
 * into index.html (remote_static.rs); the daemon's current id is `build` in the
 * unauthenticated `/api/health`. The two are compared whenever the global stream
 * (re)opens, which is the moment a restarted daemon becomes reachable again.
 */

import { onGlobalStreamOpen } from "./global-stream";
import { note } from "./link-journal";

/** sessionStorage key holding the build id this tab already reloaded to, so a
 *  daemon that keeps answering a different id than its own page carries (a
 *  proxy in between, a build that stamps nothing) can never loop reloads. */
export const RELOADED_TO_KEY = "cc_build_reloaded_to";

export type BuildVerdict = "stay" | "defer" | "reload";

/** Pure decision. `pageBuild` null means the page was served without a stamp
 *  (dev server, an older daemon): never reload on that. */
export function buildVerdict(args: {
  pageBuild: string | null;
  daemonBuild: string | null;
  reloadedTo: string | null;
  busy: boolean;
}): BuildVerdict {
  const { pageBuild, daemonBuild, reloadedTo, busy } = args;
  if (!pageBuild || !daemonBuild || pageBuild === daemonBuild) return "stay";
  if (reloadedTo === daemonBuild) return "stay";
  return busy ? "defer" : "reload";
}

export function pageBuildId(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="cc-build"]')?.content || null;
}

/** Unsent text in any message box (a composer or a question card's answer
 *  field): a reload would throw it away. */
export function hasUnsentText(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type='text']")) {
    if (el.value.trim() !== "") return true;
  }
  // The drafts editor is a contenteditable, not a form control.
  for (const el of doc.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='plaintext-only']")) {
    if ((el.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

async function daemonBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === "string" && body.build ? body.build : null;
  } catch {
    return null;
  }
}

/** One comparison; returns the verdict it acted on. */
export async function checkBuildOnce(): Promise<BuildVerdict> {
  const pageBuild = pageBuildId();
  if (!pageBuild) return "stay";
  const daemonBuild = await daemonBuildId();
  let reloadedTo: string | null = null;
  try {
    reloadedTo = sessionStorage.getItem(RELOADED_TO_KEY);
  } catch {
    // Storage blocked: the stamp cannot guard a loop, so never reload.
    return "stay";
  }
  const verdict = buildVerdict({ pageBuild, daemonBuild, reloadedTo, busy: hasUnsentText() });
  if (verdict === "reload" && daemonBuild) {
    note("build_reload");
    sessionStorage.setItem(RELOADED_TO_KEY, daemonBuild);
    location.reload();
  }
  return verdict;
}

/** Wires the check to the stream's opens and to the page coming back to the
 *  front; a deferred reload is retried at the next of either. Lives for the
 *  app's lifetime. */
export function mountBuildCheck(): void {
  if (!pageBuildId()) return;
  const run = (): void => void checkBuildOnce();
  onGlobalStreamOpen(run);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") run();
  });
}
