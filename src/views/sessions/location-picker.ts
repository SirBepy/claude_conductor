import { html, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { RemoteUnavailableError } from "../../shared/http-transport";
import { modalCardSlot, presentHostCard, setBackdropCancel } from "../../shared/modal";
import { openWorktreePickerModal } from "./worktree-picker";
import type { ProjectGroup, ClaudeMdScope } from "../../types/ipc.generated";
import "./location-picker.css";

/// Replaces the direct worktree-picker call in the project picker's row
/// click for EVERY project (not just ones with worktrees): resolves a
/// worktree (reusing the existing new/existing/default sub-picker
/// unchanged) plus, when a project has 2+ CLAUDE.md files, which subfolder
/// the session should actually open in. Shows nothing and resolves
/// instantly when there's nothing to choose (no worktrees and at most one
/// CLAUDE.md) - same auto-skip principle the worktree picker already used.
export function openLocationModal(project: ProjectGroup): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const slot = modalCardSlot();
    let resolved = false;
    // Deliberately does NOT close the shared host - this picker is always
    // reached via project-picker.ts's selectProjectRow, which decides what
    // shows next (its own card on cancel, or hands off further down the
    // chain on success). Only the chain's outermost function closes it.
    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener("keydown", keydownHandler);
      resolve(val);
    };

    const resolveInitialWorktree = (): { path: string; name: string } => {
      if (project.last_worktree_path) {
        const match = project.worktrees.find((w) => w.path === project.last_worktree_path);
        if (match) return { path: match.path, name: match.name };
      }
      return { path: project.path, name: project.name };
    };

    let currentWt = resolveInitialWorktree();
    let scopes: ClaudeMdScope[] | null = null;
    let scopesError: string | null = null;
    let currentScopeRel = "";
    let scopeExpanded = false;
    let filter = "";

    const applyScopeResult = (result: ClaudeMdScope[]) => {
      scopes = result;
      const preferred = project.last_start_folder_rel;
      currentScopeRel = preferred != null && result.some((s) => s.rel_path === preferred)
        ? preferred
        : (result[0]?.rel_path ?? "");
    };

    const loadScopes = async () => {
      try {
        const result = await invoke<ClaudeMdScope[]>("list_claude_md_scopes", { worktreePath: currentWt.path });
        applyScopeResult(result);
      } catch (e) {
        // Never render a raw exception string into the UI (past incident:
        // an unwired remote command showed its message verbatim here).
        scopesError = e instanceof RemoteUnavailableError
          ? "Not available on this device."
          : "Couldn't scan for CLAUDE.md files.";
        scopes = [];
      }
    };

    const changeWorktree = async () => {
      const result = await openWorktreePickerModal(project);
      setBackdropCancel(() => finish(null));
      if (result) {
        currentWt = result;
        scopes = null;
        scopesError = null;
        scopeExpanded = false;
        filter = "";
      }
      // Morph back to location-picker's card either way (cancelled, or a new
      // worktree was picked) - both are a transition off worktree-picker's
      // card. A freshly-picked worktree still needs its scopes reloaded;
      // that re-render happens in place, no second morph.
      await presentHostCard(renderModal);
      if (result) {
        await loadScopes();
        renderModal();
      }
    };

    const toggleScopeField = () => {
      scopeExpanded = !scopeExpanded;
      filter = "";
      renderModal();
    };

    const pickScope = (sc: ClaudeMdScope) => {
      currentScopeRel = sc.rel_path;
      scopeExpanded = false;
      renderModal();
    };

    const persistAndFinish = () => {
      if (project.id) {
        void invoke("update_project", {
          id: project.id,
          patch: { last_worktree_path: currentWt.path, last_start_folder_rel: currentScopeRel },
        }).catch((e) => console.error("[location-picker] failed to persist last location", e));
      }
      const path = currentScopeRel ? `${currentWt.path}\\${currentScopeRel.replace(/\//g, "\\")}` : currentWt.path;
      finish({ path, name: currentWt.name });
    };

    // Ctrl/Cmd+Enter submits, matching the AUQ question card's shortcut -
    // guarded by the same busy/scopeExpanded condition that disables the
    // Open button itself.
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && scopes !== null && !scopeExpanded) {
        e.preventDefault();
        persistAndFinish();
      }
    };
    document.addEventListener("keydown", keydownHandler);

    const renderWorktreeField = () => {
      if (project.worktrees.length === 0) return "";
      return html`
        <div class="loc-field">
          <span class="loc-field-label">Worktree</span>
          <button class="loc-chip" @click=${() => void changeWorktree()}>
            <i class="ph ph-git-branch"></i>
            <div class="loc-chip-text">
              <span class="loc-chip-value">${currentWt.name}</span>
              <span class="loc-chip-sub">${currentWt.path}</span>
            </div>
            <i class="ph ph-pencil-simple"></i>
          </button>
        </div>
      `;
    };

    const renderScopeField = () => {
      if (scopes !== null && scopes.length <= 1 && !scopesError) return "";
      const list = scopes ?? [];
      const filtered = filter.trim()
        ? list.filter((sc) => sc.label.toLowerCase().includes(filter.trim().toLowerCase()))
        : list;
      return html`
        <div class="loc-field">
          <span class="loc-field-label">Start folder</span>
          ${scopes === null ? html`
            <div class="wt-picker-loading"><i class="ph ph-spinner-gap wt-spin"></i> Scanning for CLAUDE.md&hellip;</div>
          ` : scopesError ? html`
            <div class="wt-picker-error">${scopesError}</div>
          ` : !scopeExpanded ? html`
            <button class="loc-chip" @click=${toggleScopeField}>
              <i class="ph ph-folder-open"></i>
              <div class="loc-chip-text">
                <span class="loc-chip-value">${currentScopeRel === "" ? "Repo root" : currentScopeRel}</span>
                <span class="loc-chip-sub">${currentWt.path}${currentScopeRel ? `\\${currentScopeRel.replace(/\//g, "\\")}` : ""}</span>
              </div>
              <i class="ph ph-pencil-simple"></i>
            </button>
          ` : html`
            <input
              class="loc-search"
              type="text"
              autocomplete="off"
              placeholder="Filter folder&hellip;"
              .value=${filter}
              @input=${(e: Event) => { filter = (e.target as HTMLInputElement).value; renderModal(); }}
            />
            <ul class="wt-picker-list">
              ${filtered.map((sc) => html`
                <li class="wt-picker-row">
                  <span class="loc-check">${sc.rel_path === currentScopeRel ? html`<i class="ph ph-check"></i>` : ""}</span>
                  <i class="ph ph-folder-open loc-row-icon"></i>
                  <div class="wt-picker-row-info" @click=${() => pickScope(sc)}>
                    <span class="wt-picker-row-name">${sc.label}</span>
                  </div>
                  ${sc.nested ? html`<span class="loc-nested-tag" title="Also sits inside a parent folder's CLAUDE.md scope"><i class="ph ph-stack"></i> nested</span>` : ""}
                </li>
              `)}
            </ul>
            <button class="btn btn-secondary loc-field-cancel" @click=${toggleScopeField}>Cancel</button>
          `}
        </div>
      `;
    };

    const renderModal = () => {
      const busy = scopes === null;
      const tpl = html`
        <div class="modal-card wt-picker-modal" role="dialog" aria-modal="true" aria-label="Open ${project.name}">
          <header class="modal-header"><h3>Open ${project.name}</h3></header>
          <div class="modal-body wt-picker-body loc-fields">
            ${renderWorktreeField()}
            ${renderScopeField()}
          </div>
          <footer class="modal-footer">
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
            <button class="btn btn-primary" ?disabled=${busy || scopeExpanded} @click=${persistAndFinish}>
              <i class="ph ph-arrow-right"></i> Open
            </button>
          </footer>
        </div>
      `;
      render(tpl, slot);
    };

    // Zero worktrees is the only case where the whole modal can potentially
    // be skipped - scan first, and only show the modal if the scan turns up
    // 2+ CLAUDE.md files. With worktrees present the modal has to show
    // regardless (worktree selection always did), so load scopes lazily
    // after it's already visible, matching the existing-worktree list's own
    // lazy-load pattern.
    const start = async () => {
      setBackdropCancel(() => finish(null));
      if (project.worktrees.length === 0) {
        await loadScopes();
        if ((scopes?.length ?? 0) <= 1 && !scopesError) {
          finish({ path: currentWt.path, name: currentWt.name });
          return;
        }
        await presentHostCard(renderModal);
        return;
      }
      await presentHostCard(renderModal);
      await loadScopes();
      renderModal();
    };
    void start();
  });
}
