import { invoke } from "../../shared/ipc";
import { escapeHtml } from "../../shared/escape-html";
import { lockInputToHost } from "../../shared/modal-input-lock";

const LAST_PARENT_KEY = "newProjectLastParent";

let _isOpen = false;
export function isNewProjectModalOpen(): boolean { return _isOpen; }

async function readLastParent(): Promise<string> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s?.[LAST_PARENT_KEY];
    if (typeof v === "string" && v.length > 0) return v;
  } catch { /* ignore */ }
  return "";
}

async function saveLastParent(path: string): Promise<void> {
  try {
    const cur = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...cur, [LAST_PARENT_KEY]: path } });
  } catch { /* ignore */ }
}

export function openNewProjectModal(): Promise<{ path: string; name: string } | null> {
  if (_isOpen) return Promise.resolve(null);
  _isOpen = true;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-project-overlay";
    document.body.appendChild(overlay);

    let parentFolder = "";
    let projectName = "";
    let resolved = false;

    const unlock = lockInputToHost(overlay);

    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      _isOpen = false;
      unlock();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };

    // Full DOM rebuild — called on init and when parentFolder changes.
    const buildHtml = () => {
      const nameTrimmed = projectName.trim();
      const canCreate = nameTrimmed.length > 0 && parentFolder.length > 0;
      const sep = parentFolder.includes("\\") ? "\\" : "/";
      const preview = parentFolder && nameTrimmed ? `${parentFolder}${sep}${nameTrimmed}` : "";

      overlay.innerHTML = `
        <div class="new-project-backdrop"></div>
        <div class="new-project-card" role="dialog" aria-modal="true" aria-label="New project">
          <h3 class="new-project-title">New project</h3>
          <div class="new-project-field">
            <label class="new-project-label">Project name</label>
            <input
              id="new-project-name"
              class="new-project-input"
              type="text"
              autocomplete="off"
              placeholder="my-project"
              value="${escapeHtml(projectName)}"
            />
          </div>
          <div class="new-project-field">
            <label class="new-project-label">Location</label>
            <div class="new-project-location-row">
              <span class="new-project-location-text ${parentFolder ? "" : "placeholder"}">${parentFolder || "No folder selected"}</span>
              <button class="btn btn-secondary new-project-browse-btn" id="new-project-browse">
                <i class="ph ph-folder-open"></i> Browse
              </button>
            </div>
          </div>
          ${preview ? `<div class="new-project-preview">${escapeHtml(preview)}</div>` : ""}
          <div class="new-project-actions">
            <button class="btn btn-secondary" id="new-project-cancel">Cancel</button>
            <button class="btn btn-primary" id="new-project-create" ${canCreate ? "" : "disabled"}>
              <i class="ph ph-folder-plus"></i> Create
            </button>
          </div>
        </div>
      `;

      wireEvents();
      setTimeout(() => overlay.querySelector<HTMLInputElement>("#new-project-name")?.focus(), 0);
    };

    // Patches only the button state and preview without touching the input element.
    // Called on every keystroke so cursor position is preserved naturally.
    const patchDynamic = () => {
      const nameTrimmed = projectName.trim();
      const canCreate = nameTrimmed.length > 0 && parentFolder.length > 0;
      const sep = parentFolder.includes("\\") ? "\\" : "/";
      const preview = parentFolder && nameTrimmed ? `${parentFolder}${sep}${nameTrimmed}` : "";

      const btn = overlay.querySelector<HTMLButtonElement>("#new-project-create");
      if (btn) btn.disabled = !canCreate;

      let previewEl = overlay.querySelector<HTMLElement>(".new-project-preview");
      if (preview) {
        if (!previewEl) {
          previewEl = document.createElement("div");
          previewEl.className = "new-project-preview";
          overlay.querySelector(".new-project-actions")?.before(previewEl);
        }
        previewEl.textContent = preview;
      } else {
        previewEl?.remove();
      }

      // Refresh Enter handler so it sees updated canCreate.
      const nameInput = overlay.querySelector<HTMLInputElement>("#new-project-name");
      if (nameInput) nameInput.onkeydown = (e) => { if (e.key === "Enter" && canCreate) void submit(); };
    };

    const wireEvents = () => {
      const nameInput = overlay.querySelector<HTMLInputElement>("#new-project-name");
      if (nameInput) {
        nameInput.addEventListener("input", (e) => {
          projectName = (e.target as HTMLInputElement).value;
          patchDynamic();
        });
        patchDynamic(); // set initial onkeydown
      }

      overlay.querySelector("#new-project-browse")?.addEventListener("click", async () => {
        const picked = await invoke<string | null>("pick_folder");
        if (picked) {
          parentFolder = picked;
          buildHtml();
        }
      });

      overlay.querySelector("#new-project-cancel")?.addEventListener("click", () => finish(null));
      overlay.querySelector("#new-project-create")?.addEventListener("click", () => { void submit(); });
      overlay.querySelector(".new-project-backdrop")?.addEventListener("click", () => finish(null));
    };

    async function submit() {
      const name = projectName.trim();
      if (!name || !parentFolder) return;
      const sep = parentFolder.includes("\\") ? "\\" : "/";
      const fullPath = `${parentFolder}${sep}${name}`;
      try {
        await invoke("create_folder", { path: fullPath });
      } catch (e) {
        alert(`Could not create folder: ${e}`);
        return;
      }
      await saveLastParent(parentFolder);
      finish({ path: fullPath, name });
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish(null);
    }
    document.addEventListener("keydown", onKey);

    readLastParent().then((last) => {
      parentFolder = last;
      buildHtml();
    });
  });
}
