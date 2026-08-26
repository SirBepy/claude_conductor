// Settings > Accounts edit modal: rename/recolour/re-icon plus the
// projects-bound-to-this-account list, both in one place (replaces the old
// inline edit panel + chevron-expand row, 2026-07-08 UI pass). Icon/colour
// picker mirrors add-account-wizard.ts's finalize step; the projects tab
// mirrors accounts.ts's old refreshAccountProjects bind/unbind flow.

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { invoke } from "../../../../shared/ipc";
import type { ProjectConfig } from "../../../../types/ipc.generated";
import { pickProject } from "../../../sessions/project-picker";
import { registerOverlayBack } from "../../../../shared/back-button";
import { renderAppearancePicker, type AppearanceState } from "./appearance-picker";
import "./edit-account-modal.css";

type Tab = "details" | "projects";

/** Opens the edit modal for an existing account; resolves with the updated
 * `Account` on Save, or `null` on Cancel/close (project bindings changed via
 * the Projects tab persist immediately regardless - only label/icon/colour
 * are staged until Save, matching the old inline panel's behaviour). */
export function openEditAccountModal(account: Account): Promise<Account | null> {
  return new Promise<Account | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aem-overlay";

    let tab: Tab = "details";
    let label = account.label;
    // Icon/colour live in one object (not separate `let`s) so it can be
    // handed to renderAppearancePicker() and mutated in place - see
    // appearance-picker.ts.
    const appearance: AppearanceState = { icon: account.icon, colour: account.colour };
    let fleetEligible = account.fleet_eligible;
    let busy = false;
    let error: string | null = null;
    let projects: ProjectConfig[] = [];
    let projectsLoaded = false;

    function close(result: Account | null): void {
      disposeBack();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    }
    document.addEventListener("keydown", onKey);
    // Phone hardware-back closes this modal the same way Escape does (no
    // confirm - matches existing Cancel/Escape semantics, unlike the
    // add-account wizard which confirms past step 1).
    const disposeBack = registerOverlayBack(() => { close(null); return true; });

    async function loadProjects(): Promise<void> {
      try {
        const all = (await api.listProjects()) as unknown as ProjectConfig[];
        projects = all.filter((p) => p.preferred_account_id === account.id);
      } catch (e) {
        console.error("[edit-account-modal] listProjects failed", e);
      }
      projectsLoaded = true;
      render();
    }

    async function unbindProject(projectId: string): Promise<void> {
      try {
        await api.updateProject(projectId, { preferred_account_id: null });
        await loadProjects();
      } catch (e) { console.error("[edit-account-modal] unbind failed", e); }
    }

    async function bindAnotherProject(): Promise<void> {
      const picked = await pickProject();
      if (!picked) return;
      try {
        const proj = await api.ensureProject(picked.path);
        await api.updateProject(proj.id, { preferred_account_id: account.id });
        await loadProjects();
      } catch (e) { console.error("[edit-account-modal] bind failed", e); }
    }

    async function doSave(): Promise<void> {
      const trimmed = label.trim();
      if (!trimmed) return;
      busy = true;
      error = null;
      render();
      try {
        // `fleetEligible` rides on the same `update_account` command as
        // label/icon/colour (`ipc/accounts/management.rs`), called directly
        // here rather than through `api.updateAccount` since that wrapper's
        // typed shape (`shared/api.ts`) doesn't carry the new field yet.
        const updated = await invoke<Account>("update_account", {
          accountId: account.id,
          label: trimmed,
          icon: appearance.icon,
          colour: appearance.colour,
          fleetEligible,
        });
        close(updated);
      } catch (e) {
        busy = false;
        error = e instanceof Error ? e.message : String(e);
        render();
      }
    }

    function detailsTabHtml(): string {
      return `
        <div class="field">
          <label>Label</label>
          <input class="fake-input" id="aem-label" type="text" value="${escapeHtml(label)}">
        </div>
        <div id="aem-appearance-picker"></div>
        <div class="kit-row">
          <span class="kit-row-label">Fleet eligible (Jarvis may spawn workers on this account)</span>
          <label class="kit-toggle">
            <input type="checkbox" id="aem-fleet-eligible" ${fleetEligible ? "checked" : ""}>
            <span class="kit-toggle-track"></span>
          </label>
        </div>
        ${error ? `<div class="aem-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
      `;
    }

    function projectRowHtml(p: ProjectConfig): string {
      return `
        <div class="rev-item" data-id="${escapeHtml(p.id)}">
          <i class="ph ph-folder f"></i>
          <span class="p">${escapeHtml(p.path)}</span>
          <i class="ph ph-x x" data-id="${escapeHtml(p.id)}" title="Stop using this account for this project"></i>
        </div>
      `;
    }

    function projectsTabHtml(): string {
      if (!projectsLoaded) return `<p class="rev-empty">Loading...</p>`;
      return `
        ${projects.length === 0 ? `<p class="rev-empty">No projects bound to this account yet.</p>` : projects.map(projectRowHtml).join("")}
        <button class="rev-add-btn" id="aem-add-project"><i class="ph ph-plus"></i> Add a project</button>
      `;
    }

    function render(): void {
      overlay.innerHTML = `
        <div class="aem-modal" style="--acc:${escapeHtml(appearance.colour)}" role="dialog" aria-modal="true" aria-label="Edit ${escapeHtml(account.label)}">
          <div class="aem-head">
            <span class="t">Edit ${escapeHtml(account.label)}</span>
            <button class="icon-btn-sq aem-close" id="aem-close-btn" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
          </div>
          <div class="aem-tabs">
            <button class="aem-tab${tab === "details" ? " active" : ""}" data-tab="details">Details</button>
            <button class="aem-tab${tab === "projects" ? " active" : ""}" data-tab="projects">Projects${projectsLoaded ? ` (${projects.length})` : ""}</button>
          </div>
          <div class="aem-body">
            ${tab === "details" ? detailsTabHtml() : projectsTabHtml()}
          </div>
          <div class="aem-actions">
            <button class="btn-secondary" id="aem-cancel-btn">Cancel</button>
            <button class="btn-primary" id="aem-save-btn" ${busy || !label.trim() ? "disabled" : ""}>
              ${busy ? `<i class="ph ph-spinner aem-spin"></i> Saving...` : "Save"}
            </button>
          </div>
        </div>
      `;
      attach();
    }

    function attach(): void {
      overlay.querySelector<HTMLButtonElement>("#aem-close-btn")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>("#aem-cancel-btn")?.addEventListener("click", () => close(null));
      overlay.querySelector<HTMLButtonElement>("#aem-save-btn")?.addEventListener("click", () => void doSave());

      overlay.querySelectorAll<HTMLButtonElement>(".aem-tab").forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
          tab = tabBtn.dataset.tab === "projects" ? "projects" : "details";
          if (tab === "projects" && !projectsLoaded) void loadProjects();
          render();
        });
      });

      if (tab === "details") {
        const labelEl = overlay.querySelector<HTMLInputElement>("#aem-label");
        labelEl?.addEventListener("input", () => {
          label = labelEl.value;
          const saveBtn = overlay.querySelector<HTMLButtonElement>("#aem-save-btn");
          if (saveBtn) saveBtn.disabled = busy || !label.trim();
        });
        overlay.querySelector<HTMLInputElement>("#aem-fleet-eligible")?.addEventListener("change", (e) => {
          fleetEligible = (e.target as HTMLInputElement).checked;
        });
        const pickerContainer = overlay.querySelector<HTMLElement>("#aem-appearance-picker");
        if (pickerContainer) {
          renderAppearancePicker(pickerContainer, appearance, () => {
            // The picker only re-renders its own subtree; the tab-underline
            // colour reads --acc off .aem-modal (outside the picker), so it
            // needs its own update here on every pick, live drag included.
            overlay.querySelector<HTMLElement>(".aem-modal")?.style.setProperty("--acc", appearance.colour);
          });
        }
      } else {
        overlay.querySelectorAll<HTMLElement>(".rev-item .x").forEach((x) => {
          x.addEventListener("click", () => {
            const id = x.dataset.id;
            if (id) void unbindProject(id);
          });
        });
        overlay.querySelector<HTMLButtonElement>("#aem-add-project")?.addEventListener("click", () => void bindAnotherProject());
      }
    }

    document.body.appendChild(overlay);
    render();
  });
}
