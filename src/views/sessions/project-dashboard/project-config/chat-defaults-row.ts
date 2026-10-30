import { escapeHtml } from "../../../../shared/escape-html";
import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import {
  isEffort, modelDisplayLabel, modelFamilyFromId, readGlobalDefault, readModels, EFFORTS,
} from "../../../../shared/effort-presets";
import { projectsListData } from "../../new-session-cache";
import type { ProjectCfg } from "./project-cfg";

/** What a new chat in this project opens on. An unset half follows Settings >
 *  Chat defaults, which the first option names, so the row always shows what a
 *  new chat will actually start with. */
export async function renderChatDefaultsRow(cwd: string): Promise<void> {
  const modelControl = document.getElementById("chatDefaultModelControl");
  const effortControl = document.getElementById("chatDefaultEffortControl");
  if (!cwd || !modelControl || !effortControl) return;

  let projects: ProjectCfg[] = [];
  let settings: Record<string, unknown> = {};
  try {
    [projects, settings] = await Promise.all([
      api.listProjects() as unknown as Promise<ProjectCfg[]>,
      api.getSettings().then((s) => s ?? {}),
    ]);
  } catch (e) {
    console.error("[automation] chat defaults load failed", e);
  }
  const proj = projects.find((p) => p.path === cwd);
  const global = readGlobalDefault(settings);
  const ownModel = proj?.default_model ? modelFamilyFromId(proj.default_model) : "";
  const ownEffort = isEffort(proj?.default_effort) ? proj.default_effort : "";
  const models = readModels(settings);
  if (ownModel && !models.includes(ownModel)) models.push(ownModel);

  const options = (own: string, defaultLabel: string, values: readonly string[], label: (v: string) => string): string =>
    `<option value=""${own ? "" : " selected"}>${escapeHtml(defaultLabel)}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}"${v === own ? " selected" : ""}>${escapeHtml(label(v))}</option>`).join("");
  modelControl.innerHTML = `<select id="chatDefaultModel" class="inline-select">${options(ownModel, `Default (${modelDisplayLabel(global.model)})`, models, modelDisplayLabel)}</select>`;
  effortControl.innerHTML = `<select id="chatDefaultEffort" class="inline-select">${options(ownEffort, `Default (${global.effort})`, EFFORTS, (v) => v)}</select>`;

  const wire = (id: string, field: "default_model" | "default_effort"): void => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (!select) return;
    select.onchange = () => {
      void (async () => {
        select.disabled = true;
        try {
          const projectId = proj?.id ?? (await api.ensureProject(cwd)).id;
          await api.updateProject(projectId, { [field]: select.value || null });
          // The new-chat draft reads this list from a stale-while-revalidate cache.
          await projectsListData().ready.catch(() => {});
          showToast("New chats in this project open on the new default.");
        } catch (e) {
          console.error("[automation] update chat default failed", e);
          showToast(`Could not update the default: ${e}`);
        } finally {
          await renderChatDefaultsRow(cwd);
        }
      })();
    };
  };
  wire("chatDefaultModel", "default_model");
  wire("chatDefaultEffort", "default_effort");
}
