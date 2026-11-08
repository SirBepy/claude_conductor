// The ChatMenuCtx for the selected live chat, built from live state. Shared by
// the header's overflow menu and the command palette so both offer the same
// "This chat" actions with the same disabled reasons.

import type { ChatMenuCtx } from "./chat-menu";
import { state } from "./state";
import { loadHiddenSessions, isSubchat, isMirrored } from "./sessions-helpers";
import { isAutoAccept, isSubchatsOn } from "./permission-modal";
import { subchatsBlockedReason } from "./subchats-gate";
import { isRemote } from "../../shared/transport";
import { cachedHasDeployWorkflow, refreshDeployWorkflowCache } from "./deploy-workflow-gate";

export function liveChatMenuCtx(sessionId: string, onAfterAction?: () => void): ChatMenuCtx {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const cwd = sess?.cwd ? String(sess.cwd) : null;
  const ctx: ChatMenuCtx = {
    kind: "live",
    sessionId,
    cwd,
    pid: sess?.pid ?? null,
    readOnly: sess?.kind === "external" || sess?.kind === "automated",
    autoAcceptOn: isAutoAccept(sessionId),
    subchatsOn: isSubchatsOn(sessionId),
    subchatsBlockedReason: subchatsBlockedReason(sess?.account_id),
    isSub: !!sess && isSubchat(sess),
    isHidden: loadHiddenSessions().has(sessionId),
    isJarvis: sess?.jarvis === true,
    isFrozen: sess?.frozen === true,
    hasDeployWorkflow: cachedHasDeployWorkflow(cwd),
    mirrored: isMirrored(sess),
    // Code mode's provider belongs to the chat on screen; another chat's row
    // (sidebar right-click) has none, and the item then reads "Open the chat to view changes".
    viewChanges: state.selectedId === sessionId ? state.activeChatActions?.viewChanges : undefined,
    onAfterAction,
  };
  if (!isRemote()) void refreshDeployWorkflowCache(cwd);
  return ctx;
}
