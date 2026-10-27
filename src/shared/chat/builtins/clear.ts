import { invoke } from "../../ipc";
import { launchNewSession } from "../../../views/sessions/pending-flow";
import { resolveNewChatConfig } from "../../../views/sessions/new-chat-config";
import type { BuiltinContext, BuiltinHandler } from "./index";

let inflight = false;

export const clearSession: BuiltinHandler = async (_parsed, ctx: BuiltinContext) => {
  if (inflight) return;
  if (!ctx.projectDir || !ctx.pane) {
    console.warn("[builtin /clear] missing projectDir or pane; cannot restart");
    return;
  }
  inflight = true;
  try {
    if (ctx.sessionId) {
      try {
        await invoke<void>("clear_session", { sessionId: ctx.sessionId });
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
