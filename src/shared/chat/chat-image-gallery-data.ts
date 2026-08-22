// Chat-wide image gallery data (ai_todo: chunk 1 of the gallery feature): a
// flat, ordered list of every attachment, tool-result screenshot and inline
// image block in a chat, grouped into one "entry" per turn with an image. Pure data
// logic, no overlay/UI - a later chunk builds the viewer on top of this.

import { isBoundaryMessage, type RenderedMessage } from "./chat-classifiers";
import { collectScreenshotShots } from "./screenshot-row";
import { attachmentShots } from "./attachment-hydrator";
import { blocksToText } from "./content-blocks";

export interface ChatImage {
  index: number;
  kind: "attachment" | "screenshot" | "inline";
  mime: string;
  data: string;
  title: string;
  agentKind: "user" | "main" | "sub";
  agentTag: string;
  agentLabel: string;
  entryIndex: number;
  sourcePath?: string;
}

export interface ChatImageEntry {
  turnNumber: number;
  name: string;
  images: number[];
}

export interface ChatImageCollection {
  images: ChatImage[];
  entries: ChatImageEntry[];
  /** Gallery index of each inline `<img class="block image">` element, so a
   *  click resolves by element identity instead of matching image bytes
   *  (todo 740: byte-matching missed every image rendered only once). */
  byElement: WeakMap<Element, number>;
}

const FILE_TOKEN_RE = /<file:[^>]*>/g;
const MAX_NAME_LEN = 80;

function turnRanges(messages: RenderedMessage[]): Array<[number, number]> {
  const starts = [0];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m && isBoundaryMessage(m)) starts.push(i);
  }
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : messages.length;
    ranges.push([start, end]);
  }
  return ranges;
}

function entryName(messages: RenderedMessage[], start: number, images: ChatImage[], turnNumber: number): string {
  const opener = messages[start];
  if (opener && opener.kind === "user") {
    const text = blocksToText(opener.content ?? [])
      .replace(FILE_TOKEN_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, MAX_NAME_LEN);
  }
  if (images.length > 0) return images[0]!.title;
  return `Turn ${turnNumber}`;
}

/** A user or assistant `image` content block, which renders inline and which
 *  neither the attachment nor the screenshot pass ever produces. */
function inlineImage(fromUser: boolean, block: { mime: string; data: string }): Omit<ChatImage, "index" | "entryIndex"> {
  return {
    kind: "inline",
    mime: block.mime,
    data: block.data,
    title: fromUser ? "attachment" : "image",
    agentKind: fromUser ? "user" : "main",
    agentTag: fromUser ? "You" : "Main",
    agentLabel: fromUser ? "You attached" : "Main agent",
  };
}

export function collectChatImages(messages: RenderedMessage[], messageEls: HTMLElement[]): ChatImageCollection {
  const images: ChatImage[] = [];
  const entries: ChatImageEntry[] = [];
  const byElement = new WeakMap<Element, number>();

  for (const [start, end] of turnRanges(messages)) {
    const rangeImages: Array<Omit<ChatImage, "index" | "entryIndex">> = [];

    for (let i = start; i < end; i++) {
      const thumbs = messageEls[i]?.querySelectorAll<HTMLElement>(".sent-attachment-thumb") ?? [];
      for (const thumb of thumbs) {
        const shot = attachmentShots.get(thumb);
        if (!shot) continue;
        rangeImages.push({
          kind: "attachment",
          mime: shot.mime,
          data: shot.base64,
          title: shot.filename ?? "attachment",
          agentKind: "user",
          agentTag: "You",
          agentLabel: "You attached",
          sourcePath: shot.sourcePath,
        });
      }
    }

    const shotsByKey = collectScreenshotShots(messages, start, end);
    const slotByToolUseId = new Map<string, number>();
    for (const shots of shotsByKey.values()) {
      for (const shot of shots) {
        rangeImages.push({
          kind: "screenshot",
          mime: shot.mime,
          data: shot.data,
          title: shot.title,
          agentKind: shot.agentKind,
          agentTag: shot.agentTag,
          agentLabel: shot.agentLabel,
        });
        slotByToolUseId.set(shot.toolUseId, rangeImages.length - 1);
      }
    }

    // Bind each inline `<img class="block image">` to the slot it belongs to:
    // a tool_result's image reuses the screenshot pass's slot, a user or
    // assistant image block gets one of its own. Slots come from message data,
    // so a message the DOM hasn't built yet still counts.
    const slotByEl: Array<[Element, number]> = [];
    for (let i = start; i < end; i++) {
      const msg = messages[i];
      if (!msg) continue;
      const inlineEls = messageEls[i]?.querySelectorAll<HTMLImageElement>("img.block.image") ?? [];
      if (msg.kind === "tool_result") {
        const shotSlot = msg.tool_use_id ? slotByToolUseId.get(msg.tool_use_id) : undefined;
        if (shotSlot !== undefined && inlineEls[0]) slotByEl.push([inlineEls[0], shotSlot]);
        continue;
      }
      if (msg.kind !== "user" && msg.kind !== "assistant") continue;
      let seen = 0;
      for (const block of msg.content ?? []) {
        if (block.type !== "image") continue;
        rangeImages.push(inlineImage(msg.kind === "user", block));
        const el = inlineEls[seen];
        if (el) slotByEl.push([el, rangeImages.length - 1]);
        seen++;
      }
    }

    if (rangeImages.length === 0) continue;

    const rangeBase = images.length;
    const entryIndex = entries.length;
    const turnNumber = entries.length + 1;
    const imageIndices: number[] = [];
    for (const img of rangeImages) {
      const index = images.length;
      images.push({ ...img, index, entryIndex });
      imageIndices.push(index);
    }
    for (const [el, slot] of slotByEl) byElement.set(el, rangeBase + slot);
    entries.push({
      turnNumber,
      name: entryName(messages, start, images.filter((img) => img.entryIndex === entryIndex), turnNumber),
      images: imageIndices,
    });
  }

  return { images, entries, byElement };
}
