// "Publish to claude.ai" for previews (the preview panel's More options
// menu). The daemon does the upload through a one-shot `claude -p` with the
// CLI's Artifact tool, so a click costs one short model turn; a link that is
// already current is just re-copied.
//
// Every page lands PRIVATE on claude.ai. Joe makes it shareable from the
// page's own Share menu, which is also the only gate before client work
// reaches anyone else - so there is no confirm step here, only the account
// name in the menu tooltip and in the toast.

import { invoke } from "./ipc";
import { isRemote } from "./transport";
import { showToast } from "./toast";
import type { PublishedLink } from "../types/ipc.generated";

export type PublishState = "none" | "current" | "stale";

/** Desktop only: the RPC has no phone transport row (it spends a model turn
 *  and uploads content, a write the phone path was never reviewed for). */
export function canPublish(): boolean {
  return !isRemote();
}

export function publishState(link: PublishedLink | null | undefined, version: number): PublishState {
  if (!link) return "none";
  return link.version === version ? "current" : "stale";
}

export function publishTitle(link: PublishedLink | null | undefined, version: number): string {
  switch (publishState(link, version)) {
    case "none": return "Private until you press Share on claude.ai";
    case "current": return `Published as ${link!.account}`;
    case "stale": return `Changed since it was published (as ${link!.account})`;
  }
}

export function publishIcon(link: PublishedLink | null | undefined, version: number): string {
  return publishState(link, version) === "current" ? "ph-link" : "ph-cloud-arrow-up";
}

export function publishLabel(link: PublishedLink | null | undefined, version: number): string {
  switch (publishState(link, version)) {
    case "none": return "Publish to claude.ai";
    case "current": return "Copy claude.ai link";
    case "stale": return "Update on claude.ai";
  }
}

function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, "");
}

/** The RPC's result: `stored` is false when the preview was removed while the
 *  upload ran, so the page exists on claude.ai but no link was remembered. */
interface PublishOutcome {
  published: PublishedLink;
  stored: boolean;
}

// A second click while a run is open would upload again; the first run's link
// is only recorded afterwards, so the second would also mint its own page.
const inFlight = new Set<string>();

async function copyLink(link: PublishedLink, verb: string, note = ""): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
  } catch {
    // The toast still carries the link, and clicking it opens the page.
  }
  showToast(`${verb} as ${link.account}, link copied: ${shortUrl(link.url)} - click to open, then Share to let others in${note}`, {
    ttlMs: 10000,
    onClick: () => void invoke("open_external", { url: link.url }),
  });
}

/** Publishes preview `id` (or re-copies a link that is already current) and
 *  reports the outcome in toasts. Returns the link once it is stored, null on
 *  failure or when the preview vanished before the link could be saved. */
export async function publishToClaudeAi(
  id: string,
  existing: PublishedLink | null | undefined,
  version: number,
): Promise<PublishedLink | null> {
  if (existing && publishState(existing, version) === "current") {
    await copyLink(existing, "Published");
    return existing;
  }
  if (inFlight.has(id)) {
    showToast("Already publishing this preview to claude.ai", { ttlMs: 4000 });
    return null;
  }
  inFlight.add(id);
  // The menu closes on click, so the run (up to three minutes) would
  // otherwise give no sign it started.
  showToast("Publishing to claude.ai...", { ttlMs: 4000 });
  try {
    const { published, stored } = await invoke<PublishOutcome>("publish_to_claude_ai", { id });
    await copyLink(published, existing ? "Updated" : "Published privately", stored ? "" : " (preview was removed, link not saved)");
    return stored ? published : null;
  } catch (err) {
    showToast(`Publish to claude.ai failed: ${String(err)}`, { ttlMs: 10000 });
    return null;
  } finally {
    inFlight.delete(id);
  }
}
