import { html, render } from "lit-html";
import "./sessions-list.css";
import { formatMillions, totalTok } from "../../../../shared/tokens";
import { timeAgo } from "../../../../shared/time";
import type { TokenRecord } from "../../../../shared/tokens";
import { getProjectDetailState, getSettings, getTokenHistory } from "../../../../shared/state";
import { backFromSubview, openSessionDetail } from "../../../../shared/navigation";
import { projectSubviewHeaderData, subviewHeaderTemplate, hydrateSubviewHeader } from "../../subview-header";
import type { Avatar } from "../../subview-header";

export function renderAllSessionsList(cwd: string): void {
  const list = document.getElementById("all-sessions-list");
  const history = getTokenHistory();
  if (!list || !history) return;
  const aliases = getSettings().projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  const allCwds = new Set([cwd, ...mergedPaths]);
  const records = history.filter((r) => r.cwd && allCwds.has(r.cwd) && totalTok(r) > 0);
  if (!records.length) {
    list.innerHTML = `<div class="v-empty"><i class="ph ph-chat-circle v-empty-icon"></i><div class="v-empty-title">No sessions</div></div>`;
    return;
  }
  const sorted = [...records].sort((a, b) =>
    (((a as { date?: string }).date ?? "") < ((b as { date?: string }).date ?? "") ? 1 : -1),
  );
  const rowsHTML = sorted.map((r, i) => {
    const rec = r as TokenRecord & { sessionId?: string; lastActiveAt?: string; recordedAt?: string };
    const when = timeAgo(rec.lastActiveAt || rec.recordedAt || rec.date);
    const name = (rec.sessionId || "").slice(0, 8) || "—";
    const tok = formatMillions(totalTok(r));
    return `<tr class="session-row v-row v-focusable" data-session-idx="${i}" role="button" tabindex="0" style="cursor:pointer">
      <td class="col-when">${when}</td>
      <td class="col-tokens">${tok}</td>
      <td class="col-name">${name}</td>
    </tr>`;
  }).join("");
  list.innerHTML = `<table class="session-table"><thead><tr>
    <th>when</th><th>tokens</th><th>session</th>
  </tr></thead><tbody>${rowsHTML}</tbody></table>`;
  list.querySelectorAll<HTMLTableRowElement>(".session-row").forEach((el) => {
    const open = () => {
      const idx = Number(el.dataset.sessionIdx);
      openSessionDetail(sorted[idx], "project-sessions");
    };
    el.onclick = open;
    el.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
  });
}

(window as unknown as { renderAllSessionsList?: (cwd: string) => void }).renderAllSessionsList =
  renderAllSessionsList;

export async function renderSessionsListView(
  root: HTMLElement,
): Promise<() => void> {
  const { avatar, title, cwd: headerCwd } = projectSubviewHeaderData();
  render(template(avatar, title, headerCwd), root);
  void hydrateSubviewHeader(root);

  const cwd = getProjectDetailState().cwd;
  if (cwd) {
    try {
      renderAllSessionsList(cwd);
    } catch (e) {
      console.error("[sessions-list] render failed", e);
    }
  }

  return () => { /* no teardown */ };
}

function template(avatar: Avatar, title: string, projectPath?: string) {
  return html`
    <div class="view view-project-sessions">
      <div class="view-header subview-header">
        ${subviewHeaderTemplate(avatar, title, () => backFromSubview(), projectPath)}
      </div>
      <div class="view-body">
        <div class="section" style="margin-top:12px">
          <div class="section-title">All sessions</div>
          <div id="all-sessions-list"></div>
        </div>
      </div>
    </div>
  `;
}
