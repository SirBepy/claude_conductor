import type { RenderedMessage } from "./chat-transforms";

/** Clamp over-long user messages behind a "Show more" toggle. Idempotent via data-clamp-checked. */
export function clampUserMessages(messages: RenderedMessage[], messageEls: HTMLElement[]): void {
  const MAX_PX = 220;
  for (let i = 0; i < messageEls.length; i++) {
    if (messages[i]?.kind !== "user") continue;
    const el = messageEls[i];
    if (!el || el.dataset.clampChecked) continue;
    el.dataset.clampChecked = "1";
    if (el.scrollHeight <= MAX_PX + 40) continue;
    const body = document.createElement("div");
    body.className = "msg-clamp-body";
    while (el.firstChild) body.appendChild(el.firstChild);
    el.appendChild(body);
    el.classList.add("has-clamp");
    const toggle = document.createElement("button");
    toggle.className = "msg-clamp-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const expanded = el.classList.toggle("expanded");
      toggle.textContent = expanded ? "Show less" : "Show more";
    });
    el.appendChild(toggle);
  }
}
