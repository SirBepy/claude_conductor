import { html, nothing, render } from "lit-html";
import { renderChatDefaultsRow } from "./chat-defaults-row";
import {
  renderAccountRow, renderCompactionRow, renderConnectorsRow, renderTrackerRow,
} from "./rows";
import { renderMcpServersRow } from "./mcp-servers-row";
import { renderPaymentGroupRow } from "./payment-group-row";
import "./project-settings.css";

/** Fills a popup body or the dashboard page's rail with the project's settings
 *  (model and effort, account, tickets, connectors, MCP servers, compaction). */
export async function renderProjectSettings(root: HTMLElement, cwd: string): Promise<void> {
  render(template(), root);
  await renderChatDefaultsRow(cwd);
  await renderAccountRow(cwd);
  await renderPaymentGroupRow(cwd);
  await renderConnectorsRow(cwd);
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
        <div class="ps-group-title" title="Which accounts and models this project's chats and helpers use">Payment group</div>
        <div class="ps-field">
          <div class="ps-label" title="The payment group this project takes its roles from">This project is a</div>
          <select class="inline-select" id="paymentGroupSelect" aria-label="Payment group"></select>
        </div>
        <div class="ps-field pg-rows" id="paymentGroupRows"></div>
        <div class="mp-fold on pg-empty" id="paymentGroupEmpty"><div><div class="pg-hint"></div></div></div>
        <div class="menu-anchor ps-menu-wrap">
          <button type="button" class="ps-add" id="paymentGroupAdd"><i class="ph ph-plus"></i> Change a role for this project</button>
          <div class="menu-popover hidden" id="paymentGroupMenu"></div>
        </div>
        <button type="button" class="ps-open" id="paymentGroupEdit"><span class="ps-open-text">Edit the Personal roles</span><i class="ph ph-caret-right"></i></button>
      </div>
      <div class="ps-group">
        <div class="ps-line">
          <span class="ps-label">claude.ai connectors</span>
          ${toggle("connectorsEnabled", "claude.ai connectors")}
        </div>
        <!-- Spelled out, not a tooltip: the bare name read as a heading with a stray switch. -->
        <div class="ps-hint">Google Drive and the other apps you connected on claude.ai, in this project's chats.</div>
      </div>
      <div class="ps-group">
        <div class="ps-group-title" title="This project's own MCP servers (a local app's /mcp, or a program such as Roblox Studio's mcp.bat). Each is checked before a turn starts and left out if it does not answer or is not found.">MCP servers</div>
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
