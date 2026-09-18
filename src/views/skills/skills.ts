import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { InstalledSkill } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import { openSidemenu } from "../../shared/sidemenu";
import "./skills.css";

let allSkills: InstalledSkill[] = [];
let query = "";
let loadingFlag = true;
let hasError = false;

function filtered(): InstalledSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return allSkills;
  return allSkills.filter(
    (s) =>
      s.skill.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q) ||
      (s.plugin || "").toLowerCase().includes(q) ||
      (s.project || "").toLowerCase().includes(q),
  );
}

// Plugin skills carry the plugin as a "<plugin>:" prefix in the key; the
// badge already names the plugin, so the row shows the bare skill name.
function displayName(s: InstalledSkill): string {
  if (s.plugin && s.skill.startsWith(`${s.plugin}:`)) {
    return s.skill.slice(s.plugin.length + 1);
  }
  return s.skill;
}

function badge(s: InstalledSkill): TemplateResult {
  if (s.plugin) return html`<span class="skill-badge skill-badge-plugin">${s.plugin}</span>`;
  if (s.project) return html`<span class="skill-badge skill-badge-project">${s.project}</span>`;
  return html`<span class="skill-badge skill-badge-personal">personal</span>`;
}

function openSkill(skill: string) {
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
  showView("skill-detail");
}

function onRowKeydown(e: KeyboardEvent, skill: string) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openSkill(skill);
  }
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && query !== "") {
    e.preventDefault();
    query = "";
    draw();
  }
}

function content(): TemplateResult {
  if (loadingFlag) {
    return html`
      <ul class="skills-list" aria-hidden="true">
        ${[0, 1, 2, 3, 4].map(() => html`<li class="v-skeleton skills-skeleton-row"></li>`)}
      </ul>
    `;
  }
  if (hasError) {
    return html`
      <div class="v-empty">
        <i class="ph ph-warning v-empty-icon"></i>
        <div class="v-empty-title">Couldn't load skills</div>
        <div class="v-empty-hint">The daemon didn't respond. Check the connection and try again.</div>
        <button class="btn-secondary skills-retry" @click=${() => void load()}>Retry</button>
      </div>
    `;
  }
  if (allSkills.length === 0) {
    return html`
      <div class="v-empty">
        <i class="ph ph-puzzle-piece v-empty-icon"></i>
        <div class="v-empty-title">No skills installed</div>
        <div class="v-empty-hint">
          No skills found under <code>~/.claude/skills/</code> or installed plugin caches.
        </div>
      </div>
    `;
  }
  const rows = filtered();
  if (rows.length === 0) {
    return html`
      <div class="v-empty">
        <i class="ph ph-magnifying-glass v-empty-icon"></i>
        <div class="v-empty-title">No matches for &quot;${query}&quot;</div>
      </div>
    `;
  }
  return html`
    <ul class="skills-list">
      ${rows.map(
        (s) => html`
          <li
            class="v-row v-focusable"
            role="button"
            tabindex="0"
            title=${s.skill}
            @click=${() => openSkill(s.skill)}
            @keydown=${(e: KeyboardEvent) => onRowKeydown(e, s.skill)}
          >
            <div class="skill-row-main">
              <span class="skill-name">${displayName(s)}</span>
              ${badge(s)}
            </div>
            ${s.description
              ? html`<div class="skill-desc" title=${s.description}>${s.description}</div>`
              : ""}
          </li>
        `,
      )}
    </ul>
  `;
}

function template(): TemplateResult {
  const rows = filtered();
  return html`
    <div class="view view-skills">
      <div class="view-header">
        <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
          <i class="ph ph-list"></i>
        </button>
        <h2>Skills</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="skills-search">
          <div class="skills-search-field">
            <i class="ph ph-magnifying-glass"></i>
            <input
              type="search"
              id="skillsSearchInput"
              placeholder="Search skills..."
              .value=${query}
              @input=${(e: Event) => {
                query = (e.target as HTMLInputElement).value;
                draw();
              }}
              @keydown=${onSearchKeydown}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="skills-count">${rows.length} of ${allSkills.length}</div>
        </div>
        ${content()}
      </div>
    </div>
  `;
}

let mounted: HTMLElement | null = null;

function draw() {
  if (!mounted) return;
  render(template(), mounted);
}

async function load(): Promise<void> {
  loadingFlag = true;
  hasError = false;
  draw();
  try {
    allSkills = await api.listInstalledSkills();
  } catch (err) {
    console.error("list_installed_skills failed", err);
    allSkills = [];
    hasError = true;
  }
  loadingFlag = false;
  draw();
}

export async function renderSkillsView(root: HTMLElement): Promise<() => void> {
  mounted = root;
  query = "";
  draw();
  root.querySelector<HTMLInputElement>("#skillsSearchInput")?.focus();
  await load();

  return () => {
    mounted = null;
  };
}
