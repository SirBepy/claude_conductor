import { html, render } from "lit-html";
import { invoke } from "../../shared/ipc";
import { modalCardSlot, presentHostCard, setBackdropCancel } from "../../shared/modal";
import { askConfirm } from "../../shared/confirm";
import type { ProjectGroup, WorktreeDetail } from "../../types/ipc.generated";

type Step = "choice" | "existing" | "new";

/// Opens the new/existing/default sub-picker for a project that has known
/// worktrees. Resolves the same shape as `pickProject()` so callers don't
/// need to branch on which picker produced the result.
export function openWorktreePickerModal(project: ProjectGroup): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const slot = modalCardSlot();
    let resolved = false;
    // Deliberately does NOT close the shared host - always reached via
    // location-picker.ts's changeWorktree, which decides what shows next.
    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    let step: Step = "choice";

    let details: WorktreeDetail[] | null = null;
    let detailsError: string | null = null;
    const selectedForCleanup = new Set<string>();
    let cleaning = false;
    let cleanupError: string | null = null;

    let newBranch = "";
    let newName = "";
    let newBase = "";
    let creating = false;
    let createError: string | null = null;

    const loadDetails = async () => {
      details = null;
      detailsError = null;
      renderModal();
      try {
        const result = await invoke<WorktreeDetail[]>("list_worktree_details", { repoPath: project.path });
        details = result;
        selectedForCleanup.clear();
        for (const d of result) {
          if (d.stale) selectedForCleanup.add(d.path);
        }
      } catch (e) {
        detailsError = String(e);
      }
      renderModal();
    };

    const goExisting = () => { step = "existing"; void loadDetails(); };

    const confirmAndCleanup = async () => {
      const targets = details?.filter((d) => selectedForCleanup.has(d.path)) ?? [];
      if (targets.length === 0) return;
      const names = targets.map((d) => `  ${d.name}`).join("\n");
      const ok = await askConfirm(
        `Remove ${targets.length} worktree${targets.length === 1 ? "" : "s"}? This deletes their working directories on disk and can't be undone.\n\n${names}`,
        { confirmLabel: "Remove", danger: true },
      );
      if (!ok) return;

      cleaning = true;
      cleanupError = null;
      renderModal();
      for (const d of targets) {
        try {
          await invoke("remove_worktree", { repoPath: project.path, worktreePath: d.path, force: false });
        } catch (e) {
          cleanupError = `Failed to remove ${d.path}: ${e}`;
          break;
        }
      }
      cleaning = false;
      await loadDetails();
    };

    const submitNew = async () => {
      const branch = newBranch.trim();
      if (!branch) return;
      creating = true;
      createError = null;
      renderModal();
      try {
        const wt = await invoke<WorktreeDetail>("create_worktree", {
          repoPath: project.path,
          branchName: branch,
          worktreeName: newName.trim() || null,
          baseBranch: newBase.trim() || null,
        });
        finish({ path: wt.path, name: wt.name });
      } catch (e) {
        createError = String(e);
        creating = false;
        renderModal();
      }
    };

    const renderChoice = () => html`
      <div class="modal-card wt-picker-modal" role="dialog" aria-modal="true" aria-label="Open ${project.name}">
        <header class="modal-header"><h3>Open ${project.name}</h3></header>
        <div class="modal-body wt-picker-body">
          <button class="wt-picker-choice" @click=${() => { step = "new"; renderModal(); }}>
            <i class="ph ph-git-fork"></i>
            <div class="wt-picker-choice-text">
              <span class="wt-picker-choice-title">New worktree</span>
              <span class="wt-picker-choice-sub">Branch off into a fresh working directory</span>
            </div>
          </button>
          <button class="wt-picker-choice" @click=${goExisting}>
            <i class="ph ph-git-branch"></i>
            <div class="wt-picker-choice-text">
              <span class="wt-picker-choice-title">Existing worktree (${project.worktrees.length})</span>
              <span class="wt-picker-choice-sub">Resume one you've already created</span>
            </div>
          </button>
          <button class="wt-picker-choice" @click=${() => finish({ path: project.path, name: project.name })}>
            <i class="ph ph-house"></i>
            <div class="wt-picker-choice-text">
              <span class="wt-picker-choice-title">Default worktree</span>
              <span class="wt-picker-choice-sub">${project.path}</span>
            </div>
          </button>
        </div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
        </footer>
      </div>
    `;

    const renderExisting = () => {
      const stale = details?.filter((d) => selectedForCleanup.has(d.path)) ?? [];
      return html`
        <div class="modal-card wt-picker-modal" role="dialog" aria-modal="true" aria-label="Existing worktrees">
          <header class="modal-header">
            <h3>Existing worktrees</h3>
          </header>
          <div class="modal-body wt-picker-body">
            ${details === null && !detailsError ? html`
              <div class="wt-picker-loading"><i class="ph ph-spinner-gap wt-spin"></i> Loading worktrees&hellip;</div>
            ` : ""}
            ${detailsError ? html`
              <div class="wt-picker-error">${detailsError}</div>
              <button class="btn btn-secondary" @click=${() => void loadDetails()}>Retry</button>
            ` : ""}
            ${details && details.length === 0 ? html`
              <div class="wt-picker-empty">No worktrees found on disk for this repo.</div>
            ` : ""}
            ${details && details.length > 0 ? html`
              <ul class="wt-picker-list">
                ${details.map((d) => html`
                  <li class="wt-picker-row ${d.stale ? "wt-picker-row--stale" : ""}">
                    ${d.stale ? html`
                      <input
                        type="checkbox"
                        class="wt-picker-row-check"
                        .checked=${selectedForCleanup.has(d.path)}
                        @click=${(e: Event) => e.stopPropagation()}
                        @change=${(e: Event) => {
                          if ((e.target as HTMLInputElement).checked) selectedForCleanup.add(d.path);
                          else selectedForCleanup.delete(d.path);
                          renderModal();
                        }}
                      />
                    ` : html`<span class="wt-picker-row-check-spacer"></span>`}
                    <div class="wt-picker-row-info" @click=${() => finish({ path: d.path, name: d.name })}>
                      <span class="wt-picker-row-name">${d.name}</span>
                      <span class="wt-picker-row-sub">
                        ${d.branch ?? "detached HEAD"}${d.last_commit_at ? html` &middot; last commit ${d.last_commit_at.slice(0, 10)}` : ""}
                      </span>
                    </div>
                    ${d.stale ? html`<span class="wt-picker-stale-tag" title=${d.stale_reason ?? "stale"}>stale</span>` : ""}
                  </li>
                `)}
              </ul>
            ` : ""}
            ${cleanupError ? html`<div class="wt-picker-error">${cleanupError}</div>` : ""}
          </div>
          <footer class="modal-footer">
            <button class="btn btn-secondary" @click=${() => { step = "choice"; renderModal(); }}>Back</button>
            <button
              class="btn btn-secondary wt-picker-cleanup-btn"
              ?disabled=${stale.length === 0 || cleaning}
              @click=${() => void confirmAndCleanup()}
            >
              ${cleaning ? html`<i class="ph ph-spinner-gap wt-spin"></i> Removing&hellip;` : html`<i class="ph ph-broom"></i> Clean up ${stale.length || ""} stale`}
            </button>
          </footer>
        </div>
      `;
    };

    const renderNew = () => html`
      <div class="modal-card wt-picker-modal" role="dialog" aria-modal="true" aria-label="New worktree">
        <header class="modal-header"><h3>New worktree</h3></header>
        <div class="modal-body wt-picker-body">
          <div class="wt-picker-field">
            <label>Branch name</label>
            <input
              type="text"
              autocomplete="off"
              placeholder="feature-x"
              .value=${newBranch}
              @input=${(e: Event) => { newBranch = (e.target as HTMLInputElement).value; }}
            />
          </div>
          <div class="wt-picker-field">
            <label>Worktree folder name <span class="wt-picker-field-optional">(optional)</span></label>
            <input
              type="text"
              autocomplete="off"
              placeholder=${newBranch.trim() || "auto from branch name"}
              .value=${newName}
              @input=${(e: Event) => { newName = (e.target as HTMLInputElement).value; }}
            />
          </div>
          <div class="wt-picker-field">
            <label>Base branch <span class="wt-picker-field-optional">(optional)</span></label>
            <input
              type="text"
              autocomplete="off"
              placeholder="current branch"
              .value=${newBase}
              @input=${(e: Event) => { newBase = (e.target as HTMLInputElement).value; }}
            />
          </div>
          ${createError ? html`<div class="wt-picker-error">${createError}</div>` : ""}
        </div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" ?disabled=${creating} @click=${() => { step = "choice"; renderModal(); }}>Back</button>
          <button class="btn btn-primary" ?disabled=${creating || !newBranch.trim()} @click=${() => void submitNew()}>
            ${creating ? html`<i class="ph ph-spinner-gap wt-spin"></i> Creating&hellip;` : html`<i class="ph ph-git-fork"></i> Create`}
          </button>
        </footer>
      </div>
    `;

    const renderModal = () => {
      const tpl = step === "existing" ? renderExisting()
        : step === "new" ? renderNew()
        : renderChoice();
      render(tpl, slot);
    };

    setBackdropCancel(() => finish(null));
    void presentHostCard(renderModal);
  });
}
