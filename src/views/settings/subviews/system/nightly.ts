import { html } from "lit-html";
import { showToast } from "../../../../shared/toast";
import { updateSettings } from "../../../../shared/settings-update";
import type { TerminalAction } from "../../../../types/ipc.generated";
import type { SettingsShape } from "../../../../shared/state";
import { toggleRow } from "../../ui";

export type OverdueAction = "cancel" | "force";

// Read by the Rust nightly scheduler (src-tauri/src/when_done/nightly.rs).
export interface NightlyWhenDone {
  enabled: boolean;
  action: TerminalAction;
  time: string;
  // Hours after the arm time before an unfired arm is considered overdue.
  overdueHours: number;
  overdueAction: OverdueAction;
}

export function readNightly(s: SettingsShape): NightlyWhenDone {
  const raw = (s.nightlyWhenDone ?? {}) as Partial<NightlyWhenDone>;
  return {
    enabled: raw.enabled === true,
    action: raw.action === "sleep" ? "sleep" : "shutdown",
    time: typeof raw.time === "string" && /^\d{2}:\d{2}$/.test(raw.time) ? raw.time : "02:00",
    overdueHours: typeof raw.overdueHours === "number" && raw.overdueHours >= 0 ? raw.overdueHours : 3,
    overdueAction: raw.overdueAction === "force" ? "force" : "cancel",
  };
}

function saveNightly(patch: Partial<NightlyWhenDone>): void {
  void updateSettings((s) => ({ ...s, nightlyWhenDone: { ...readNightly(s), ...patch } })).catch((err) => {
    console.error("[settings-system nightly] save failed", err);
    showToast("Couldn't save settings - your last change wasn't saved. Try again.");
  });
}

export function wireNightly(root: HTMLElement): void {
  const enabled = root.querySelector<HTMLInputElement>("#nightlyWhenDoneEnabled");
  enabled?.addEventListener("change", () => saveNightly({ enabled: enabled.checked }));

  const action = root.querySelector<HTMLSelectElement>("#nightlyWhenDoneAction");
  action?.addEventListener("change", () => {
    saveNightly({ action: action.value === "sleep" ? "sleep" : "shutdown" });
  });

  // `change` fires only once the picker holds a complete time; an emptied field
  // reads "" and is skipped rather than saved.
  const time = root.querySelector<HTMLInputElement>("#nightlyWhenDoneTime");
  time?.addEventListener("change", () => {
    if (/^\d{2}:\d{2}$/.test(time.value)) saveNightly({ time: time.value });
  });

  const overdueHours = root.querySelector<HTMLInputElement>("#nightlyWhenDoneOverdueHours");
  overdueHours?.addEventListener("change", () => {
    const n = Number(overdueHours.value);
    if (Number.isFinite(n) && n >= 0) saveNightly({ overdueHours: n });
  });

  const overdueAction = root.querySelector<HTMLSelectElement>("#nightlyWhenDoneOverdueAction");
  overdueAction?.addEventListener("change", () => {
    saveNightly({ overdueAction: overdueAction.value === "force" ? "force" : "cancel" });
  });
}

export function nightlySection(n: NightlyWhenDone) {
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Nightly</div>
      ${toggleRow({
        label: "Sleep or shut down once chats are done",
        inputId: "nightlyWhenDoneEnabled",
        checked: n.enabled,
        tooltip: "Every night at the set time, arms When done. It waits until every chat is idle and you've been away from the PC for 15 minutes, up to the \"give up waiting\" cutoff below. Chats are left open, not closed.",
      })}
      <div class="kit-row">
        <span class="kit-row-label">Action</span>
        <select id="nightlyWhenDoneAction" class="kit-select">
          <option value="shutdown" ?selected=${n.action === "shutdown"}>Shut down</option>
          <option value="sleep" ?selected=${n.action === "sleep"}>Sleep</option>
        </select>
      </div>
      <div class="kit-row">
        <span class="kit-row-label">Starting at</span>
        <input type="time" id="nightlyWhenDoneTime" .value=${n.time}>
      </div>
      <div class="kit-row">
        <span class="kit-row-label">Give up waiting after</span>
        <!-- kit-row spreads its children with space-between, so the input and
             its unit share one wrapper to sit together at the right edge. -->
        <span style="display:inline-flex;align-items:center;gap:8px">
          <input
            type="number"
            id="nightlyWhenDoneOverdueHours"
            style="width:64px"
            min="0"
            step="0.5"
            .value=${String(n.overdueHours)}
          >
          <span class="kit-row-label">hours</span>
        </span>
      </div>
      <div class="kit-row">
        <span class="kit-row-label">If still waiting then</span>
        <select id="nightlyWhenDoneOverdueAction" class="kit-select">
          <option value="cancel" ?selected=${n.overdueAction === "cancel"}>Cancel it, back to normal</option>
          <option value="force" ?selected=${n.overdueAction === "force"}>Do it anyway</option>
        </select>
      </div>
    </div>
  `;
}
