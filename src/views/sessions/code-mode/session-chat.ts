// The CodeModeChat for a chat shown in the sessions view (or a detached chat
// window), built from its renderer, header and the live session registry.

import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import type { FileEditView } from "../../../shared/chat/file-edits";
import { state } from "../state";
import type { CodeModeChat } from "./code-mode";

/** The newest send_message bubble: what the chat shows as Claude's latest line. */
function latestMessage(renderer: ChatRenderer | null): string {
  const msgs = renderer?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.kind === "message" && m.text) return m.text.replace(/\s+/g, " ").trim();
  }
  return "";
}

export function sessionCodeModeChat(opts: {
  pane: HTMLElement;
  sessionId: string | null;
  cwd: string;
  headerEl: HTMLElement;
  renderer: ChatRenderer | null;
  edits?: () => FileEditView[];
}): CodeModeChat {
  const { pane, renderer } = opts;
  const id = () => renderer?.sessionId ?? opts.sessionId;
  return {
    key: opts.sessionId ?? `draft:${opts.cwd}`,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    layout: pane.closest<HTMLElement>(".sessions-layout") ?? pane.parentElement!,
    title: () => opts.headerEl.querySelector(".title")?.textContent?.trim() ?? "",
    // Same "in progress" tier the sidebar spinner and thinking bar use.
    busy: () => {
      const s = state.sessions.find((x) => x.session_id === id());
      return !!s && (!!s.busy || s.awaiting === "working");
    },
    latestLine: () => latestMessage(renderer),
    edits: opts.edits ?? (() => renderer?.getFileEdits() ?? []),
    mention: (relPath) => state.composer?.insertText(`@${relPath} `),
    onGitChanged: () => state.statusbar?.refreshGit(),
  };
}
