// A project's own configuration, opened from the dashboard's menus as popups
// in the shared modal host: rename, character whitelist, project settings
// (account, connectors, gaming mode, tickets, automation) and folder mapping.
import { html, render, type TemplateResult } from "lit-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { getSettings, getTokenHistory } from "../../../shared/state";
import { projectLabel } from "../../../shared/projects";
import { doMerge, resolveMergeChain } from "../../../shared/merges";
import { askConfirm } from "../../../shared/confirm";
import { saveSettings } from "../../../shared/settings-save";
import { showToast } from "../../../shared/toast";
import { api } from "../../../shared/api";
import { renderCharacterPick } from "./project-config/character-pick";
import { renderProjectSettings } from "./project-config/automation";
import { renderFolderMapping } from "./project-config/folder-mapping";

const nameOf = (cwd: string): string => projectLabel(cwd, getSettings().projectAliases || {});

/** One popup: a titled card whose body `fill` populates once it is on screen. */
function openPopup(title: string, cwd: string, fill: (body: HTMLElement, close: () => void) => void | Promise<void>): void {
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };
  setBackdropCancel(close);
  void presentHostCard(() => {
    render(html`
      <div class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label=${title}>
        <header class="modal-header"><h3>${title}<span class="pd-modal-sub">${nameOf(cwd)}</span></h3></header>
        <div class="modal-body pd-config-body"></div>
        <footer class="modal-footer"><button type="button" class="btn btn-primary" @click=${close}>Done</button></footer>
      </div>`, slot);
    const body = slot.querySelector<HTMLElement>(".pd-config-body");
    if (body) void fill(body, close);
  });
}

export function openCharacterModal(cwd: string): void {
  openPopup("Character", cwd, (body) => renderCharacterPick(body, cwd));
}

export function openProjectSettingsModal(cwd: string): void {
  openPopup("Project settings", cwd, (body) => renderProjectSettings(body, cwd));
}

export function openFolderMappingModal(cwd: string, onChanged: () => void): void {
  openPopup("Folder mapping", cwd, (body, close) => renderFolderMapping(body, cwd, {
    onRepointed: () => { close(); onChanged(); },
    onHidden: () => { close(); onChanged(); },
  }));
}

/** Every project the token history or the alias map knows, as the primary
 *  folder it resolves to: the set a new name is checked against. */
function knownProjects(): Set<string> {
  const aliases = getSettings().projectAliases || {};
  const out = new Set<string>();
  for (const r of getTokenHistory() ?? []) if (r.cwd) out.add(resolveMergeChain(r.cwd, aliases));
  for (const [c, a] of Object.entries(aliases)) if (a && !a.mergedInto) out.add(c);
  for (const p of getSettings().projects ?? []) out.add(resolveMergeChain(p.path, aliases));
  return out;
}

/** Saves `name` for the project. A name another project already has offers a
 *  merge into that project instead. Resolves true when something changed. */
export async function renameProject(cwd: string, name: string): Promise<boolean> {
  const settings = getSettings();
  if (!settings.projectAliases) settings.projectAliases = {};
  const aliases = settings.projectAliases;
  const collision = [...knownProjects()].find((c) => c !== cwd && projectLabel(c, aliases) === name);
  if (collision) {
    const ok = await askConfirm(`"${name}" already exists. Merge this project into it?`, { confirmLabel: "Merge", danger: false });
    if (!ok) return false;
    doMerge(aliases, cwd, collision);
    saveSettings();
    return true;
  }
  aliases[cwd] = { ...aliases[cwd], name };
  saveSettings();
  // The new-chat picker and the dashboard read ProjectConfig.name, not the alias map.
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  const id = configured?.id ?? (await api.ensureProject(cwd)).id;
  await api.updateProject(id, { name });
  return true;
}

export function openRenameModal(cwd: string, onChanged: () => void): void {
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };
  const submit = (e: Event): void => {
    e.preventDefault();
    const name = slot.querySelector<HTMLInputElement>(".pd-rename-input")?.value.trim() ?? "";
    close();
    if (!name || name === nameOf(cwd)) return;
    void renameProject(cwd, name).then(
      (changed) => { if (changed) onChanged(); },
      (err) => showToast(`Could not rename the project: ${String(err)}`),
    );
  };
  const card = (): TemplateResult => html`
    <form class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label="Rename project" @submit=${submit}>
      <header class="modal-header"><h3>Rename project</h3></header>
      <div class="modal-body"><input class="pd-rename-input" type="text" .value=${nameOf(cwd)} aria-label="Project name"></div>
      <footer class="modal-footer">
        <button type="button" class="btn" @click=${close}>Cancel</button>
        <button type="submit" class="btn btn-primary">Rename</button>
      </footer>
    </form>`;
  setBackdropCancel(close);
  void presentHostCard(() => {
    render(card(), slot);
    const input = slot.querySelector<HTMLInputElement>(".pd-rename-input");
    input?.focus();
    input?.select();
  });
}
