import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { invoke } from "../../shared/ipc";
import { updateSettings } from "../../shared/settings-update";
import { ensureModalHost, modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel } from "../../shared/modal";
import { isRemote } from "../../shared/transport";
import type { ProjectGroup } from "../../types/ipc.generated";
import { openLocationModal, resolveRememberedLocation } from "./location-picker";
import { restoreFocus } from "./restore-focus";
import {
  SLOT_COUNT,
  type FavoriteSlots,
  readFavorites,
  writeFavorites,
  assignSlot,
  moveSlot,
  clearSlot,
  slotOf,
  pathForKey,
} from "./project-favorites";
import {
  PROJECTS_ROOT_SETTINGS_KEY,
  resolveProjectsRoot,
  joinProjectPath,
  isValidProjectName,
} from "./projects-root";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { projectGroupsData, projectStatData, cachedProjectStat } from "./new-session-cache";
import { api } from "../../shared/api";
import {
  renderMachineFieldHtml,
  attachMachineFieldHandlers,
  type MachineFieldState,
} from "./machine-field";
import {
  createMachineProjectsState,
  fetchMachineProjects,
} from "./components/machine-projects";

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

export function openProjectPickerModal(
  cachedProjects: ProjectGroup[] | undefined,
  projectsReady: Promise<ProjectGroup[]>,
): Promise<PickedProject | null> {
  return new Promise((resolve) => {
    const host = ensureModalHost();
    const slot = modalCardSlot();
    // kebab-menu.ts precedent: Escape returns focus to whatever opened the
    // picker. Captured once, since a later step's own re-render can steal
    // document.activeElement before this modal ever closes.
    const trigger = document.activeElement as HTMLElement | null;
    let resolved = false;
    let onEscapeKeydown: ((e: KeyboardEvent) => void) | null = null;
    const finish = (val: PickedProject | null) => {
      if (resolved) return;
      resolved = true;
      if (onEscapeKeydown) document.removeEventListener("keydown", onEscapeKeydown);
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
    const remoteProjectsState = createMachineProjectsState();

    const currentProjects = (): ProjectGroup[] | undefined =>
      machineField.machineId === null ? localProjects : remoteProjectsState.projects;

    const pickMachine = (machineId: string | null): void => {
      if (machineId === null) {
        renderModal();
        return;
      }
      selectedIdx = 0;
      renderModal();
      fetchMachineProjects(
        remoteProjectsState,
        machineId,
        () => resolved || machineField.machineId !== machineId,
        renderModal,
      );
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

      // The projects root, if the user has ever set one explicitly. Absent,
      // projectsRoot() infers it; this read only ever upgrades the answer, so
      // the Create row is usable before it resolves.
      void invoke<Record<string, unknown>>("get_settings").then((s) => {
        if (resolved) return;
        const v = s?.[PROJECTS_ROOT_SETTINGS_KEY];
        if (typeof v === "string" && v.length > 0) {
          projectsRootStored = v;
          renderModal();
        }
      }).catch(() => { /* inference covers it */ });
    }

    let sort: SortChoice = readStoredSort();
    let showTodos: boolean = readShowTodos();
    let optionsOpen = false;
    let filter = "";

    // ── Favourite slots 1-9 (desktop only) ──────────────────────────────────
    let favorites: FavoriteSlots = readFavorites();
    let dragOverSlot: number | null = null;
    // The rail tile of the favourite row under the mouse, lit up with its key.
    let hoverFavSlot: number | null = null;

    // Stored root wins over the inference; see projects-root.ts. Read once per
    // open, refreshed when the user repoints it.
    let projectsRootStored: string | null = null;

    const persistFavorites = (next: FavoriteSlots): void => {
      favorites = next;
      writeFavorites(favorites);
      renderModal();
    };

    const projectByPath = (path: string): ProjectGroup | undefined =>
      localProjects?.find((p) => p.path.toLowerCase() === path.toLowerCase());

    /** The favourites fast path. Skips BOTH the list and the Location step and
     *  resolves the project's remembered worktree/start folder directly - that
     *  is the whole point of a number key, per Joe 2026-09-26. A slot pointing
     *  at a project that has since been removed or whose folder is gone is
     *  inert rather than an error; the tile already renders as unresolved. */
    const openFavorite = (path: string): boolean => {
      const p = projectByPath(path);
      if (!p || p.path_exists === false) return false;
      finish({ ...resolveRememberedLocation(p), machineId: null });
      return true;
    };
    // Keyboard-navigable highlight. Always points at a row in the current
    // filtered/sorted `computeRows()` output. Reset to 0 whenever filter or
    // sort changes (top of the new list).
    let selectedIdx = 0;

    // Escape closes the picker from anywhere in the card (options panel, a
    // row, nowhere in particular), not just the search box - the search
    // input's own @keydown below already owns Escape while it's focused
    // (clear-filter-first idiom), so this skips that case to avoid double
    // handling. Guarded to only act while THIS step's card is the one
    // mounted: the promise stays unresolved through the whole project ->
    // location -> worktree chain, so a stacked sub-modal's Escape must not
    // also close this one underneath it.
    onEscapeKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!slot.querySelector('[data-picker-step="project"]')) return;
      if (document.activeElement?.id === "project-picker-search") return;
      e.preventDefault();
      finish(null);
      restoreFocus(trigger);
    };
    document.addEventListener("keydown", onEscapeKeydown);

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
      // A folder that no longer exists is never pickable (selectProjectRow
      // returns early on it), so the row was pure noise - Joe, 2026-09-26,
      // looking at a dozen dead `wf_*` worktree scratch dirs. The daemon
      // already drops the unconfigured ones; what reaches here is a project
      // with real config whose folder moved, hidden rather than deleted so
      // reconnecting the drive brings it straight back.
      let rows = list.filter((p) => p.path_exists !== false).filter((p) =>
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

    // ── Add a project, inline in the empty-results state ────────────────────
    // Replaces the old "New project…" / "Open in new folder…" footer pair.
    // Both said "folder" and one said "new" while the other meant "existing",
    // so neither label distinguished them (Joe, 2026-09-26). Typing a name
    // that matches nothing now offers both, with the name already filled in.

    /** Root shown in the Create row: explicit setting, else inferred from
     *  where the existing projects already live. Null means neither, in which
     *  case Create asks for a parent first instead of guessing. */
    const projectsRoot = (): string | null =>
      resolveProjectsRoot(projectsRootStored, (localProjects ?? []).map((p) => p.path));

    const repointProjectsRoot = async (): Promise<void> => {
      const picked = await invoke<string | null>("pick_folder");
      if (!picked) return;
      projectsRootStored = picked;
      try {
        await updateSettings((cur) => ({ ...cur, [PROJECTS_ROOT_SETTINGS_KEY]: picked }));
      } catch (e) {
        console.error("[project-picker] failed to persist the projects root", e);
      }
      renderModal();
    };

    const createProject = async (name: string): Promise<void> => {
      let root = projectsRoot();
      if (!root) {
        // No stored root and nothing to infer from - a first run. Ask for the
        // parent rather than inventing one, then remember it.
        const picked = await invoke<string | null>("pick_folder");
        if (!picked) return;
        projectsRootStored = picked;
        root = picked;
      }
      const fullPath = joinProjectPath(root, name.trim());
      try {
        await invoke("create_folder", { path: fullPath });
      } catch (e) {
        alert(`Could not create folder: ${e}`);
        return;
      }
      try {
        await updateSettings((cur) => ({ ...cur, [PROJECTS_ROOT_SETTINGS_KEY]: root }));
      } catch { /* the folder exists either way; remembering is best-effort */ }
      finish({ path: fullPath, name: name.trim(), machineId: null });
    };

    const browseForProject = async (): Promise<void> => {
      const picked = await invoke<string | null>("pick_folder");
      if (!picked) return;
      const name = picked.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? picked;
      finish({ path: picked, name, machineId: null });
    };

    // The empty-results state carries both add-a-project routes, with the
    // typed term already filled into Create. A search that matches nothing is
    // exactly the moment "this project isn't here yet" becomes true, so the
    // offer lands there instead of in two permanent footer buttons.
    const renderNoMatches = () => {
      const typed = filter.trim();
      const canCreate = isValidProjectName(typed) && !isRemote() && machineField.machineId === null;
      const root = projectsRoot();
      if (isRemote() || machineField.machineId !== null) {
        return html`<li class="project-picker-empty">No matches</li>`;
      }
      return html`
        <li class="pp-inline-actions">
          ${canCreate ? html`
            <div class="pp-act" role="button" tabindex="0"
              @click=${() => void createProject(typed)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void createProject(typed); }
              }}
            >
              <i class="ph ph-folder-plus pp-lead"></i>
              <span class="pp-body">
                <b>Create "${typed}"</b><br>
                ${root
                  // The path IS the control (wording L2): nothing to label, so
                  // nothing to word ambiguously. It is a real <button>, which
                  // is why the row above is a role="button" div - a button
                  // inside a button gets ejected out by the HTML parser.
                  ? html`<em>in </em><button class="pp-root-inline" title="Change where new projects are created"
                      @click=${(e: Event) => { e.stopPropagation(); void repointProjectsRoot(); }}
                    >${root} <i class="ph ph-pencil-simple"></i></button>`
                  : html`<em>pick where to put it&hellip;</em>`}
              </span>
            </div>
          ` : ""}
          <button class="pp-act" @click=${() => void browseForProject()}>
            <i class="ph ph-folder-open pp-lead"></i>
            <span class="pp-body"><b>Browse for a folder&hellip;</b><br><em>pick one that already exists on disk</em></span>
          </button>
          ${canCreate ? "" : html`<span class="pp-inline-hint">No matches. Type a folder name to create one.</span>`}
        </li>
      `;
    };

    // ── The favourites rail (placement P4: inline in the footer) ───────────
    // Drop semantics live in project-favorites.ts; this only wires the
    // gestures to them. A tile released anywhere that is NOT another tile is
    // the remove gesture.
    //
    // Pointer events, not HTML5 drag-and-drop: Tauri's native file-drop
    // handler (on by default, and the path that drops files into the chat
    // composer) owns the Windows webview's drop target, so an in-page drag
    // never gets dragover/drop - the cursor just shows no-drop. Synthetic
    // DragEvents in the view harness passed regardless, which is how two
    // earlier fixes shipped without working.
    const startFavoriteDrag = (
      e: PointerEvent,
      payload: { kind: "row"; path: string } | { kind: "slot"; index: number },
    ): void => {
      if (e.button !== 0 || isRemote() || machineField.machineId !== null) return;
      // Stops text selection and focus theft (the search box keeps its caret);
      // the click that follows a no-move press still fires.
      e.preventDefault();
      const { pointerId, clientX: startX, clientY: startY } = e;
      let ghost: HTMLElement | null = null;

      const slotAt = (x: number, y: number): number | null => {
        const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pp-fav-slot");
        return el?.dataset.slot !== undefined ? Number(el.dataset.slot) : null;
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!ghost) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
          const path = payload.kind === "row" ? payload.path : favorites[payload.index];
          const p = path ? projectByPath(path) : undefined;
          ghost = document.createElement("div");
          ghost.className = "pp-drag-ghost";
          ghost.innerHTML = p
            ? `<span class="pp-fav-face">${renderAvatar(p.avatar, p.path)}</span>`
            : "";
          if (p) ghost.append(p.name);
          document.body.append(ghost);
          document.body.classList.add("pp-dragging");
          void hydrateProjectTechIcons(ghost);
          void hydrateCharacterAvatars(ghost);
        }
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
        const over = slotAt(ev.clientX, ev.clientY);
        if (over !== dragOverSlot) { dragOverSlot = over; renderModal(); }
      };

      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (!ghost) return;
        ghost.remove();
        document.body.classList.remove("pp-dragging");
        dragOverSlot = null;
        // A release over the row it started on would otherwise click it and
        // open that project.
        const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        if (resolved) return;
        const target = ev.type === "pointerup" ? slotAt(ev.clientX, ev.clientY) : null;
        if (target !== null) {
          persistFavorites(payload.kind === "row"
            ? assignSlot(favorites, target, payload.path)
            : moveSlot(favorites, payload.index, target));
        } else if (payload.kind === "slot" && ev.type === "pointerup") {
          persistFavorites(clearSlot(favorites, payload.index));
        } else {
          renderModal();
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };

    const renderFavoriteRail = () => {
      if (isRemote() || machineField.machineId !== null) return "";
      return html`
        <div class="pp-fav-rail" role="group" aria-label="Favourite projects, keys ctrl+1 to ctrl+9">
          ${Array.from({ length: SLOT_COUNT }, (_, i) => {
            const path = favorites[i] ?? null;
            const p = path ? projectByPath(path) : undefined;
            // A slot whose project left the registry keeps its number and goes
            // quiet rather than vanishing: silently renumbering everything
            // would repoint every key below it.
            const unresolved = path !== null && p === undefined;
            const label = p ? p.name : (path ? "(missing)" : `Empty slot ${i + 1}`);
            return html`
              <div
                class="pp-fav-slot${path === null ? " is-empty" : ""}${unresolved ? " is-unresolved" : ""}${dragOverSlot === i ? " is-target" : ""}${hoverFavSlot === i && dragOverSlot === null ? " is-hinted" : ""}"
                data-slot=${i}
                title=${p ? `${p.name} - press ctrl+${i + 1}` : (path ?? `Empty - drag a project here for ctrl+${i + 1}`)}
                aria-label=${label}
                @click=${() => { if (path) openFavorite(path); }}
                @pointerdown=${(e: PointerEvent) => {
                  if (path !== null) startFavoriteDrag(e, { kind: "slot", index: i });
                }}
              >
                <span class="pp-num">${i + 1}</span>
                ${p
                  ? html`<span class="pp-fav-face">${unsafeHTML(renderAvatar(p.avatar, p.path))}</span>`
                  : (unresolved ? html`<i class="ph ph-question pp-fav-gone"></i>` : "")}
              </div>
            `;
          })}
        </div>
      `;
    };

    const renderModal = () => {
      if (!localProjects) {
        render(
          html`<div class="modal-card modal-card-loading" data-picker-step="project" role="dialog" aria-modal="true" aria-label="Pick project">
            <i class="ph ph-circle-notch" aria-hidden="true"></i> Loading projects&hellip;
          </div>`,
          slot,
        );
        return;
      }
      const rows = computeRows();
      // A drag paints its own target; the hover hint would fight it.
      const hintSlot = document.body.classList.contains("pp-dragging") ? null : hoverFavSlot;
      const tpl = html`
        <div
          class="modal-card project-picker-modal"
          data-picker-step="project"
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
                // Favourite keys ctrl+1..ctrl+9, same modifier as the Chats
                // view's ctrl+1..ctrl+9 chat switcher. Ctrl/Cmd never types a
                // character into the search box, so this fires regardless of
                // whatever is already typed there.
                if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
                  const favPath = pathForKey(favorites, e.key);
                  if (favPath && openFavorite(favPath)) {
                    e.preventDefault();
                    return;
                  }
                }
                if (e.key === "Escape") {
                  if (filter !== "") {
                    e.preventDefault();
                    e.stopPropagation();
                    filter = "";
                    selectedIdx = 0;
                    renderModal();
                  } else {
                    finish(null);
                    restoreFocus(trigger);
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
            <ul class="project-picker-list" @mouseleave=${() => {
              if (hoverFavSlot !== null) { hoverFavSlot = null; renderModal(); }
            }}>
              ${(() => {
                if (machineField.machineId !== null && remoteProjectsState.loading) {
                  return html`<li class="project-picker-empty"><i class="ph ph-circle-notch"></i> Loading&hellip;</li>`;
                }
                if (machineField.machineId !== null && remoteProjectsState.error) {
                  return html`<li class="project-picker-empty project-picker-error">${remoteProjectsState.error}</li>`;
                }
                if (rows.length === 0) return renderNoMatches();
                return rows.map((p, i) => {
                  const todoCount = cachedProjectStat(p.path)?.todoCount ?? 0;
                  const missing = p.path_exists === false;
                  return html`
                      <li
                        class="project-picker-row ${i === Math.min(selectedIdx, rows.length - 1) ? "selected" : ""} ${missing ? "project-picker-row--missing" : ""}"
                        data-row-idx=${i}
                        style="position:relative"
                        @pointerdown=${(e: PointerEvent) => startFavoriteDrag(e, { kind: "row", path: p.path })}
                        @mouseenter=${() => {
                          const fav = slotOf(favorites, p.path);
                          const nextHover = fav >= 0 ? fav : null;
                          if (selectedIdx !== i || hoverFavSlot !== nextHover) {
                            selectedIdx = i;
                            hoverFavSlot = nextHover;
                            renderModal();
                          }
                        }}
                        @click=${() => void selectProjectRow(p)}
                      >
                        <div class="project-picker-avatar">${unsafeHTML(renderAvatar(p.avatar, p.path))}</div>
                        <div class="project-picker-info">
                          <span class="project-picker-name">${p.name}${(() => {
                            // Only marks that the row is a favourite. Which key
                            // opens it shows on hover, on the rail itself.
                            const fav = slotOf(favorites, p.path);
                            return fav >= 0
                              ? html`<span class="pp-row-fav-dot" role="img" aria-label="Favourite, ctrl+${fav + 1}"></span>`
                              : "";
                          })()}</span>
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
          <footer class="modal-footer pp-footer">
            ${renderFavoriteRail()}
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
          </footer>
        </div>
        ${hintSlot !== null ? html`<div class="pp-fav-hint">Ctrl ${hintSlot + 1}</div>` : ""}
      `;
      render(tpl, slot);
      // A sibling of the card rather than a child, because the card's
      // overflow:hidden would clip a tooltip hanging below its bottom edge.
      const hint = slot.querySelector<HTMLElement>(".pp-fav-hint");
      const hintTile = hintSlot !== null ? host.querySelector<HTMLElement>(`.pp-fav-slot[data-slot="${hintSlot}"]`) : null;
      if (hint && hintTile) {
        const r = hintTile.getBoundingClientRect();
        hint.style.left = `${r.left + r.width / 2}px`;
        hint.style.top = `${r.bottom + 6}px`;
      } else if (hint) {
        // No rail (phone, or a peer machine's list) means nothing to point at.
        hint.style.display = "none";
      }
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
