// "Move into main chat": turns an ordinary chat into a sub of a main chat Joe picks.
// The reverse of "Move to sidebar" (subchat-view.ts). Lives in the chat menu, not on
// a button: it is a rare, deliberate move. The daemon owns every rule (and refuses
// what cannot be a sub); this file only offers the candidates and shows its refusal.

import { html, nothing, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../shared/modal";
import { showToast } from "../../shared/toast";
import type { Instance } from "../../types/ipc.generated";
import { isMirrored, isSubchat, sessionSubtitle } from "./sessions-helpers";
import { isSubchatsOn } from "./permission-modal/gating";
import { state } from "./state";

/** The chats `chatId` could move into: live main chats (Use subchats on), never the
 *  chat itself, a sub, an ended chat or one mirrored from a paired machine. The
 *  `former` one, when it qualifies, comes first. */
export function mainChatCandidates(
  sessions: Instance[],
  chatId: string,
  isOn: (id: string) => boolean,
  former?: string | null,
): Instance[] {
  const rows = sessions.filter(
    (s) => s.session_id !== chatId && isOn(s.session_id) && !isSubchat(s) && !s.ended_at && !s.end_reason && !isMirrored(s),
  );
  return rows.sort((a, b) => Number(b.session_id === former) - Number(a.session_id === former));
}

/** Opens the picker for `chatId`; resolves once it is closed. */
export async function openMoveIntoMain(chatId: string): Promise<void> {
  let former: string | null = null;
  try {
    former = (await invoke<string | null>("former_main_chat", { sessionId: chatId })) ?? null;
  } catch {
    // The default is a convenience; the list still works without it.
  }
  const rows = mainChatCandidates(state.sessions, chatId, isSubchatsOn, former);
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };

  const pick = async (main: Instance): Promise<void> => {
    close();
    try {
      await invoke<void>("move_chat_into_main", { sessionId: chatId, mainId: main.session_id });
    } catch (err) {
      console.error("[subchats] move_chat_into_main failed", err);
      showToast(`Could not move it into the main chat: ${err}`);
      return;
    }
    // Imported here: sidebar.ts reaches this file through the chat menu.
    const { refreshSessions } = await import("./sidebar");
    await refreshSessions();
  };

  const draw = (): void => {
    render(html`
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Move into main chat" data-move-into-main>
        <header class="modal-header"><h3>Move into main chat</h3></header>
        <div class="modal-body">
          ${rows.length
            ? html`<ul class="wt-picker-list">${rows.map((m) => html`
                <li class="wt-picker-row">
                  <div class="wt-picker-row-info" data-main-id=${m.session_id} @click=${() => void pick(m)}>
                    <span class="wt-picker-row-name">${sessionSubtitle(m)}</span>
                    ${m.session_id === former ? html`<span class="loc-nested-tag">previous</span>` : nothing}
                  </div>
                </li>`)}</ul>`
            : html`<p>No other chat has Use subchats on.</p>`}
        </div>
        <footer class="modal-footer"><button type="button" class="btn btn-secondary" @click=${close}>Cancel</button></footer>
      </div>`, slot);
  };
  setBackdropCancel(close);
  await presentHostCard(draw);
}
