import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { invoke } from "../../shared/ipc";
import { ensureModalHost, modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel } from "../../shared/modal";
import { isRemote } from "../../shared/transport";
import type { ProjectGroup } from "../../types/ipc.generated";
import { openNewProjectModal, isNewProjectModalOpen } from "./new-project-modal";
import { openLocationModal } from "./location-picker";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { projectGroupsData, projectStatData, cachedProjectStat } from "./new-session-cache";
import { api, type ProjectConfig } from "../../shared/api";
import {
  renderMachineFieldHtml,
  attachMachineFieldHandlers,
  type MachineFieldState,
} from "./machine-field";

export type SortChoice = "name" | "recent" | "todos";
export const SORT_STORAGE_KEY = "claude_companion_sessions_modal_sort";
export const SHOW_TODOS_STORAGE_KEY = "claude_companion_sessions_modal_show_todos";

const SORT_LABELS: Record<SortChoice, string> = {
  name: "Name (A-Z)",
  recent: "Most recent",
  todos: "Most todos",
};

export function readStoredSort(): SortChoice {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === "name" || v === "recent" || v === "todos") return v;
  } catch { /* localStorage may throw in private mode; ignore */ }
  return "name";
}

export function writeStoredSort(choice: SortChoice): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, choice); }
  catch { /* ignore */ }
}

export function readShowTodos(): boolean {
  try {
    const v = localStorage.getItem(SHOW_TODOS_STORAGE_KEY);
    return v !== "false";
  } catch { return true; }
}

export function writeShowTodos(show: boolean): void {
  try { localStorage.setItem(SHOW_TODOS_STORAGE_KEY, String(show)); }
  catch { /* ignore */ }
}

/** Kicks the per-project stat (last-activity + todo count) revalidation once
 *  per project - called after the list is known, never from a render path
 *  (computeRows/row markup read the cache synchronously via
 *  cachedProjectStat() instead, or every keystroke would refire fetches). */
function warmProjectStats(projects: ProjectGroup[], onSettle: () => void): void {
  for (const p of projects) {
    void projectStatData(p.path).ready.then(onSettle).catch(() => {});
  }
}

/** The picker's resolved value. `machineId` is null/undefined for the local
 * machine (the overwhelmingly common case) - only set when the dev picked a
 * peer machine's chip (multi-machine federation, H4). */
export interface PickedProject {
  path: string;
  name: string;
  machineId?: string | null;
}

export async function pickProject(): Promise<PickedProject | null> {
  const { cached, ready } = projectGroupsData();
  return openProjectPickerModal(cached, ready);
}

/** Maps a peer machine's bare `ProjectConfig` (no avatar/todo/worktree data -
 * that's all local-only enrichment) into the row shape the picker already
 * renders. `avatar` deliberately isn't {kind:"none"}: that renders a
 * hydratable `.proj-face` placeholder, and hydrateProjectTechIcons would then
 * probe THIS machine's filesystem for a path that only exists on the peer. */
function projectConfigToGroup(pc: ProjectConfig): ProjectGroup {
  const path = String(pc.path);
  const rawName = (pc as { name?: unknown }).name;
  const name = typeof rawName === "string" && rawName
    ? rawName
    : path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
  return {
    id: pc.id, path, name,
    parent_segment: null,
    avatar: { kind: "emoji", value: "📁" },
    automation_enabled: false,
    tokens_7d: 0n,
    live: 0,
    any_remote: false,
    any_automated: false,
    last_active_at: null,
    path_exists: true, // can't stat a peer's filesystem from here
    worktrees: [],
    last_worktree_path: null,
    last_start_folder_rel: null,
  };
}

export function openProjectPickerModal(
  cachedProjects: ProjectGroup[] | undefined,
  projectsReady: Promise<ProjectGroup[]>,
): Promise<PickedProject | null> {
  return new Promise((resolve) => {
    const host = ensureModalHost();
    const slot = modalCardSlot();
    let resolved = false;
    const finish = (val: PickedProject | null) => {
      if (resolved) return;
      resolved = true;
      closeHostCard();
      resolve(val);
    };

    // undefined = still loading (cold cache; renderModal() shows a spinner
    // shell instead of the list until this resolves). Always the LOCAL
    // machine's list - a machine switch (below) never touches this.
    let localProjects: ProjectGroup[] | undefined = cachedProjects;

    // ── Machine picker (multi-machine federation, H4) ───────────────────────
    // In-memory only for this one modal open, per the dev's call - no
    // persistence of the last-picked machine.
    const machineField: MachineFieldState = { machineId: null };
    let selfMachine: import("../../shared/api").SelfMachine | null = null;
    let peerMachines: import("../../shared/api").PeerMachineView[] = [];
    let remoteProjects: ProjectGroup[] | undefined;
    let remoteProjectsLoading = false;
    let remoteProjectsError: string | null = null;

    const currentProjects = (): ProjectGroup[] | undefined =>
      machineField.machineId === null ? localProjects : remoteProjects;

    const pickMachine = (machineId: string | null): void => {
      if (machineId === null) {
        renderModal();
        return;
      }
      remoteProjects = undefined;
      remoteProjectsLoading = true;
      remoteProjectsError = null;
      selectedIdx = 0;
      renderModal();
      void api.listMachineProjects(machineId).then((list) => {
        if (resolved || machineField.machineId !== machineId) return;
        remoteProjects = list.map(projectConfigToGroup);
        remoteProjectsLoading = false;
        renderModal();
      }).catch((err: unknown) => {
        if (resolved || machineField.machineId !== machineId) return;
        console.error("[sessions] list_machine_projects failed", err);
        remoteProjectsError = err instanceof Error ? err.message : "Failed to load projects";
        remoteProjectsLoading = false;
        renderModal();
      });
    };

    // Desktop only (H4); a phone caller degrades with RemoteUnavailableError,
    // caught here so the picker just never grows the chip row.
    if (!isRemote()) {
      void api.listMachines().then((res) => {
        if (resolved) return;
        selfMachine = res.self;
        peerMachines = res.peers;
        if (peerMachines.length > 0) renderModal();
      }).catch(() => { /* machine federation unavailable - no chip row, same as zero peers */ });
    }

    let sort: SortChoice = readStoredSort();
    let showTodos: boolean = readShowTodos();
    let optionsOpen = false;
    let filter = "";
    // Keyboard-navigable highlight. Always points at a row in the current
    // filtered/sorted `computeRows()` output. Reset to 0 whenever filter or
    // sort changes (top of the new list).
    let selectedIdx = 0;

    // 0 = exact name, 1 = name starts with, 2 = name contains, 3 = path only
    const matchRank = (p: ProjectGroup, f: string): number => {
      const n = p.name.toLowerCase();
      if (n === f) return 0;
      if (n.startsWith(f)) return 1;
      if (n.includes(f)) return 2;
      return 3;
    };

    // Only ever called once `localProjects` is populated - the search input
    // (the only thing that can trigger computeRows()) doesn't exist in the DOM
    // during the loading-shell render below. Empty while a machine switch's
    // list_machine_projects fetch is still in flight (or failed) - the rows
    // section renders its own loading/error line instead in that case.
    const computeRows = (): ProjectGroup[] => {
      const list = currentProjects();
      if (!list) return [];
      const f = filter.trim().toLowerCase();
      let rows = list.filter((p) =>
        !f
        || p.name.toLowerCase().includes(f)
        || p.path.toLowerCase().includes(f)
      );
      if (sort === "name") {
        rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      } else if (sort === "todos") {
        rows = rows.slice().sort((a, b) => {
          const ac = cachedProjectStat(a.path)?.todoCount ?? 0;
          const bc = cachedProjectStat(b.path)?.todoCount ?? 0;
          return bc - ac; // descending: most todos first
        });
      } else {
        // "recent": items with no cached mtime yet (or genuinely 0) sort last.
        rows = rows.slice().sort((a, b) => {
          const am = cachedProjectStat(a.path)?.mtime ?? 0;
          const bm = cachedProjectStat(b.path)?.mtime ?? 0;
          return bm - am;
        });
      }
      // When a filter is active, promote closer name matches to the top.
      if (f) {
        rows = rows.slice().sort((a, b) => matchRank(a, f) - matchRank(b, f));
      }
      return rows;
    };

    // Opens the location picker (worktree + CLAUDE.md start-folder, see
    // location-picker.ts) for every project - it decides on its own whether
    // there's anything to show or whether it can resolve instantly, same as
    // the old direct worktree-picker branch used to. Mirrors the "New
    // project…" footer flow: hide the host, await the sub-modal, then finish
    // on a result or restore + re-render on cancel.
    const selectProjectRow = async (p: ProjectGroup): Promise<void> => {
      if (p.path_exists === false) return;
      if (machineField.machineId !== null) {
        // A peer machine's project has no worktree/CLAUDE.md-scope data
        // (list_machine_projects returns a bare ProjectConfig) - resolve
        // directly instead of opening the location sub-modal.
        finish({ path: p.path, name: p.name, machineId: machineField.machineId });
        return;
      }
      const result = await openLocationModal(p);
      if (!result) {
        setBackdropCancel(() => finish(null));
        await presentHostCard(renderModal);
        return;
      }
      finish({ ...result, machineId: null });
    };

    const renderModal = () => {
      if (!localProjects) {
        render(
          html`<div class="modal-card modal-card-loading" role="dialog" aria-modal="true" aria-label="Pick project">
            <i class="ph ph-circle-notch" aria-hidden="true"></i> Loading projects&hellip;
          </div>`,
          slot,
        );
        return;
      }
      const rows = computeRows();
      const tpl = html`
        <div
          class="modal-card project-picker-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Pick project"
        >
          <header class="modal-header">
            <h3>Pick project</h3>
            <div class="project-picker-options-wrap">
              <button
                class="project-picker-options-btn${optionsOpen ? " active" : ""}"
                title="Sort &amp; display options"
                @click=${(e: Event) => { e.stopPropagation(); optionsOpen = !optionsOpen; renderModal(); }}
              ><i class="ph ph-sliders-horizontal"></i></button>
              ${optionsOpen ? html`
                <div class="project-picker-options-overlay" @click=${() => { optionsOpen = false; renderModal(); }}></div>
                <div class="project-picker-options-panel">
                  <div class="options-section-label">Sort</div>
                  ${(["name", "recent", "todos"] as SortChoice[]).map(v => html`
                    <label class="options-radio">
                      <input type="radio" name="pp-sort" .checked=${sort === v} @change=${() => { sort = v; writeStoredSort(v); selectedIdx = 0; renderModal(); }}>
                      ${SORT_LABELS[v]}
                    </label>
                  `)}
                  <div class="options-divider"></div>
                  <label class="options-toggle">
                    <input type="checkbox" .checked=${showTodos} @change=${(e: Event) => { showTodos = (e.target as HTMLInputElement).checked; writeShowTodos(showTodos); renderModal(); }}>
                    Show todos counter
                  </label>
                </div>
              ` : ""}
            </div>
          </header>
          <div class="modal-body project-picker-body">
            ${unsafeHTML(renderMachineFieldHtml(machineField, { self: selfMachine, peers: peerMachines }))}
            <input
              id="project-picker-search"
              class="project-picker-search"
              type="text"
              autocomplete="off"
              placeholder="Search projects..."
              .value=${filter}
              @input=${(e: Event) => {
                filter = (e.target as HTMLInputElement).value;
                selectedIdx = 0;
                renderModal();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  if (filter !== "") {
                    e.preventDefault();
                    e.stopPropagation();
                    filter = "";
                    selectedIdx = 0;
                    renderModal();
                  } else {
                    finish(null);
                  }
                } else if (e.key === "Enter") {
                  const matches = computeRows();
                  if (matches.length > 0) {
                    e.preventDefault();
                    const idx = Math.min(selectedIdx, matches.length - 1);
                    const m = matches[idx]!;
                    if (m.path_exists !== false) void selectProjectRow(m);
                  }
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.min(selectedIdx + 1, matches.length - 1);
                    renderModal();
                  }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.max(selectedIdx - 1, 0);
                    renderModal();
                  }
                } else if (e.key === "Home") {
                  e.preventDefault();
                  selectedIdx = 0;
                  renderModal();
                } else if (e.key === "End") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = matches.length - 1;
                    renderModal();
                  }
                }
              }}
            />
            <ul class="project-picker-list">
              ${(() => {
                if (machineField.machineId !== null && remoteProjectsLoading) {
                  return html`<li class="project-picker-empty"><i class="ph ph-circle-notch"></i> Loading&hellip;</li>`;
                }
                if (machineField.machineId !== null && remoteProjectsError) {
                  return html`<li class="project-picker-empty project-picker-error">${remoteProjectsError}</li>`;
                }
                if (rows.length === 0) return html`<li class="project-picker-empty">No matches</li>`;
                return rows.map((p, i) => {
                  const todoCount = cachedProjectStat(p.path)?.todoCount ?? 0;
                  const missing = p.path_exists === false;
                  return html`
                      <li
                        class="project-picker-row ${i === Math.min(selectedIdx, rows.length - 1) ? "selected" : ""} ${missing ? "project-picker-row--missing" : ""}"
                        data-row-idx=${i}
                        style="position:relative"
                        @mouseenter=${() => {
                          if (selectedIdx !== i) {
                            selectedIdx = i;
                            renderModal();
                          }
                        }}
                        @click=${() => void selectProjectRow(p)}
                      >
                        <div class="project-picker-avatar">${unsafeHTML(renderAvatar(p.avatar, p.path))}</div>
                        <div class="project-picker-info">
                          <span class="project-picker-name">${p.name}</span>
                          <span class="project-picker-path">${p.path}</span>
                          ${missing ? html`<span class="project-picker-missing-msg">This folder doesn't exist</span>` : ""}
                        </div>
                        ${p.worktrees && p.worktrees.length > 0 ? html`<span class="project-picker-wt-badge"><i class="ph ph-git-branch"></i> ${p.worktrees.length}</span>` : ""}
                        ${showTodos && todoCount > 0 ? html`<span class="project-picker-todo-badge">${todoCount}</span>` : ""}
                      </li>
                    `;
                });
              })()}
            </ul>
          </div>
          <footer class="modal-footer">
            ${isRemote() || machineField.machineId !== null ? "" : html`
            <button
              class="btn btn-secondary btn-new-folder"
              @click=${async () => {
                if (isNewProjectModalOpen()) return;
                host.classList.remove("open");
                const result = await openNewProjectModal();
                if (!result) {
                  host.classList.add("open");
                  renderModal();
                  return;
                }
                finish({ ...result, machineId: null });
              }}
            >
              <i class="ph ph-folder-plus"></i> New project&hellip;
            </button>
            <button
              class="btn btn-secondary btn-new-folder"
              @click=${async () => {
                const picked = await invoke<string | null>("pick_folder");
                if (!picked) return;
                const name = picked.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? picked;
                finish({ path: picked, name, machineId: null });
              }}
            >
              <i class="ph ph-folder-open"></i> Open in new folder&hellip;
            </button>
            `}
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
          </footer>
        </div>
      `;
      render(tpl, slot);
      attachMachineFieldHandlers(host, machineField, pickMachine);
      hydrateProjectTechIcons(host).catch(() => {});
      hydrateCharacterAvatars(host).catch(() => {});
      // Autofocus the search input on first render. Re-focus on subsequent
      // renders only if focus was already inside the modal (avoid stealing
      // focus from the dropdown).
      const input = host.querySelector<HTMLInputElement>("#project-picker-search");
      const active = document.activeElement;
      const focusIsInsideModal = active instanceof HTMLElement && host.contains(active);
      if (input && !focusIsInsideModal) {
        // Defer to next tick so lit-html finishes attaching DOM.
        setTimeout(() => input.focus(), 0);
      }
      // Keep the selected row visible when keyboard nav scrolls past the
      // viewport edge. block: "nearest" avoids unnecessary jumps when the
      // row is already fully visible.
      const selectedEl = host.querySelector<HTMLElement>(".project-picker-row.selected");
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    };

    // Applies a resolved (or revalidated) project list: paints it and kicks
    // per-project stat revalidation. Morphs (presentHostCard) only when
    // replacing the loading shell; a later revalidation just patches in
    // place, same as a sort/filter change.
    const applyGroups = (groups: ProjectGroup[]): void => {
      if (resolved) return;
      const wasLoading = !localProjects;
      localProjects = groups;
      if (wasLoading) void presentHostCard(renderModal);
      else renderModal();
      warmProjectStats(groups, () => { if (!resolved) renderModal(); });
    };

    if (localProjects) warmProjectStats(localProjects, () => { if (!resolved) renderModal(); });

    setBackdropCancel(() => finish(null));
    void presentHostCard(renderModal);

    // Cold cache: localProjects is undefined and the shell above shows a
    // spinner until this resolves. Warm cache: this still runs, silently
    // revalidating the list (and stats) in the background per the
    // stale-while-revalidate policy - a project added/removed elsewhere shows
    // up on next render.
    void projectsReady.then((groups) => {
      if (!groups.length) {
        if (!localProjects) {
          alert("No projects detected yet. Run claude in a folder first or add a project.");
          finish(null);
        }
        return;
      }
      applyGroups(groups);
    }).catch((err) => {
      console.error("[sessions] list_project_groups failed", err);
      if (!localProjects) {
        alert("No projects detected yet. Run claude in a folder first or add a project.");
        finish(null);
      }
    });
  });
}
