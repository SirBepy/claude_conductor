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

async function copyLink(link: PublishedLink, verb: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
  } catch {
    // The toast still carries the link, and clicking it opens the page.
  }
  showToast(`${verb} as ${link.account}, link copied: ${shortUrl(link.url)} - click to open, then Share to let others in`, {
    ttlMs: 10000,
    onClick: () => void invoke("open_external", { url: link.url }),
  });
}

/** Publishes preview `id` (or re-copies a link that is already current) and
 *  reports the outcome in toasts. Returns the link on success. */
export async function publishToClaudeAi(
  id: string,
  existing: PublishedLink | null | undefined,
  version: number,
): Promise<PublishedLink | null> {
  if (existing && publishState(existing, version) === "current") {
    await copyLink(existing, "Published");
    return existing;
  }
  // The menu closes on click, so the run (up to a minute) would otherwise
  // give no sign it started.
  showToast("Publishing to claude.ai...", { ttlMs: 4000 });
  try {
    const link = await invoke<PublishedLink>("publish_to_claude_ai", { id });
    await copyLink(link, existing ? "Updated" : "Published privately");
    return link;
  } catch (err) {
    showToast(`Publish to claude.ai failed: ${String(err)}`, { ttlMs: 10000 });
    return null;
  }
}
