import { html, render } from "lit-html";
import { invoke } from "../../../../shared/ipc";
import { updateSettings } from "../../../../shared/settings-update";
import { escapeHtml } from "../../../../shared/escape-html";
import {
  loadAllRules,
  withRemovedRule,
  type PermissionRule,
} from "../../../sessions/permission-rules";
import { askConfirm } from "../../../../shared/confirm";
import { isRemote } from "../../../../shared/transport";
import { readDefaultFlags } from "../../../../shared/effort-presets";
import { settingsHeader, toggleRow } from "../../ui";
import "./permissions.css";

function projectShortName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function ruleRow(cwd: string, rule: PermissionRule) {
  // An empty pattern means two different things now. For Bash it still means
  // every command. For any other tool it is only ever an old persisted rule
  // from before rules were scoped to their argument, and `matchesRule` refuses
  // to honour it - so labelling it "(any input)" would overstate a rule that
  // authorizes nothing.
  const patternHtml = rule.pattern
    ? html`<code>${rule.pattern}</code>`
    : rule.toolName === "Bash"
      ? html`<span class="perm-rule__any">(any command)</span>`
      : html`<span class="perm-rule__any">(old rule, no longer applies)</span>`;
  return html`
    <div class="perm-rule" data-cwd="${cwd}" data-rule="${rule.raw}">
      <span class="perm-rule__label"><strong>${rule.toolName}</strong> ${patternHtml}</span>
      ${isRemote() ? "" : html`<button class="perm-rule__rm" data-act="remove" title="Remove rule" aria-label="Remove rule"><i class="ph ph-trash"></i></button>`}
    </div>
  `;
}

function projectBlock(cwd: string, rules: PermissionRule[]) {
  return html`
    <div class="perm-project" data-cwd="${cwd}">
      <span class="perm-project__cwd" title="${cwd}">${projectShortName(cwd)} - ${cwd}</span>
      ${rules.map((r) => ruleRow(cwd, r))}
      ${isRemote() ? "" : html`<button class="perm-project__clear-all" data-act="clear-all">Clear all rules for this project</button>`}
    </div>
  `;
}

/** Both default on when absent, matching `Settings::spawned_chats_inherit_auto_accept`
 *  and `Settings::jarvis_workers_auto_accept` on the daemon side. */
function readSpawnFlags(settings: Record<string, unknown>): { inherit: boolean; workers: boolean } {
  return {
    inherit: settings["spawnedChatsInheritAutoAccept"] !== false,
    workers: settings["jarvisWorkersAutoAccept"] !== false,
  };
}

// Desktop-only: each toggle persists through updateSettings, which the daemon
// refuses from the phone.
function defaultsSection(settings: Record<string, unknown>) {
  if (isRemote()) return "";
  const flags = readDefaultFlags(settings);
  const spawn = readSpawnFlags(settings);
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Defaults</div>
      ${toggleRow({ label: "Auto-allow permissions by default", inputId: "chatDefaultsAutoAllow", checked: flags.autoAccept })}
      ${toggleRow({
        label: "Chats an agent starts inherit auto-allow",
        inputId: "chatDefaultsInheritAutoAllow",
        checked: spawn.inherit,
        tooltip: "A chat started by spawn_chat or a scheduled new chat copies its parent's auto-allow. Off: it asks for permissions. Respawn always keeps the flag.",
      })}
      ${toggleRow({
        label: "Jarvis workers auto-allow",
        inputId: "chatDefaultsWorkersAutoAllow",
        checked: spawn.workers,
        tooltip: "Workers Jarvis spawns run with auto-allow. Off: they ask, and Jarvis can approve their permission prompts. Worker questions always come to you.",
      })}
    </div>
  `;
}

function template(rulesByCwd: Record<string, PermissionRule[]>, settings: Record<string, unknown>) {
  const entries = Object.entries(rulesByCwd);
  return html`
    <div class="view view-settings-permissions">
      ${settingsHeader("Permissions")}
      <div class="view-body">
        ${defaultsSection(settings)}
        <div class="kit-section">
          <div class="kit-section-title">Remembered rules</div>
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
    render(template(loadAllRules(settings), settings), root);

    root.querySelectorAll<HTMLButtonElement>('[data-act="remove"]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest<HTMLElement>(".perm-rule");
        if (!row) return;
        const cwd = row.dataset.cwd;
        const ruleRaw = row.dataset.rule;
        if (!cwd || !ruleRaw) return;
        try {
          settings = await updateSettings((fresh) => withRemovedRule(fresh, cwd, ruleRaw));
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
        try {
          settings = await updateSettings((fresh) => {
            let updated = fresh;
            const rules = loadAllRules(fresh)[cwd] ?? [];
            for (const rule of rules) {
              updated = withRemovedRule(updated, cwd, rule.raw);
            }
            return updated;
          });
          rerender();
        } catch (e) {
          console.warn("[permissions] save_settings failed:", e);
        }
      };
    });
  }

  rerender();

  // The toggles keep their own checked state across rerender() (lit updates
  // in place), so one delegated handler on root covers every redraw.
  const onToggle = (e: Event) => {
    const t = e.target as HTMLInputElement | null;
    if (!t) return;
    const patch: Record<string, string> = {
      chatDefaultsAutoAllow: "defaultAutoAllow",
      chatDefaultsInheritAutoAllow: "spawnedChatsInheritAutoAccept",
      chatDefaultsWorkersAutoAllow: "jarvisWorkersAutoAccept",
    };
    const key = patch[t.id];
    if (!key) return;
    // Fresh-read + retry: building from the frontend's own
    // settings cache could revert a concurrent daemon-owned write.
    void updateSettings((fresh) => ({ ...fresh, [key]: t.checked }))
      .then((saved) => { settings = saved; })
      .catch((err) => console.warn("[permissions] save_settings failed:", err));
  };
  root.addEventListener("change", onToggle);

  return () => root.removeEventListener("change", onToggle);
}
