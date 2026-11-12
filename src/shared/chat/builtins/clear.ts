import { invoke } from "../../ipc";
import { showToast } from "../../toast";
import { state } from "../../../views/sessions/state";
import { launchNewSession } from "../../../views/sessions/pending-flow";
import { resolveNewChatConfig } from "../../../views/sessions/new-chat-config";
import type { BuiltinContext, BuiltinHandler } from "./index";

let inflight = false;

/** Said when /clear is typed in a sub's view. */
export const SUB_CLEAR_REFUSAL =
  "A subchat is a job defined by its brief, so /clear does not apply to it. Close it, or start a new chat for the other job.";

export const clearSession: BuiltinHandler = async (_parsed, ctx: BuiltinContext) => {
  if (inflight) return;
  // A sub's job is its brief: clearing it would end the sub and start an unrelated
  // chat in its project, with no note to the main chat that handed it the job.
  const open = ctx.sessionId ? state.sessions.find((s) => s.session_id === ctx.sessionId) : undefined;
  if (open?.subchat_of != null) {
    showToast(SUB_CLEAR_REFUSAL);
    return;
  }
  if (!ctx.projectDir || !ctx.pane) {
    console.warn("[builtin /clear] missing projectDir or pane; cannot restart");
    return;
  }
  inflight = true;
  try {
    if (ctx.sessionId) {
      try {
        // True when the daemon held the close: this is a main chat with a sub still
        // running or with unmerged work, or a project's main chat (closing it deletes its
        // Answers and Ask threads), and Joe is being asked on a card. The chat is still
        // open, so no new one starts under the card; after "Close anyway" the project's
        // next open main chat takes its place, or it has none until Joe starts one.
        const held = await invoke<boolean | void>("clear_session", { sessionId: ctx.sessionId });
        if (held === true) return;
      } catch (e) {
        console.warn("[builtin /clear] clear_session IPC failed, continuing", e);
      }
    }
    const projectName = deriveName(ctx.projectDir);
    const config = await resolveNewChatConfig(ctx.projectDir);
    await launchNewSession(ctx.pane, {
      path: ctx.projectDir,
      name: projectName,
    }, config);
  } finally {
    inflight = false;
  }
};

function deriveName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
