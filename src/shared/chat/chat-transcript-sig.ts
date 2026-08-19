// "Does the chat show what the transcript says" oracle, shared by the event
// store (JSONL page) and ChatRenderer (what it painted). Narrower than
// event-store's dedup `sigOf`: a tool the renderer legitimately never turns
// into a row (TodoWrite, update_message) must not look like a drop.

import type { ChatEvent } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-classifiers";
import { blocksToText } from "./content-blocks";
import { noiseAssistantLabel } from "./chat-transforms";
import { isAskQuestionTool } from "./tool-meta";

const SEND_MESSAGE_TOOL = "mcp__cc_conductor__send_message";

/** Visible-message sigs of an authoritative transcript page, oldest first. */
export function visibleEventSigs(events: ChatEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type === "assistant_message") {
      // Partials mutate every chunk; CLI notices render as system rows.
      if (ev.streaming) continue;
      const text = blocksToText(ev.content).trim();
      if (!text || noiseAssistantLabel(text) !== null) continue;
      out.push(`a:${text}`);
    } else if (ev.type === "tool_use" && !ev.parent_tool_use_id) {
      if (ev.tool_name === SEND_MESSAGE_TOOL || isAskQuestionTool(ev.tool_name)) {
        out.push(`tu:${ev.id}`);
      }
    }
  }
  return out;
}

/** The same sigs for what a renderer has actually painted. */
export function visibleMessageSigs(messages: RenderedMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.kind === "assistant") {
      const text = blocksToText(m.content ?? []).trim();
      if (text) out.add(`a:${text}`);
    } else if ((m.kind === "message" || m.kind === "question") && m.id) {
      out.add(`tu:${m.id}`);
    }
  }
  return out;
}
