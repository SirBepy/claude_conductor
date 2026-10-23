// The `pr_preview` tool call, turned into the same finalized assistant row the
// `<cc-pr-*>` text markers used to produce. Everything downstream (the card,
// its quiet-mode visibility, the silent-turn check, the Preview modal) keys on
// those markers, so the tool reuses them instead of a second card path. The
// marker parser stays for transcripts written before the tool existed.

import type { ContentBlock } from "../../types/ipc.generated";
import type { RenderedMessage } from "./chat-classifiers";
import { asObj, strField } from "../obj-utils";
import { utf8ToBase64 } from "./chat-transforms";

/** The marker text for a `pr_preview` input. `>` ends a title marker, so a
 *  title carrying one is shown with `›` instead. */
export function prToolMarkerText(input: unknown): string {
  const o = asObj(input);
  const title = strField(o, "title").replace(/>/g, "›");
  const raw = Array.isArray(o["commits"]) ? (o["commits"] as unknown[]) : [];
  const commits = raw.map((c) => ({ sha: strField(asObj(c), "sha"), msg: strField(asObj(c), "msg") }));
  return `<cc-pr-title:${title}>\n<cc-pr-body:${utf8ToBase64(strField(o, "body"))}>\n<cc-pr-commits:${utf8ToBase64(JSON.stringify(commits))}>`;
}

export function prToolMessage(input: unknown, id: string, ts: number): RenderedMessage {
  const content: ContentBlock[] = [{ type: "text", text: prToolMarkerText(input) }];
  return { kind: "assistant", content, streaming: false, id, ts, parentToolUseId: null };
}
