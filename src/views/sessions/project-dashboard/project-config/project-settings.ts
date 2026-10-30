import { html, render } from "lit-html";
import { renderChatDefaultsRow } from "./chat-defaults-row";
import { renderAccountRow, renderConnectorsRow, renderGamingModeRow, renderTrackerRow } from "./rows";
import "./project-settings.css";

/** Fills a popup body with the project's settings (model and effort, account,
 *  tickets, connectors, gaming mode). */
export async function renderProjectSettings(root: HTMLElement, cwd: string): Promise<void> {
  render(template(), root);
  await renderChatDefaultsRow(cwd);
  await renderAccountRow(cwd);
  await renderConnectorsRow(cwd);
  await renderGamingModeRow(cwd);
  await renderTrackerRow(cwd);
}

// A short label with the explanation on hover: the rail is 270px wide, so a
// sentence per row would stack taller than the settings themselves.
function template() {
  const toggle = (id: string) => html`<label class="switch"><input type="checkbox" id=${id}><span class="slider"></span></label>`;
  return html`
    <div class="view-project-settings">
      <div class="ps-group">
        <div class="ps-field">
          <div class="ps-label-row">
            <div class="ps-label" title="The model new chats in this project open on">Model</div>
            <button type="button" class="ps-revert" id="chatDefaultModelRevert" aria-label="Back to default"><i class="ph ph-arrow-counter-clockwise"></i></button>
          </div>
          <div id="chatDefaultModelControl"></div>
        </div>
        <div class="ps-field">
          <div class="ps-label-row">
            <div class="ps-label" title="The effort new chats in this project open on">Effort</div>
            <button type="button" class="ps-revert" id="chatDefaultEffortRevert" aria-label="Back to default"><i class="ph ph-arrow-counter-clockwise"></i></button>
          </div>
          <div id="chatDefaultEffortControl"></div>
        </div>
        <div class="ps-field">
          <div class="ps-label" title="Which Claude account new chats in this project use">Account</div>
          <span class="acc-row-control" id="projectAccountControl"></span>
        </div>
        <div class="ps-field">
          <div class="ps-label" title="Where this project's tickets live, so ticket ids in chat link to them">Tickets</div>
          <span class="acc-row-control" id="trackerControl"></span>
        </div>
      </div>
      <div class="ps-group">
        <div class="ps-line">
          <span class="ps-label" title="Use your claude.ai connectors (Google Drive etc.) in this project's chats">Connectors</span>
          ${toggle("connectorsEnabled")}
        </div>
        <div class="ps-line">
          <span class="ps-label" title="Chats and dev servers here are not parked while gaming mode is on">Run in gaming mode</span>
          ${toggle("gamingModeKeepRunning")}
        </div>
      </div>
    </div>
  `;
}
