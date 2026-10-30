import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import {
  isEffort, modelDisplayLabel, modelFamilyFromId, readGlobalDefault, readModels, EFFORTS,
} from "../../../../shared/effort-presets";
import { projectsListData } from "../../new-session-cache";
import type { ProjectCfg } from "./project-cfg";
import { mountValueSlider } from "./value-slider";

/** What a new chat in this project opens on, as two sliders. The stop that
 *  matches Settings > Chat defaults carries a star; sitting on it means "no pin"
 *  (stored as unset, so changing the global default still moves this project),
 *  and a revert arrow shows while the project is pinned to something else. */
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
  const globalModel = modelFamilyFromId(global.model);
  const ownModel = proj?.default_model ? modelFamilyFromId(proj.default_model) : "";
  const ownEffort = isEffort(proj?.default_effort) ? proj.default_effort : "";
  // A default or pin outside the offered list (a removed custom model) stays selectable.
  const models = readModels(settings);
  for (const m of [globalModel, ownModel]) if (m && !models.includes(m)) models.push(m);

  const wire = (
    host: HTMLElement,
    revert: HTMLButtonElement | null,
    label: string,
    field: "default_model" | "default_effort",
    own: string,
    fallback: string,
    values: readonly string[],
    text: (v: string) => string,
  ): void => {
    const defaultIdx = Math.max(0, values.indexOf(fallback));
    // A pin equal to the default is the same as no pin.
    let saved = own && values.includes(own) ? values.indexOf(own) : defaultIdx;
    const row = host.closest(".ps-field");
    const sync = (idx: number): void => {
      row?.classList.toggle("is-changed", idx !== defaultIdx);
      // Disabled, not just faded: an invisible arrow must not stay in the Tab order.
      if (revert) revert.disabled = idx === defaultIdx;
    };
    // Saves run one after another so the persisted value is always the last one
    // that succeeded, and only the newest commit may revert the thumb: an older
    // failure would otherwise glide it back over a value that is still saving.
    let queue: Promise<void> = Promise.resolve();
    let latest = 0;
    const slider = mountValueSlider(host, {
      label,
      stops: values.map(text),
      defaultIndex: defaultIdx,
      defaultHint: "Default: follows Settings > Chat defaults",
      index: saved,
      onChange: sync,
      onCommit: (idx) => {
        const mine = ++latest;
        queue = queue.then(async () => {
          try {
            const projectId = proj?.id ?? (await api.ensureProject(cwd)).id;
            await api.updateProject(projectId, { [field]: idx === defaultIdx ? null : values[idx] });
            saved = idx;
            // The new-chat draft reads this list from a stale-while-revalidate cache.
            await projectsListData().ready.catch(() => {});
            showToast("New chats in this project open on the new default.");
          } catch (e) {
            console.error("[project-settings] update chat default failed", e);
            showToast(`Could not update the default: ${e}`);
            if (mine === latest) slider.set(saved);
          }
        });
      },
    });
    if (revert) {
      revert.title = `Back to default (${text(fallback)})`;
      revert.onclick = () => slider.commit(defaultIdx);
    }
  };
  wire(modelControl, document.getElementById("chatDefaultModelRevert") as HTMLButtonElement | null, "Model", "default_model", ownModel, globalModel, models, modelDisplayLabel);
  wire(effortControl, document.getElementById("chatDefaultEffortRevert") as HTMLButtonElement | null, "Effort", "default_effort", ownEffort, global.effort, EFFORTS, (v) => v);
}
