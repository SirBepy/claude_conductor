// Exposes the currently-mounted ChatRenderer's messages/messageEls to `this`-less
// consumers: attachment-hydrator.ts's thumb click, and the statusbar images chip.
// Module-singleton provider, same pattern as setFileEditsProvider (file-viewer.ts).
// Wired once per session by active-session-mount.ts's wireRenderer.

import type { RenderedMessage } from "./chat-transforms";

export interface ChatRendererSnapshot {
  messages: RenderedMessage[];
  messageEls: HTMLElement[];
}

let provider: (() => ChatRendererSnapshot) | null = null;

export function setChatImageDataProvider(fn: (() => ChatRendererSnapshot) | null): void {
  provider = fn;
}

export function getChatRendererSnapshot(): ChatRendererSnapshot | null {
  return provider ? provider() : null;
}
