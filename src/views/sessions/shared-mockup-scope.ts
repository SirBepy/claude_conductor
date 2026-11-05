// Which chats a preview panel covers. A main chat's panel shows the previews of
// the chat and of its subs (the shared mockup and each sub's dedicated ones);
// every other chat still sees only its own. Reading a sub in place scopes the
// panel to the sub's family, so it shows the same page with that sub's chip.

import type { Instance } from "../../types/ipc.generated";
import { mainChatInfo } from "./main-chat";
import { subInitials, subRingSpec } from "./sub-list";
import { ringHtml } from "./sidebar-ring";
import { state } from "./state";

function inst(sessionId: string | null | undefined): Instance | undefined {
  return sessionId ? state.sessions.find((s) => s.session_id === sessionId) : undefined;
}

/** The main chat a sub belongs to, else the chat itself. */
export function scopeRoot(sessionId: string | null): string | null {
  return inst(sessionId)?.subchat_of ?? sessionId;
}

/** Whether a preview filed under `owner` is shown by a panel scoped to `scope`. */
export function inFamily(owner: string | null | undefined, scope: string | null): boolean {
  if (!owner || !scope) return false;
  const root = scopeRoot(scope);
  return owner === scope || owner === root || inst(owner)?.subchat_of === root;
}

export interface OwnerTag {
  name: string;
  /** The avatar circle: initials with the sub's state ring around it. */
  avatarHtml: string;
}

/** The sub a preview was filed under, for the "Only <sub>" tag and the picker's
 *  owner column. Null for the main chat itself (nothing to tag). */
export function ownerTag(ownerId: string | null | undefined): OwnerTag | null {
  const owner = inst(ownerId);
  if (!owner?.subchat_of) return null;
  const main = inst(owner.subchat_of);
  const sub = main ? mainChatInfo(main, state.sessions).subs.find((s) => s.id === owner.session_id) : undefined;
  if (!sub) return null;
  return {
    name: sub.name,
    avatarHtml: `<span class="sub-dot pvs-dot">${subInitials(sub.name)}${ringHtml(subRingSpec(sub, owner))}</span>`,
  };
}

/** The subs of the scope's main chat, for the row's dashed chips. */
export function familySubs(scope: string | null): ReturnType<typeof mainChatInfo>["subs"] {
  const root = inst(scopeRoot(scope));
  return root ? mainChatInfo(root, state.sessions).subs : [];
}
