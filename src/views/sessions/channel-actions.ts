// Restart / stop / terminal / phone link for a project's automated channel.
// A channel never restarts itself (it spawns once and stays dead until a manual
// Restart), so these must stay reachable from the dashboard's project menu even
// when the channel is dead and has no chat row, and from the live channel's own
// chat menu.
import { api } from "../../shared/api";
import { showToast } from "../../shared/toast";

export interface ChannelItem { icon: string, label: string, run: () => void, danger?: boolean }

/** A live channel's session id, the key `phone_link` takes. Null when the
 *  channel is dead or has no bridge session yet. */
export interface ChannelRef { projectId: string, phoneSessionId: string | null }

async function attempt(what: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { showToast(`Could not ${what}: ${String(err)}`); }
}

async function copyPhoneLink(sessionId: string): Promise<void> {
  const url = await api.phoneLink(sessionId);
  if (!url) { showToast("Phone link not available yet."); return; }
  await navigator.clipboard.writeText(url);
  showToast(`Copied: ${url}`);
}

export function channelItems(ref: ChannelRef): ChannelItem[] {
  const { projectId, phoneSessionId } = ref;
  const items: ChannelItem[] = [
    {
      icon: "arrows-clockwise", label: "Restart channel",
      run: () => void attempt("restart the channel", async () => { await api.restartChannel(projectId); showToast("Restarting the channel..."); }),
    },
    {
      icon: "terminal-window", label: "Show terminal",
      run: () => void attempt("show the terminal", () => api.showTerminal(projectId)),
    },
  ];
  if (phoneSessionId) {
    items.push({
      icon: "device-mobile", label: "Phone link",
      run: () => void attempt("get the phone link", () => copyPhoneLink(phoneSessionId)),
    });
  }
  items.push({
    icon: "stop", label: "Stop channel", danger: true,
    run: () => void attempt("stop the channel", async () => { await api.stopChannel(projectId); showToast("Channel stopped."); }),
  });
  return items;
}
