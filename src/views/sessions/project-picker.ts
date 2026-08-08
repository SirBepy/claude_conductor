import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { invoke } from "../../shared/ipc";
import { ensureModalHost, modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel } from "../../shared/modal";
import { isRemote } from "../../shared/transport";
import type { ProjectGroup } from "../../types/ipc.generated";
import { openNewProjectModal, isNewProjectModalOpen } from "./new-project-modal";
import { openLocationModal } from "./location-picker";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";

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

export async function pickProject(): Promise<{ path: string; name: string } | null> {
  let projects: ProjectGroup[] = [];
  try {
    projects = (await invoke<ProjectGroup[]>("list_project_groups")) || [];
  } catch (err) {
    console.error("[sessions] list_project_groups failed", err);
  }
  if (!projects.length) {
    alert("No projects detected yet. Run claude in a folder first or add a project.");
    return null;
  }

  // Fetch latest .jsonl mtime per project for the "Most recent" sort and
  // ai_todos counts for the "Most todos" sort. Both are best-effort.
  const [mtimes, todoCounts] = await Promise.all([
    Promise.all(
      projects.map((p) =>
        invoke<number>("project_last_activity_at", { cwd: p.path }).catch(() => 0),
      ),
    ),
    Promise.all(
      projects.map((p) =>
        invoke<number>("count_ai_todos", { cwd: p.path }).catch(() => 0),
      ),
    ),
  ]);

  return openProjectPickerModal(projects, mtimes, todoCounts);
}

export function openProjectPickerModal(
  projects: ProjectGroup[],
  mtimes: number[],
  todoCounts: number[] = [],
): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const host = ensureModalHost();
    const slot = modalCardSlot();
    let resolved = false;
    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      closeHostCard();
      resolve(val);
    };

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

    const computeRows = (): ProjectGroup[] => {
      const f = filter.trim().toLowerCase();
      let rows = projects.filter((p) =>
        !f
        || p.name.toLowerCase().includes(f)
        || p.path.toLowerCase().includes(f)
      );
      if (sort === "name") {
        rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      } else if (sort === "todos") {
        rows = rows.slice().sort((a, b) => {
          const ai = projects.indexOf(a);
          const bi = projects.indexOf(b);
          const ac = todoCounts[ai] ?? 0;
          const bc = todoCounts[bi] ?? 0;
          return bc - ac; // descending: most todos first
        });
      } else {
        // "recent": use mtimes index lookup. Items with mtime=0 sort last.
        rows = rows.slice().sort((a, b) => {
          const ai = projects.indexOf(a);
          const bi = projects.indexOf(b);
          const am = mtimes[ai] ?? 0;
          const bm = mtimes[bi] ?? 0;
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
      const result = await openLocationModal(p);
      if (!result) {
        setBackdropCancel(() => finish(null));
        await presentHostCard(renderModal);
        return;
      }
      finish(result);
    };

    const renderModal = () => {
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
              ${rows.length === 0
                ? html`<li class="project-picker-empty">No matches</li>`
                : rows.map(
                    (p, i) => {
                      const pIdx = projects.indexOf(p);
                      const todoCount = todoCounts[pIdx] ?? 0;
                      return html`
                      <li
                        class="project-picker-row ${i === Math.min(selectedIdx, rows.length - 1) ? "selected" : ""} ${p.path_exists === false ? "project-picker-row--missing" : ""}"
                        data-row-idx=${i}
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
                          ${p.path_exists === false ? html`<span class="project-picker-missing-msg">This folder doesn't exist</span>` : ""}
                        </div>
                        ${p.worktrees && p.worktrees.length > 0 ? html`<span class="project-picker-wt-badge"><i class="ph ph-git-branch"></i> ${p.worktrees.length}</span>` : ""}
                        ${showTodos && todoCount > 0 ? html`<span class="project-picker-todo-badge">${todoCount}</span>` : ""}
                      </li>
                    `;}
                  )}
            </ul>
          </div>
          <footer class="modal-footer">
            ${isRemote() ? "" : html`
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
                finish(result);
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
                finish({ path: picked, name });
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

    setBackdropCancel(() => finish(null));
    void presentHostCard(renderModal);
  });
}
