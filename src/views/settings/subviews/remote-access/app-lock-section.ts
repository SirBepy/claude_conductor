import { html, type TemplateResult } from "lit-html";

// The Android app's fingerprint/PIN lock window. Stored on the phone by the
// shell (window.ConductorLock), so it only shows inside the Android app. The
// shell's AppLockPolicy owns the allowed values and the default; a value it does
// not know reads back as its default.

interface LockBridge {
  getRelockMinutes(): number;
  setRelockMinutes(minutes: number): void;
}

const CHOICES: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Every time" },
  { minutes: 1, label: "After 1 minute" },
  { minutes: 5, label: "After 5 minutes" },
  { minutes: 10, label: "After 10 minutes" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
];

function bridge(): LockBridge | null {
  const b = (window as unknown as { ConductorLock?: Partial<LockBridge> }).ConductorLock;
  return typeof b?.getRelockMinutes === "function" && typeof b.setRelockMinutes === "function"
    ? (b as LockBridge)
    : null;
}

export function appLockSectionTemplate(): TemplateResult | string {
  const b = bridge();
  if (!b) return "";
  let current = 10;
  try { current = b.getRelockMinutes(); } catch { /* keep the shell's default */ }
  return html`
    <div class="kit-section" id="ra-app-lock-section">
      <div class="kit-section-title">App lock</div>
      <div class="kit-row">
        <span class="kit-row-label">Ask for fingerprint</span>
        <select id="ra-app-lock-minutes" class="kit-select" @change=${(e: Event) => {
          const v = Number((e.target as HTMLSelectElement).value);
          try { b.setRelockMinutes(v); } catch (err) { console.error("[app-lock] save failed", err); }
        }}>
          ${CHOICES.map((c) => html`<option value=${String(c.minutes)} ?selected=${c.minutes === current}>${c.label}</option>`)}
        </select>
      </div>
      <p class="ra-caption">How long this phone can be away from the app before it asks again. Reopening the app after Android closed it always asks.</p>
    </div>
  `;
}
