// Chat-wide image gallery data (ai_todo: chunk 1 of the gallery feature): a
// flat, ordered list of every attachment + tool-result screenshot in a chat,
// grouped into one "entry" per turn that has at least one image. Pure data
// logic, no overlay/UI - a later chunk builds the viewer on top of this.

import { isBoundaryMessage, type RenderedMessage } from "./chat-classifiers";
import { collectScreenshotShots } from "./screenshot-row";
import { attachmentShots } from "./attachment-hydrator";
import { blocksToText } from "./content-blocks";

export interface ChatImage {
  index: number;
  kind: "attachment" | "screenshot";
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

export function collectChatImages(messages: RenderedMessage[], messageEls: HTMLElement[]): ChatImageCollection {
  const images: ChatImage[] = [];
  const entries: ChatImageEntry[] = [];

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
      }
    }

    if (rangeImages.length === 0) continue;

    const entryIndex = entries.length;
    const turnNumber = entries.length + 1;
    const imageIndices: number[] = [];
    for (const img of rangeImages) {
      const index = images.length;
      images.push({ ...img, index, entryIndex });
      imageIndices.push(index);
    }
    entries.push({
      turnNumber,
      name: entryName(messages, start, images.filter((img) => img.entryIndex === entryIndex), turnNumber),
      images: imageIndices,
    });
  }

  return { images, entries };
}
