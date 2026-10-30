import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import {
  isEffort, modelDisplayLabel, modelFamilyFromId, readGlobalDefault, readModels, EFFORTS,
} from "../../../../shared/effort-presets";
import { projectsListData } from "../../new-session-cache";
import type { ProjectCfg } from "./project-cfg";
import { mountValueSlider } from "./value-slider";

/** What a new chat in this project opens on, as two sliders. An unset half
 *  sits on "Default" and follows Settings > Chat defaults. */
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
    console.error("[project-settings] chat defaults load failed", e);
  }
  const proj = projects.find((p) => p.path === cwd);
  const global = readGlobalDefault(settings);
  const ownModel = proj?.default_model ? modelFamilyFromId(proj.default_model) : "";
  const ownEffort = isEffort(proj?.default_effort) ? proj.default_effort : "";
  const models = readModels(settings);
  if (ownModel && !models.includes(ownModel)) models.push(ownModel);

  const wire = (host: HTMLElement, label: string, field: "default_model" | "default_effort", own: string, values: readonly string[], text: (v: string) => string, followed: string): void => {
    // Stop 0 is "no pin": the chat follows the global default, which the stop's tooltip names.
    const all = ["", ...values];
    let saved = Math.max(0, all.indexOf(own));
    const slider = mountValueSlider(host, {
      label,
      stops: ["Default", ...values.map(text)],
      hints: { 0: `Follows Settings > Chat defaults (${followed})` },
      index: saved,
      onCommit: (idx) => {
        void (async () => {
          try {
            const projectId = proj?.id ?? (await api.ensureProject(cwd)).id;
            await api.updateProject(projectId, { [field]: all[idx] || null });
            saved = idx;
            // The new-chat draft reads this list from a stale-while-revalidate cache.
            await projectsListData().ready.catch(() => {});
            showToast("New chats in this project open on the new default.");
          } catch (e) {
            console.error("[project-settings] update chat default failed", e);
            showToast(`Could not update the default: ${e}`);
            slider.set(saved);
          }
        })();
      },
    });
  };
  wire(modelControl, "Model", "default_model", ownModel, models, modelDisplayLabel, modelDisplayLabel(global.model));
  wire(effortControl, "Effort", "default_effort", ownEffort, EFFORTS, (v) => v, global.effort);
}
