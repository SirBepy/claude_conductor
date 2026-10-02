// Adding a project, inline in the empty-results state (Joe's variant C,
// 2026-09-26). Replaces the old "New project…" / "Open in new folder…"
// footer pair: both said "folder" and one said "new" while the other meant
// "existing", so neither label distinguished them. Typing a name that
// matches nothing now offers both, with the name already filled in.
//
// The projects root shown in the Create row uses wording L2 - the path
// itself is the control on desktop, so there is no label to word
// ambiguously.
//
// Split out of project-picker.ts (todo 985) once the view file passed ~300
// lines again. project-picker.ts is the only caller; it owns `localProjects`,
// `finish` and the machine-picker state this closes over, passed in via
// `deps`. `AddProjectResult` is kept structural (not imported from
// project-picker.ts) to avoid a circular import for one type.

import { html, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { updateSettings } from "../../../shared/settings-update";
import { isRemote } from "../../../shared/transport";
import type { ProjectGroup } from "../../../types/ipc.generated";
import {
  PROJECTS_ROOT_SETTINGS_KEY,
  resolveProjectsRoot,
  joinProjectPath,
  isValidProjectName,
} from "../projects-root";

export type AddProjectResult = { path: string; name: string; machineId?: string | null } | null;

/** Stored projects root. project-picker.ts seeds this from the `get_settings`
 *  fetch on open (upgrading the inferred answer once it resolves); Create
 *  and the repoint control here write it back - a plain mutable object
 *  (not a reassigned `let`) so both sides see the same value without
 *  threading a setter through. */
export interface AddProjectState {
  projectsRootStored: string | null;
}

export interface AddProjectDeps {
  getLocalProjects: () => ProjectGroup[] | undefined;
  finish: (val: AddProjectResult) => void;
  isMachineActive: () => boolean;
  renderModal: () => void;
}

/** Root shown in the Create row: explicit setting, else inferred from where
 *  the existing projects already live. Null means neither, in which case
 *  Create asks for a parent first instead of guessing. */
function projectsRoot(state: AddProjectState, deps: AddProjectDeps): string | null {
  return resolveProjectsRoot(state.projectsRootStored, (deps.getLocalProjects() ?? []).map((p) => p.path));
}

export async function repointProjectsRoot(state: AddProjectState, deps: AddProjectDeps): Promise<void> {
  const picked = await invoke<string | null>("pick_folder");
  if (!picked) return;
  state.projectsRootStored = picked;
  try {
    await updateSettings((cur) => ({ ...cur, [PROJECTS_ROOT_SETTINGS_KEY]: picked }));
  } catch (e) {
    console.error("[project-picker] failed to persist the projects root", e);
  }
  deps.renderModal();
}

export async function createProject(name: string, state: AddProjectState, deps: AddProjectDeps): Promise<void> {
  const trimmed = name.trim();
  if (isRemote()) {
    // No native folder-picker dialog on the phone (pick_folder is
    // Tauri-only), so the daemon resolves the root server-side instead
    // (todo 1058) - renderNoMatches already disables this row until a
    // root is resolvable, so this is never reached with none.
    let result: { path: string };
    try {
      result = await invoke<{ path: string }>("create_project_folder", { name: trimmed });
    } catch (e) {
      alert(`Could not create folder: ${e}`);
      return;
    }
    deps.finish({ path: result.path, name: trimmed, machineId: null });
    return;
  }
  let root = projectsRoot(state, deps);
  if (!root) {
    // No stored root and nothing to infer from - a first run. Ask for the
    // parent rather than inventing one, then remember it.
    const picked = await invoke<string | null>("pick_folder");
    if (!picked) return;
    state.projectsRootStored = picked;
    root = picked;
  }
  const fullPath = joinProjectPath(root, trimmed);
  try {
    await invoke("create_folder", { path: fullPath });
  } catch (e) {
    alert(`Could not create folder: ${e}`);
    return;
  }
  try {
    await updateSettings((cur) => ({ ...cur, [PROJECTS_ROOT_SETTINGS_KEY]: root }));
  } catch { /* the folder exists either way; remembering is best-effort */ }
  deps.finish({ path: fullPath, name: trimmed, machineId: null });
}

export async function browseForProject(deps: AddProjectDeps): Promise<void> {
  const picked = await invoke<string | null>("pick_folder");
  if (!picked) return;
  const name = picked.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? picked;
  deps.finish({ path: picked, name, machineId: null });
}

// The empty-results state carries both add-a-project routes, with the typed
// term already filled into Create. A search that matches nothing is exactly
// the moment "this project isn't here yet" becomes true, so the offer lands
// there instead of in two permanent footer buttons.
export function renderNoMatches(filter: string, state: AddProjectState, deps: AddProjectDeps): TemplateResult {
  const typed = filter.trim();
  if (deps.isMachineActive()) {
    return html`<li class="project-picker-empty">No matches</li>`;
  }
  const validName = isValidProjectName(typed);
  // The phone has no native folder-picker (pick_folder is Tauri-only), so
  // Browse never renders remotely, and Create needs a server-resolvable
  // root before it can do anything - with neither, an invalid/empty typed
  // term leaves nothing actionable to offer (todo 1058).
  if (isRemote() && !validName) {
    return html`<li class="project-picker-empty">No matches</li>`;
  }
  const root = projectsRoot(state, deps);
  const remoteNoRoot = isRemote() && !root;
  const canCreate = validName && !remoteNoRoot;
  return html`
    <li class="pp-inline-actions">
      ${validName ? html`
        <div class="pp-act${canCreate ? "" : " pp-act-disabled"}" role="button"
          tabindex=${canCreate ? "0" : "-1"}
          aria-disabled=${canCreate ? "false" : "true"}
          @click=${() => { if (canCreate) void createProject(typed, state, deps); }}
          @keydown=${(e: KeyboardEvent) => {
            if (!canCreate) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void createProject(typed, state, deps); }
          }}
        >
          <i class="ph ph-folder-plus pp-lead"></i>
          <span class="pp-body">
            <b>Create "${typed}"</b><br>
            ${remoteNoRoot
              ? html`<em>Set a projects root on the desktop first</em>`
              : root
                // The path IS the control on desktop (wording L2): nothing
                // to label, so nothing to word ambiguously. It is a real
                // <button>, which is why the row above is a role="button"
                // div - a button inside a button gets ejected out by the
                // HTML parser. The phone can't repoint it (no folder
                // dialog), so it's plain text there instead.
                ? html`<em>in </em>${isRemote()
                    ? html`<span class="pp-root-inline">${root}</span>`
                    : html`<button class="pp-root-inline" title="Change where new projects are created"
                        @click=${(e: Event) => { e.stopPropagation(); void repointProjectsRoot(state, deps); }}
                      >${root} <i class="ph ph-pencil-simple"></i></button>`}`
                : html`<em>pick where to put it&hellip;</em>`}
          </span>
        </div>
      ` : ""}
      ${isRemote() ? "" : html`
        <button class="pp-act" @click=${() => void browseForProject(deps)}>
          <i class="ph ph-folder-open pp-lead"></i>
          <span class="pp-body"><b>Browse for a folder&hellip;</b><br><em>pick one that already exists on disk</em></span>
        </button>
      `}
      ${validName ? "" : html`<span class="pp-inline-hint">No matches. Type a folder name to create one.</span>`}
    </li>
  `;
}
