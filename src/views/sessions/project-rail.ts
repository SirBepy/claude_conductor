import { escapeHtml } from "../../shared/escape-html";
import type { Instance } from "../../types/ipc.generated";
import { getSettings } from "../../shared/state";
import { projectLabel, renderAvatar, hydrateProjectTechIcons } from "../../shared/projects";
import type { AliasMap } from "../../shared/tokens";
import { loadHiddenProjects, saveHiddenProjects } from "./sessions-helpers";

/**
 * Renders the project filter rail above the chat list: one small avatar per
 * project that currently has any live chat (any status, not just busy ones -
 * a project's icon must stay put while you toggle it off, or there'd be no
 * way to click it back on). Click an avatar to hide/show that project;
 * "All" resets. Independent from the per-session hide list.
 *
 * Stays hidden with 0-1 live projects - a filter is meaningless noise when
 * there's nothing to filter between.
 */
export function renderProjectRail(hostEl: HTMLElement, sessions: Instance[], onChange: () => void): void {
  const cwds = [...new Set(sessions.map((s) => String(s.cwd ?? "")).filter(Boolean))];
  if (cwds.length < 2) {
    hostEl.innerHTML = "";
    hostEl.hidden = true;
    return;
  }
  hostEl.hidden = false;

  const aliases: AliasMap = (getSettings().projectAliases as AliasMap) || {};
  // Never pruned against `cwds`: the set is shared by every device through the
  // daemon, and one device's live list can be partial, which would unfilter
  // those projects everywhere. So "All" reads only the projects shown here.
  const hidden = loadHiddenProjects();
  const allActive = !cwds.some((c) => hidden.has(c));
  const avatarsHtml = cwds
    .map((cwd) => {
      const alias = aliases[cwd];
      const avatarHtml = alias?.emoji
        ? `<span class="project-rail-emoji">${escapeHtml(alias.emoji)}</span>`
        : renderAvatar({ kind: "none" }, cwd);
      const label = escapeHtml(projectLabel(cwd, aliases));
      const isOff = hidden.has(cwd);
      return `<button type="button" class="project-rail-avatar${isOff ? " off" : ""}" data-cwd="${escapeHtml(cwd)}" title="${label}">${avatarHtml}</button>`;
    })
    .join("");

  hostEl.innerHTML = `
    <button type="button" class="project-rail-all${allActive ? " active" : ""}" title="Show every project" data-rail-all="1">All</button>
    <div class="project-rail-avatars">${avatarsHtml}</div>
  `;

  hostEl.querySelector('[data-rail-all="1"]')?.addEventListener("click", () => {
    // Real toggle: everything visible -> hide every project; anything hidden
    // -> show everything. A one-way "always show all" button gave no way to
    // blank the whole list from this control.
    const current = loadHiddenProjects();
    saveHiddenProjects(cwds.some((c) => current.has(c)) ? new Set() : new Set([...current, ...cwds]));
    onChange();
  });
  hostEl.querySelectorAll<HTMLButtonElement>(".project-rail-avatar").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cwd = btn.dataset.cwd;
      if (!cwd) return;
      const set = loadHiddenProjects();
      if (set.has(cwd)) set.delete(cwd);
      else set.add(cwd);
      saveHiddenProjects(set);
      onChange();
    });
  });

  void hydrateProjectTechIcons(hostEl);
}
