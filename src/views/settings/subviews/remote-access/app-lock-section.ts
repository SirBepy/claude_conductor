import { html, type TemplateResult } from "lit-html";
import { toggleRow } from "../../ui";

// The Android app's fingerprint/PIN lock. Stored on the phone by the shell
// (window.ConductorLock), so it only shows inside the Android app. The shell's
// AppLockPolicy owns the allowed windows and the default; a value it does not
// know reads back as its default.

interface LockBridge {
  getRelockMinutes(): number;
  setRelockMinutes(minutes: number): void;
  // Absent on shells older than the opt-in lock: the switch hides then.
  getRelockChoices?(): string;
  isLockEnabled?(): boolean;
  setLockEnabled?(enabled: boolean): void;
  hasScreenLock?(): boolean;
}

// Used by shells that predate getRelockChoices; mirrors AppLockPolicy.kt.
const FALLBACK_CHOICES = [0, 1, 5, 10, 30, 60];
const FALLBACK_DEFAULT = 10;

function bridge(): LockBridge | null {
  const b = (window as unknown as { ConductorLock?: Partial<LockBridge> }).ConductorLock;
  return typeof b?.getRelockMinutes === "function" && typeof b.setRelockMinutes === "function"
    ? (b as LockBridge)
    : null;
}

function minutesLabel(minutes: number): string {
  if (minutes === 0) return "Every time";
  if (minutes === 60) return "After 1 hour";
  if (minutes % 60 === 0) return `After ${minutes / 60} hours`;
  return minutes === 1 ? "After 1 minute" : `After ${minutes} minutes`;
}

function readChoices(b: LockBridge): { choices: number[]; fallback: number } {
  try {
    const parsed = JSON.parse(b.getRelockChoices!()) as { choices?: unknown; default?: unknown };
    if (Array.isArray(parsed.choices) && parsed.choices.every((n) => Number.isInteger(n)) && parsed.choices.length > 0) {
      const choices = parsed.choices as number[];
      const fallback = typeof parsed.default === "number" && choices.includes(parsed.default) ? parsed.default : choices[0] ?? FALLBACK_DEFAULT;
      return { choices, fallback };
    }
  } catch { /* older shell or a bad payload: use the built-in list */ }
  return { choices: FALLBACK_CHOICES, fallback: FALLBACK_DEFAULT };
}

export function appLockSectionTemplate(): TemplateResult | string {
  const b = bridge();
  if (!b) return "";
  const { choices, fallback } = readChoices(b);
  let current = fallback;
  try { current = b.getRelockMinutes(); } catch { /* keep the shell's default */ }

  const hasSwitch = typeof b.isLockEnabled === "function" && typeof b.setLockEnabled === "function";
  let screenLock = true;
  try { if (typeof b.hasScreenLock === "function") screenLock = b.hasScreenLock(); } catch { /* assume one */ }
  let enabled = true;
  try { if (hasSwitch) enabled = b.isLockEnabled!(); } catch { /* keep it on: the safe reading */ }
  // Without a screen lock there is nothing to check against, so the lock cannot be on.
  const switchOn = enabled && screenLock;

  return html`
    <div class="kit-section" id="ra-app-lock-section">
      <div class="kit-section-title">App lock</div>
      ${hasSwitch
        ? toggleRow({
            label: "Lock this app",
            inputId: "ra-app-lock-enabled",
            checked: switchOn,
            disabled: !screenLock,
            onChange: (e: Event) => {
              const input = e.target as HTMLInputElement;
              try { b.setLockEnabled!(input.checked); } catch (err) { console.error("[app-lock] save failed", err); }
              const select = input.closest("#ra-app-lock-section")?.querySelector<HTMLSelectElement>("#ra-app-lock-minutes");
              if (select) select.disabled = !input.checked;
            },
          })
        : ""}
      ${hasSwitch && !screenLock
        ? html`<p class="ra-caption" id="ra-app-lock-no-screen-lock">Set up a screen lock in Android settings first.</p>`
        : ""}
      <div class="kit-row">
        <span class="kit-row-label">Ask for fingerprint</span>
        <select id="ra-app-lock-minutes" class="kit-select" ?disabled=${hasSwitch && !switchOn} @change=${(e: Event) => {
          const v = Number((e.target as HTMLSelectElement).value);
          try { b.setRelockMinutes(v); } catch (err) { console.error("[app-lock] save failed", err); }
        }}>
          ${choices.map((m) => html`<option value=${String(m)} ?selected=${m === current}>${minutesLabel(m)}</option>`)}
        </select>
      </div>
      <p class="ra-caption">How long this phone can be away from the app before it asks again. Reopening the app after Android closed it always asks. "Every time" asks after leaving the app, but not right after picking a photo or file from inside it.</p>
    </div>
  `;
}
