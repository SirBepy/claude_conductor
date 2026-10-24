import { html, render } from "lit-html";
import "./folder-mapping.css";
import { getSettings, getTokenHistory } from "../../../../shared/state";
import { projectLabel } from "../../../../shared/projects";
import { doRepoint, doUnmerge, resolveMergeChain } from "../../../../shared/merges";
import { showMergeModal } from "../../../../shared/navigation";
import { saveSettings } from "../../../../shared/settings-save";
import { api } from "../../../../shared/api";

export interface FolderMappingHooks {
  /** The project now lives at another folder; the popup closes. */
  onRepointed(newCwd: string): void;
  /** The project was hidden from the project lists; the popup closes. */
  onHidden(): void;
}

function doHideProject(cwd: string): void {
  const settings = getSettings();
  if (!settings.projectBlacklist) settings.projectBlacklist = [];
  const aliases = settings.projectAliases || {};
  const resolved = resolveMergeChain(cwd, aliases);
  if (!settings.projectBlacklist.includes(resolved)) {
    settings.projectBlacklist.push(resolved);
  }
  saveSettings();
}

function renderMergedPathsSection(root: HTMLElement, cwd: string): void {
  const el = root.querySelector<HTMLElement>("#project-merged-paths");
  if (!el) return;
  const aliases = getSettings().projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  if (!mergedPaths.length) { el.innerHTML = ""; return; }
  const rows = mergedPaths.map((p) => `
    <div class="merged-path-row">
      <span class="merged-path-text" title="${p}">${p}</span>
      <button class="btn-secondary unmerge-btn" data-path="${p}" style="padding:2px 8px;font-size: var(--fs-micro);flex-shrink:0">Unmerge</button>
    </div>`).join("");
  el.innerHTML = `<div class="section" style="padding:8px 0;margin-top:0">
    <div class="section-title" style="font-size: var(--fs-micro);margin-bottom:6px">Merged Paths</div>
    ${rows}
  </div>`;
  el.querySelectorAll<HTMLButtonElement>(".unmerge-btn").forEach((btn) => {
    btn.onclick = () => {
      const path = btn.dataset.path;
      if (!path) return;
      doUnmerge(aliases, path, cwd);
      saveSettings();
      renderMergedPathsSection(root, cwd);
    };
  });
}

function wireFolderMapping(root: HTMLElement, cwd: string, hooks: FolderMappingHooks): void {
  const pathEl = root.querySelector<HTMLElement>("#projectDetailPath");
  const pathInput = root.querySelector<HTMLInputElement>("#projectDetailPathInput");
  const pathError = root.querySelector<HTMLElement>("#projectDetailPathError");
  const hideBtn = root.querySelector<HTMLButtonElement>("#hideProjectBtn");

  if (pathEl) {
    pathEl.textContent = cwd || "";
    pathEl.style.display = "";
  }
  if (pathInput) pathInput.style.display = "none";
  if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }

  if (pathEl && pathInput) {
    const enterRepointMode = () => {
      pathInput.value = cwd || "";
      pathEl.style.display = "none";
      pathInput.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
      pathInput.focus();
      pathInput.select();
    };
    pathEl.onclick = enterRepointMode;
    pathEl.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enterRepointMode();
      }
    };
    const cancelRepoint = () => {
      pathInput.style.display = "none";
      pathEl.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
    };
    const commitRepoint = async () => {
      const newCwd = pathInput.value.trim();
      if (!newCwd || newCwd === cwd) { cancelRepoint(); return; }
      const showErr = (msg: string) => {
        if (!pathError) return;
        pathError.textContent = msg;
        pathError.style.display = "block";
      };
      const settings = getSettings();
      const aliases = settings.projectAliases || {};
      const existingAlias = aliases[newCwd];
      if (existingAlias?.mergedInto) { showErr("Target is already merged into another project."); return; }
      const history = getTokenHistory();
      const targetUsed = history?.some((r) => r.cwd === newCwd);
      if (targetUsed) { showErr("Target folder is already a tracked project. Rename to merge instead."); return; }
      try {
        const existsMap = await api.checkPathsExist([newCwd]);
        if (!existsMap[newCwd]) { showErr("Folder does not exist on disk."); return; }
      } catch (e) { showErr("Could not verify folder: " + (e as Error).message); return; }
      if (!settings.projectAliases) settings.projectAliases = {};
      doRepoint(settings.projectAliases, cwd, newCwd);
      saveSettings();
      hooks.onRepointed(newCwd);
    };
    pathInput.onblur = () => {
      setTimeout(() => { if (pathInput.style.display !== "none") void commitRepoint(); }, 0);
    };
    pathInput.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); void commitRepoint(); }
      if (e.key === "Escape") { e.preventDefault(); cancelRepoint(); }
    };
  }

  if (hideBtn) {
    hideBtn.onclick = () => {
      const aliases = getSettings().projectAliases || {};
      showMergeModal(
        `Hide "${projectLabel(cwd, aliases)}" from the list? You can unhide it later in settings.`,
        () => {
          doHideProject(cwd);
          hooks.onHidden();
        },
        undefined,
        "Hide",
      );
    };
  }

  renderMergedPathsSection(root, cwd);
}

/** Fills a popup body with the project's folder: repoint it, unmerge folders
 *  merged into it, or hide it from the project lists. */
export function renderFolderMapping(root: HTMLElement, cwd: string, hooks: FolderMappingHooks): void {
  render(template(), root);
  try {
    wireFolderMapping(root, cwd, hooks);
  } catch (e) {
    console.error("[folder-mapping] wire failed", e);
  }
}

function template() {
  return html`
    <div class="view-project-folder-mapping">
      <div class="section">
        <div class="section-title">Current folder</div>
        <div id="projectDetailPath" class="v-focusable" role="button" tabindex="0" style="padding:6px 0;font-size: var(--fs-micro);color:var(--sb-muted);font-family:'Fira Code',monospace;word-break:break-all;cursor:pointer" title="Click to repoint to a different folder"></div>
        <input id="projectDetailPathInput" type="text" style="display:none;width:100%;font-size: var(--fs-micro);font-family:'Fira Code',monospace;margin:4px 0;padding:4px 6px">
        <div id="projectDetailPathError" style="display:none;font-size: var(--fs-micro);color:var(--color-danger);margin:2px 0 6px"></div>
      </div>
      <div id="project-merged-paths"></div>
      <div class="section" style="margin-top:12px">
        <button class="btn-danger" id="hideProjectBtn" style="width:100%;font-size: var(--fs-body)">Hide from list</button>
      </div>
    </div>
  `;
}
