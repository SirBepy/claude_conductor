import { html, type TemplateResult } from "lit-html";
import { toggleRow } from "../../ui";

// The Android app's fingerprint/PIN lock. Stored on the phone by the shell
// (window.ConductorLock), so it only shows inside the Android app. The shell's
// AppLockPolicy owns the allowed windows and the default; a value it does not
// know reads back as its default.

interface LockBridge {
  getRelockMinutes(): number;
  // true = saved. false = a longer window is waiting on the fingerprint/PIN and
  // the shell answers through window.__ccLockSwitchResult. Older shells return
  // nothing and have saved already.
  setRelockMinutes(minutes: number): boolean | void;
  // Absent on shells older than the opt-in lock: the switch hides then.
  getRelockChoices?(): string;
  isLockEnabled?(): boolean;
  // true = saved. false = the shell is asking for the fingerprint/PIN first and
  // answers through window.__ccLockSwitchResult. Older shells return nothing
  // and have saved already.
  setLockEnabled?(enabled: boolean): boolean | void;
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
              const select = input.closest("#ra-app-lock-section")?.querySelector<HTMLSelectElement>("#ra-app-lock-minutes");
              const want = input.checked;
              const settle = (applied: boolean) => {
                input.disabled = !screenLock;
                // A cancelled or failed unlock leaves the lock as it was.
                input.checked = applied ? want : !want;
                if (select) select.disabled = !input.checked;
              };
              // Registered before the call so the shell's answer cannot beat it.
              const win = window as unknown as { __ccLockSwitchResult?: (applied: boolean) => void };
              win.__ccLockSwitchResult = (applied) => {
                delete win.__ccLockSwitchResult;
                settle(applied);
              };
              let pending = false;
              try { pending = b.setLockEnabled!(want) === false; } catch (err) { console.error("[app-lock] save failed", err); }
              if (pending) {
                // Locked against a second flip while the prompt is up. The picker
                // shares the shell's one answer callback, so a change there would
                // overwrite it and strand this switch disabled.
                input.disabled = true;
                if (select) select.disabled = true;
                return;
              }
              delete win.__ccLockSwitchResult;
              if (select) select.disabled = !want;
            },
          })
        : ""}
      ${hasSwitch && !screenLock
        ? html`<p class="ra-caption" id="ra-app-lock-no-screen-lock">Set up a screen lock in Android settings first.</p>`
        : ""}
      <div class="kit-row">
        <span class="kit-row-label">Ask for fingerprint</span>
        <select id="ra-app-lock-minutes" class="kit-select" ?disabled=${hasSwitch && !switchOn} @change=${(e: Event) => {
          const select = e.target as HTMLSelectElement;
          const v = Number(select.value);
          const previous = current;
          const sw = select.closest("#ra-app-lock-section")?.querySelector<HTMLInputElement>("#ra-app-lock-enabled");
          const win = window as unknown as { __ccLockSwitchResult?: (applied: boolean) => void };
          // Registered before the call so the shell's answer cannot beat it.
          win.__ccLockSwitchResult = (applied) => {
            delete win.__ccLockSwitchResult;
            select.disabled = hasSwitch && !!sw && !sw.checked;
            if (sw) sw.disabled = !screenLock;
            // A cancelled or failed unlock leaves the old window in force.
            if (applied) current = v;
            else select.value = String(previous);
          };
          let pending = false;
          try { pending = b.setRelockMinutes(v) === false; } catch (err) { console.error("[app-lock] save failed", err); }
          if (pending) {
            // A longer window waits on the fingerprint/PIN. Both controls share
            // the shell's one answer callback, so neither may fire a second request.
            select.disabled = true;
            if (sw) sw.disabled = true;
            return;
          }
          delete win.__ccLockSwitchResult;
          current = v;
        }}>
          ${choices.map((m) => html`<option value=${String(m)} ?selected=${m === current}>${minutesLabel(m)}</option>`)}
        </select>
      </div>
      <p class="ra-caption">How long this phone can be away from the app before it asks again. Reopening the app after Android closed it always asks. "Every time" asks after leaving the app, but not right after picking a photo or file from inside it.</p>
    </div>
  `;
}
