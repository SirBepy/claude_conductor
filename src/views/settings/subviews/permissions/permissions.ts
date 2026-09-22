import { html, render } from "lit-html";
import { invoke } from "../../../../shared/ipc";
import { escapeHtml } from "../../../../shared/escape-html";
import {
  loadAllRules,
  withRemovedRule,
  type PermissionRule,
} from "../../../sessions/permission-rules";
import { askConfirm } from "../../../../shared/confirm";
import { settingsHeader } from "../../ui";
import "./permissions.css";

function projectShortName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function ruleRow(cwd: string, rule: PermissionRule) {
  const patternHtml = rule.pattern
    ? html`<code>${rule.pattern}</code>`
    : html`<span class="perm-rule__any">(any input)</span>`;
  return html`
    <div class="perm-rule" data-cwd="${cwd}" data-rule="${rule.raw}">
      <span class="perm-rule__label"><strong>${rule.toolName}</strong> ${patternHtml}</span>
      <button class="perm-rule__rm" data-act="remove" title="Remove rule" aria-label="Remove rule"><i class="ph ph-trash"></i></button>
    </div>
  `;
}

function projectBlock(cwd: string, rules: PermissionRule[]) {
  return html`
    <div class="perm-project" data-cwd="${cwd}">
      <span class="perm-project__cwd" title="${cwd}">${projectShortName(cwd)} - ${cwd}</span>
      ${rules.map((r) => ruleRow(cwd, r))}
      <button class="perm-project__clear-all" data-act="clear-all">Clear all rules for this project</button>
    </div>
  `;
}

function template(rulesByCwd: Record<string, PermissionRule[]>) {
  const entries = Object.entries(rulesByCwd);
  return html`
    <div class="view view-settings-permissions">
      ${settingsHeader("Permissions")}
      <div class="view-body">
        <div class="kit-section">
          <p class="perm-hint">
            Tool permissions you've marked as "Always Allow" in a chat. Rules are scoped per project (cwd). Destructive Bash patterns
            (rm -rf, git push --force, drop database, etc.) always prompt regardless of rules.
          </p>
          ${entries.length === 0
            ? html`
              <div class="v-empty">
                <i class="ph ph-shield-check v-empty-icon"></i>
                <div class="v-empty-title">No remembered permissions yet</div>
                <div class="v-empty-hint">Click "Always Allow" on a tool prompt to add one.</div>
              </div>
            `
            : entries.map(([cwd, rules]) => projectBlock(cwd, rules))}
        </div>
      </div>
    </div>
  `;
}

export async function renderPermissionsView(root: HTMLElement): Promise<() => void> {
  let settings: Record<string, unknown> = {};
  try {
    settings = await invoke<Record<string, unknown>>("get_settings");
  } catch (e) {
    console.error("[permissions] get_settings failed", e);
  }

  function rerender() {
    render(template(loadAllRules(settings)), root);

    root.querySelectorAll<HTMLButtonElement>('[data-act="remove"]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest<HTMLElement>(".perm-rule");
        if (!row) return;
        const cwd = row.dataset.cwd;
        const ruleRaw = row.dataset.rule;
        if (!cwd || !ruleRaw) return;
        const updated = withRemovedRule(settings, cwd, ruleRaw);
        try {
          await invoke("save_settings", { updated });
          settings = updated;
          rerender();
        } catch (e) {
          console.warn("[permissions] save_settings failed:", e);
        }
      };
    });

    root.querySelectorAll<HTMLButtonElement>('[data-act="clear-all"]').forEach((btn) => {
      btn.onclick = async () => {
        const block = btn.closest<HTMLElement>(".perm-project");
        if (!block) return;
        const cwd = block.dataset.cwd;
        if (!cwd) return;
        const ok = await askConfirm(`Remove every remembered permission for ${escapeHtml(cwd)}?`, { confirmLabel: "Remove" });
        if (!ok) return;
        let updated = settings;
        const rules = loadAllRules(settings)[cwd] ?? [];
        for (const rule of rules) {
          updated = withRemovedRule(updated, cwd, rule.raw);
        }
        try {
          await invoke("save_settings", { updated });
          settings = updated;
          rerender();
        } catch (e) {
          console.warn("[permissions] save_settings failed:", e);
        }
      };
    });
  }

  rerender();
  return () => {};
}
