// Live-tail popover for a `local-process` waiting-on chip (todo 675;
// decision: "live tail, not click-to-snapshot"). Polls `tail_waiting_log`
// on an interval and appends new bytes - the RPC re-validates `path` on
// every call, so this module never needs to trust the path it was handed.

import { openAnchoredPopover } from "./anchored-popover";
import { invoke } from "../ipc";

const POLL_MS = 1500;
const MAX_CHARS = 32_000; // cap DOM growth for a long-running tail

interface TailResult {
  content: string;
  offset: number;
}

export function openWaitingTailPanel(anchor: HTMLElement, sessionId: string, path: string): void {
  const pop = document.createElement("div");
  pop.className = "waiting-tail-panel";

  const header = document.createElement("div");
  header.className = "waiting-tail-header";
  header.textContent = path;
  header.title = path;

  const body = document.createElement("pre");
  body.className = "waiting-tail-body";
  body.textContent = "Loading…";

  pop.appendChild(header);
  pop.appendChild(body);
  document.body.appendChild(pop);

  let offset: number | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;

  const popover = openAnchoredPopover({
    anchor,
    el: pop,
    onClose: () => {
      if (timer !== null) clearInterval(timer);
      pop.remove();
    },
  });

  async function poll(): Promise<void> {
    try {
      const res = await invoke<TailResult>("tail_waiting_log", { sessionId, path, offset });
      offset = res.offset;
      if (res.content) {
        const prior = body.dataset.hasContent === "1" ? body.textContent ?? "" : "";
        const next = prior + res.content;
        body.textContent = next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next;
        body.dataset.hasContent = "1";
        body.scrollTop = body.scrollHeight;
      }
      popover.reposition();
    } catch (e) {
      body.textContent = `Could not read log: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}
