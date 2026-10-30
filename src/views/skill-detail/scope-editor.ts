// Per-project skill scope: the "Available in" box on a skill's
// page, and the one-line summary the Skills list shows. Stored in settings as
// `skillScopes[<scope key>] = { projects: [<project id>], elsewhere }`; the
// daemon turns it into each chat's `skillOverrides` / `enabledPlugins`
// (src-tauri/src/slash/scope.rs), so it applies to chats started after a save.

import { html, type TemplateResult } from "lit-html";
import type { InstalledSkill } from "../../types/ipc.generated";
import type { SettingsShape } from "../../shared/state";
import { updateSettings } from "../../shared/settings-update";
import { basename } from "../../shared/path-utils";

export type Elsewhere = "off" | "name-only";
export interface SkillScope {
  projects: string[];
  elsewhere: Elsewhere;
}
export type ScopeMap = Record<string, SkillScope>;
/** The project fields the editor reads, as `list_projects` returns them. */
export interface ScopeProject {
  id: string;
  path: string;
  name?: unknown;
}

const SETTINGS_KEY = "skillScopes";

export function readScopes(settings: SettingsShape | null | undefined): ScopeMap {
  const raw = settings?.[SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: ScopeMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as { projects?: unknown; elsewhere?: unknown };
    out[k] = {
      projects: Array.isArray(o.projects) ? o.projects.filter((p): p is string => typeof p === "string") : [],
      elsewhere: o.elsewhere === "name-only" ? "name-only" : "off",
    };
  }
  return out;
}

/** Saves one key's scope; `null` makes it available everywhere again. */
export async function saveScope(key: string, scope: SkillScope | null): Promise<ScopeMap> {
  const saved = await updateSettings((s) => {
    const next = { ...readScopes(s) };
    if (scope) next[key] = scope;
    else delete next[key];
    s[SETTINGS_KEY] = next;
  });
  return readScopes(saved);
}

function projectName(projects: readonly ScopeProject[], id: string): string {
  const p = projects.find((x) => x.id === id);
  if (!p) return "removed project";
  return typeof p.name === "string" && p.name ? p.name : basename(p.path);
}

/** The Skills list's quiet line for a scoped skill, or null when unscoped. */
export function scopeSummary(scope: SkillScope | undefined, projects: readonly ScopeProject[]): string | null {
  if (!scope) return null;
  const [only, ...rest] = scope.projects;
  const where = only === undefined ? "no projects" : rest.length === 0 ? projectName(projects, only) : `${scope.projects.length} projects`;
  return scope.elsewhere === "name-only" ? `${where}, name only elsewhere` : where;
}

export interface ScopeEditorProps {
  skill: InstalledSkill;
  scope: SkillScope | null;
  projects: readonly ScopeProject[];
  addOpen: boolean;
  onChange: (next: SkillScope | null) => void;
  onToggleAdd: () => void;
}

export function scopeEditor(p: ScopeEditorProps): TemplateResult {
  const key = p.skill.scope_key;
  if (!key) return html``;
  const plugin = key.includes("@") ? p.skill.plugin : null;
  const name = plugin ? plugin : p.skill.skill;
  const scoped = p.scope !== null;
  const scope = p.scope ?? { projects: [], elsewhere: "off" as Elsewhere };
  const set = (patch: Partial<SkillScope>) => p.onChange({ ...scope, ...patch });
  const addable = p.projects.filter((pr) => !scope.projects.includes(pr.id));
  const seg = (on: boolean, label: string, click: () => void) =>
    html`<button type="button" aria-pressed=${on ? "true" : "false"} @click=${click}>${label}</button>`;
  return html`
    <div class="skill-scope">
      <div class="skill-scope-row">
        <span class="skill-scope-label">Available in</span>
        <span class="skill-scope-seg">
          ${seg(!scoped, "Every project", () => p.onChange(null))}
          ${seg(scoped, "Only some projects", () => { if (!scoped) p.onChange(scope); })}
        </span>
      </div>
      ${scoped
        ? html`
            <div class="skill-scope-row">
              <span class="skill-scope-label"></span>
              <span class="skill-scope-chips">
                ${scope.projects.map(
                  (id) => html`
                    <span class="skill-scope-chip">
                      ${projectName(p.projects, id)}
                      <button type="button" title="Remove" @click=${() => set({ projects: scope.projects.filter((x) => x !== id) })}>
                        <i class="ph ph-x"></i>
                      </button>
                    </span>
                  `,
                )}
                ${addable.length
                  ? html`
                      <span class="skill-scope-add-wrap">
                        <button type="button" class="skill-scope-add" @click=${(e: Event) => { e.stopPropagation(); p.onToggleAdd(); }}>
                          <i class="ph ph-plus"></i> Add project
                        </button>
                        ${p.addOpen
                          ? html`<div class="skill-scope-menu">
                              ${addable.map(
                                (pr) => html`<div @click=${(e: Event) => { e.stopPropagation(); set({ projects: [...scope.projects, pr.id] }); }}>${projectName(p.projects, pr.id)}</div>`,
                              )}
                            </div>`
                          : ""}
                      </span>
                    `
                  : ""}
              </span>
            </div>
            ${plugin
              ? ""
              : html`
                  <div class="skill-scope-row">
                    <span class="skill-scope-label">Elsewhere</span>
                    <span class="skill-scope-seg">
                      ${seg(scope.elsewhere === "off", "Hidden", () => set({ elsewhere: "off" }))}
                      ${seg(scope.elsewhere === "name-only", "Name only", () => set({ elsewhere: "name-only" }))}
                    </span>
                    <span class="skill-scope-note">
                      ${scope.elsewhere === "off"
                        ? html`Claude doesn't see it at all. Typing <code>/${name}</code> offers to enable it.`
                        : "Claude sees the name only, no description. It can still use it on its own."}
                    </span>
                  </div>
                `}
          `
        : ""}
      <div class="skill-scope-note">
        <i class="ph ph-info"></i>
        ${plugin
          ? html`Applies to the whole <b>${plugin}</b> plugin, all its skills and its MCP servers. `
          : ""}Applies to chats started from now on. An open chat picks it up through <b>Enable here</b>, which restarts
        it with its history kept.
      </div>
    </div>
  `;
}
