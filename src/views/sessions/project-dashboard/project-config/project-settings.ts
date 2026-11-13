import { html, nothing, render } from "lit-html";
import { renderChatDefaultsRow } from "./chat-defaults-row";
import {
  renderAccountRow, renderCompactionRow, renderConnectorsRow, renderGamingModeRow, renderTrackerRow,
} from "./rows";
import { renderMcpServersRow } from "./mcp-servers-row";
import "./project-settings.css";

/** Fills a popup body or the dashboard page's rail with the project's settings
 *  (model and effort, account, tickets, connectors, gaming mode, MCP servers, compaction). */
export async function renderProjectSettings(root: HTMLElement, cwd: string): Promise<void> {
  render(template(), root);
  await renderChatDefaultsRow(cwd);
  await renderAccountRow(cwd);
  await renderConnectorsRow(cwd);
  await renderGamingModeRow(cwd);
  await renderTrackerRow(cwd);
  await renderMcpServersRow(cwd);
  await renderCompactionRow(cwd);
}

// A short label with the explanation on hover: the rail is 270px wide, so a
// sentence per row would stack taller than the settings themselves.
function template() {
  const toggle = (id: string, label?: string) => html`<label class="switch"><input type="checkbox" id=${id} aria-label=${label ?? nothing}><span class="slider"></span></label>`;
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
          <span class="ps-label">claude.ai connectors</span>
          ${toggle("connectorsEnabled", "claude.ai connectors")}
        </div>
        <!-- Spelled out, not a tooltip: the bare name read as a heading with a stray switch. -->
        <div class="ps-hint">Google Drive and the other apps you connected on claude.ai, in this project's chats.</div>
        <div class="ps-line">
          <span class="ps-label" title="Chats and dev servers here are not parked while gaming mode is on">Run in gaming mode</span>
          ${toggle("gamingModeKeepRunning")}
        </div>
      </div>
      <div class="ps-group">
        <div class="ps-group-title" title="This project's own MCP servers (a local app's /mcp). Each is checked before a turn starts and left out if it does not answer.">MCP servers</div>
        <div class="ps-field" id="mcpServersControl"></div>
      </div>
      <div class="ps-group">
        <div class="ps-group-title" title="A main chat (Use subchats on) that is idle and past this size is summarized in place and goes on. Overrides Settings > Chat defaults for this project.">Compaction</div>
        <div class="ps-line">
          <span class="ps-label" title="Compact this project's main chats automatically">Compact automatically</span>
          ${toggle("compactOn")}
        </div>
        <div class="ps-line">
          <span class="ps-label" title="Compact once the chat holds this many thousand tokens">Compact at (K tokens)</span>
          <input type="number" id="compactK" class="inline-input" min="1" max="10000" step="1">
        </div>
      </div>
    </div>
  `;
}
