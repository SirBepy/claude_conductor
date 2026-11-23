// "Move into main chat": turns an ordinary chat into a sub of its project's main chat, with no
// picker; the picker opens only when the project has no usable main chat.
// The reverse of the daemon's move_sub_to_sidebar (a sub becoming a chat). Lives in the chat menu, not on
// a button: it is a rare, deliberate move. The daemon owns every rule (and refuses
// what cannot be a sub); this file only offers the candidates and shows its refusal.

import { html, nothing, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../shared/modal";
import { showToast } from "../../shared/toast";
import type { Instance } from "../../types/ipc.generated";
import { isMirrored, isSubchat, sessionSubtitle } from "./sessions-helpers";
import { isSubchatsOn } from "./permission-modal/gating";
import { isNoProjectPath } from "../../shared/no-project";
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

/** Splits candidates into the likely targets (the previous main chat, or any main chat of the
 *  same project as the chat) and the rest. With no likely target nothing is hidden: `rest` is
 *  empty and every candidate sits in `top`. */
export function splitCandidates(
  rows: Instance[],
  chat: Instance | undefined,
  former?: string | null,
): { top: Instance[]; rest: Instance[] } {
  const likely = (s: Instance): boolean =>
    s.session_id === former || (!!chat && !!chat.project_id && s.project_id === chat.project_id);
  const top = rows.filter(likely);
  if (!top.length) return { top: rows, rest: [] };
  return { top, rest: rows.filter((s) => !likely(s)) };
}

/** The one main chat the move goes into without asking: a candidate of the chat's own
 *  project (the previous main chat first, else the newest). `null` when the chat has no
 *  project or its project has no usable main chat, which is when the picker opens. */
export function pickMainTarget(
  sessions: Instance[],
  chat: Instance | undefined,
  isOn: (id: string) => boolean,
  former?: string | null,
): Instance | null {
  if (!chat || !chat.project_id) return null;
  const same = mainChatCandidates(sessions, chat.session_id, isOn, former).filter((s) => s.project_id === chat.project_id);
  if (!same.length) return null;
  // "No project" holds a main chat per chat, so the newest is no better a guess than any other:
  // only the one this chat came from is a default there, otherwise the picker asks.
  if (isNoProjectPath(chat.cwd) && same.length > 1 && !same.some((s) => s.session_id === former)) return null;
  const newest = (s: Instance): number => Date.parse(s.started_at) || 0;
  same.sort((a, b) => Number(b.session_id === former) - Number(a.session_id === former) || newest(b) - newest(a));
  return same[0] ?? null;
}

/** Moves `chatId` into its project's main chat; with none to pick, opens the picker. */
export async function openMoveIntoMain(chatId: string): Promise<void> {
  let former: string | null = null;
  try {
    former = (await invoke<string | null>("former_main_chat", { sessionId: chatId })) ?? null;
  } catch {
    // The default is a convenience; the list still works without it.
  }
  const chat = state.sessions.find((s) => s.session_id === chatId);
  const move = async (main: Instance): Promise<void> => {
    try {
      await invoke<void>("move_chat_into_main", { sessionId: chatId, mainId: main.session_id });
    } catch (err) {
      console.error("[subchats] move_chat_into_main failed", err);
      showToast(`Could not move it into the main chat: ${err}`);
      return;
    }
    showToast(`Moved into ${sessionSubtitle(main)}`);
    // Imported here: sidebar.ts reaches this file through the chat menu.
    const { refreshSessions } = await import("./sidebar");
    await refreshSessions();
  };

  const target = pickMainTarget(state.sessions, chat, isSubchatsOn, former);
  if (target) return move(target);

  const rows = mainChatCandidates(state.sessions, chatId, isSubchatsOn, former);
  const { top, rest } = splitCandidates(rows, chat, former);
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };

  const pick = async (main: Instance): Promise<void> => {
    close();
    await move(main);
  };

  const row = (m: Instance) => html`
    <li class="wt-picker-row">
      <div class="wt-picker-row-info" data-main-id=${m.session_id} @click=${() => void pick(m)}>
        <span class="wt-picker-row-name">${sessionSubtitle(m)}</span>
        ${m.session_id === former ? html`<span class="loc-nested-tag">previous</span>` : nothing}
      </div>
    </li>`;

  const draw = (): void => {
    render(html`
      <div class="modal-card wt-picker-modal" role="dialog" aria-modal="true" aria-label="Move into main chat" data-move-into-main>
        <header class="modal-header"><h3>Move into main chat</h3></header>
        <div class="modal-body wt-picker-body">
          ${rows.length
            ? html`<ul class="wt-picker-list">${top.map(row)}</ul>
                ${rest.length
                  ? html`<details class="move-into-main-more" data-move-more>
                      <summary>Other main chats (${rest.length})</summary>
                      <ul class="wt-picker-list">${rest.map(row)}</ul>
                    </details>`
                  : nothing}`
            : html`<p>No other chat has Use subchats on.</p>`}
        </div>
        <footer class="modal-footer"><button type="button" class="btn btn-secondary" @click=${close}>Cancel</button></footer>
      </div>`, slot);
  };
  setBackdropCancel(close);
  await presentHostCard(draw);
}
