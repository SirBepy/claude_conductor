// "Turn into a project" (pc-1806 step 8): a chat started in the No project folder becomes the
// main chat of a real project. The daemon owns every rule (it forks the conversation into a
// successor in the new folder, carries the subs, cards, decisions log, Answers and previews, and
// ends this chat); this file asks for the folder, shows what moves and what stays behind, and
// shows the daemon's refusal. The chat's own folder never changes: Claude keys a transcript by
// folder, so a moved chat would lose its history.

import { html, nothing, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../shared/modal";
import { showToast } from "../../shared/toast";
import { basename } from "../../shared/path-utils";
import { movedRows, type PromotePreview, type Promoted } from "./turn-into-project-model";
import "./turn-into-project.css";

export async function openTurnIntoProject(chatId: string): Promise<void> {
  let preview: PromotePreview = { moved: { subs: 0, remote_subs: 0, cards: 0 }, forks: true, stays_behind: [] };
  try {
    preview = await invoke<PromotePreview>("promote_preview", { sessionId: chatId });
  } catch (err) {
    showToast(`Could not read what would move: ${String(err)}`);
    return;
  }
  let folder: string | null = null;
  let busy = false;
  let error = "";
  const slot = modalCardSlot();
  const close = (): void => {
    setBackdropCancel(null);
    closeHostCard();
  };

  const choose = async (): Promise<void> => {
    try {
      const picked = await invoke<string | null>("pick_folder");
      if (picked) {
        folder = picked;
        error = "";
        draw();
      }
    } catch (err) {
      error = `Could not open the folder picker: ${String(err)}`;
      draw();
    }
  };

  const go = async (): Promise<void> => {
    if (!folder || busy) return;
    busy = true;
    error = "";
    draw();
    try {
      const r = await invoke<{ ok: boolean; result: Promoted }>("promote_to_project", { sessionId: chatId, path: folder });
      close();
      showToast(`Now the project "${basename(r.result.project_path)}". This chat's work continues in its new main chat.`);
      // Imported here: sidebar.ts reaches this file through the chat menu. A failed
      // refresh is not a failed promote: the daemon's next push redraws the list.
      const { refreshSessions } = await import("./sidebar");
      await refreshSessions().catch((e) => console.error("[subchats] refresh after promote failed", e));
    } catch (err) {
      console.error("[subchats] promote_to_project failed", err);
      busy = false;
      error = err instanceof Error ? err.message : String(err);
      draw();
    }
  };

  const draw = (): void => {
    render(html`
      <div class="modal-card wt-picker-modal tip-modal" role="dialog" aria-modal="true" aria-label="Turn into a project" data-turn-into-project>
        <header class="modal-header"><h3>Turn into a project</h3></header>
        <div class="modal-body wt-picker-body tip-body">
          <p class="tip-lead">Starts a main chat in a project folder and carries this chat's work over. This chat ends here.</p>
          <div class="tip-folder">
            <span class="tip-folder-path ${folder ? "" : "is-empty"}" data-tip-path title=${folder ?? ""}>${folder ?? "No folder chosen"}</span>
            <button type="button" class="btn btn-secondary tip-choose" data-tip-choose ?disabled=${busy} @click=${() => void choose()}>
              ${folder ? "Change" : "Choose folder"}
            </button>
          </div>
          <section class="tip-group" data-tip-moves>
            <h4>Moves with it</h4>
            <ul>${movedRows(preview.moved, preview.forks).map((r) => html`<li>${r}</li>`)}</ul>
          </section>
          ${preview.stays_behind.length
            ? html`<section class="tip-group" data-tip-stays>
                <h4>Stays behind</h4>
                <ul>${preview.stays_behind.map((r) => html`<li>${r}</li>`)}</ul>
              </section>`
            : nothing}
          <p class="tip-error" data-tip-error ?hidden=${!error} role="alert">${error}</p>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn btn-secondary" data-tip-cancel ?disabled=${busy} @click=${close}>Cancel</button>
          <button type="button" class="btn btn-primary" data-tip-go ?disabled=${!folder || busy} @click=${() => void go()}>
            ${busy ? "Starting the project…" : "Turn into a project"}
          </button>
        </footer>
      </div>`, slot);
  };
  setBackdropCancel(() => { if (!busy) close(); });
  await presentHostCard(draw);
}
