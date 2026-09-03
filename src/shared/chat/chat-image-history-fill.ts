// Shadow-only pagination: grows the gallery's image data past the loaded
// transcript without touching ChatRenderer's real messages/DOM (ai_todo 524,
// avoids compounding ai_todo 185's DOM-growth risk). Attachment chips still
// need a document-attached host to hydrate; removed right after each page.

import type { RenderedMessage } from "./chat-transforms";
import { eventToRenderedMessage, originSessionIdOf, renderMessage } from "./chat-transforms";
import { sessionEvents } from "./event-store";
import { hydrateAttachments } from "./attachment-hydrator";

// Keyed by the shadow message so callers can align it into a messageEls
// array; only ever set for "user" messages (the only kind with chips).
export const shadowMessageEls = new WeakMap<RenderedMessage, HTMLElement>();

function buildShadowUserEl(m: RenderedMessage): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = renderMessage(m);
  return (wrap.firstElementChild as HTMLElement | null) ?? wrap;
}

// Pages older history into `onPage` until exhausted/cancelled; each call
// carries the full accumulated extra messages so far (oldest-first).
export function startBackgroundImageFill(
  sessionId: string,
  cwd: string | undefined,
  onPage: (extraMessages: RenderedMessage[], hasMore: boolean) => void,
): () => void {
  let cancelled = false;
  const accumulator: RenderedMessage[] = [];

  void (async () => {
    try {
      while (!cancelled && sessionEvents.hasMore(sessionId)) {
        const page = await sessionEvents.loadOlder(sessionId, cwd);
        if (cancelled || page === null) break;

        const pageMessages: RenderedMessage[] = [];
        // Attached only for this page's hydration (hydrateAttachments needs
        // document.contains), then removed regardless of how the loop ends.
        const pageHost = document.createElement("div");
        pageHost.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
        pageHost.setAttribute("aria-hidden", "true");
        let hasChips = false;
        for (const ev of page) {
          const m = eventToRenderedMessage(ev);
          if (!m) continue;
          m.originSessionId = originSessionIdOf(ev);
          pageMessages.push(m);
          if (m.kind !== "user") continue;
          const el = buildShadowUserEl(m);
          if (!el.querySelector(".attachment-chip[data-attachment-path]")) continue;
          pageHost.appendChild(el);
          shadowMessageEls.set(m, el);
          hasChips = true;
        }
        if (hasChips) {
          document.body.appendChild(pageHost);
          await hydrateAttachments(pageHost);
          pageHost.remove();
        }
        if (cancelled) break;

        // Oldest-first overall, matching ChatPaginator.prependEvents' ordering.
        accumulator.unshift(...pageMessages);
        onPage(accumulator.slice(), sessionEvents.hasMore(sessionId));
      }
    } catch {
      /* stop the loop; pages already delivered via onPage stay valid */
    }
  })();

  return () => {
    cancelled = true;
  };
}
