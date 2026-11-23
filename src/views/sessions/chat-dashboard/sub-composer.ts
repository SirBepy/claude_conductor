// The message box aimed at one sub: the chat's own Composer, embedded. The opened sub view
// (sub-peek.ts) and the merged Plan card's opened feature (features-card.ts) both mount it, so a
// message to a sub goes out, is held while the sub works, or is refused, the same way in both.

import { showToast } from "../../../shared/toast";
import { invoke } from "../../../shared/ipc";
import { Composer } from "../../../shared/chat/composer";
import { isSessionBusyError } from "../../../shared/session-busy";
import { apiCreditBlockedReason } from "../../../shared/api-credit-blocked";
import type { ContentBlock, Instance } from "../../../types/ipc.generated";
import { state } from "../state";

export interface SubComposerDeps {
  instance(id: string): Instance | undefined;
  /** The main chat's folder, for a sub the instance list does not carry a folder for. */
  cwd(): string | null;
  /** The sub's name, for the "mid-turn" notice. */
  name(id: string): string;
  /** The host machine's label while the sub's machine is offline, else null. */
  offlineLabel(id: string): string | null;
}

/** Mounts the chat's Composer aimed at `subId` inside `root`. `embedded` keeps it from taking the
 *  process-wide hooks (type-anywhere relay, lightbox caption, Escape, push-to-talk) from the
 *  main chat's own composer; it is not focused on mount, which on a phone would leave the
 *  keyboard without voice and swipe. */
export function mountSubComposer(root: HTMLElement, subId: string, deps: SubComposerDeps): Composer {
  const inst = (): Instance | undefined => deps.instance(subId);
  const cwd = (): string => String(inst()?.cwd ?? deps.cwd() ?? ".");
  const heldNotice = (): string => `${deps.name(subId)} is mid-turn. Your message goes out when it finishes.`;
  const composer = new Composer(root, {
    embedded: true,
    projectDir: inst()?.cwd ?? deps.cwd() ?? null,
    getRenderer: () => null,
    // A working sub holds the message like any busy chat; the held controller sends
    // it when the sub's turn ends, whichever chat is on screen.
    isBusy: () => inst()?.busy === true,
    isOffline: () => deps.offlineLabel(subId),
    onStage: (blocks) => {
      const held = state.heldMessages?.stageFor(subId, blocks) ?? false;
      // The chat's own composer shows a held chip beside Send; this box has none, and the
      // text vanishing from it would read as lost.
      if (held) showToast(heldNotice());
      return held;
    },
    onSend: (blocks) => sendToSub(subId, cwd(), blocks, heldNotice),
  });
  composer.setSessionId(subId, { readOnly: false });
  return composer;
}

/** The daemon routes a send to a sub through subchats/reply.rs's route_send,
 *  so a finished or paused one resumes the way it does from its own window.
 *  A refusal mid-turn is queued; any other failure throws so the composer puts
 *  the text and its images back. */
async function sendToSub(subId: string, cwd: string, blocks: ContentBlock[], heldNotice: () => string): Promise<void> {
  try {
    await invoke<void>("send_message", { sessionId: subId, cwd, blocks });
  } catch (err) {
    if (isSessionBusyError(err) && state.heldMessages?.stageFor(subId, blocks)) {
      showToast(heldNotice());
      return;
    }
    const blocked = apiCreditBlockedReason(err);
    if (blocked === null) console.error("[subs-card] send_message failed", err);
    showToast(blocked ?? `Send failed: ${err}`);
    throw err;
  }
}
