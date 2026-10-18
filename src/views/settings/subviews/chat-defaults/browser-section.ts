// "Claude's browser" section of Chat defaults: the switch that gives chats the
// browser_* tools, and the button that brings the daemon's off-screen Chrome
// onto this screen so Joe can sign in or clear a CAPTCHA for Claude.
import { html, type TemplateResult } from "lit-html";
import { api } from "../../../../shared/api";
import { toggleRow } from "../../ui";

export const BROWSER_SETTING_KEY = "claudeBrowserEnabled";

export function readBrowserEnabled(settings: Record<string, unknown>): boolean {
  return settings[BROWSER_SETTING_KEY] === true;
}

export function browserSectionTemplate(enabled: boolean): TemplateResult {
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Claude's browser</div>
      ${toggleRow({
        label: "Let chats use Claude's own browser",
        inputId: "chatDefaultsBrowser",
        checked: enabled,
        tooltip: "A separate Chrome profile for accounts made for Claude, never yours. It runs off-screen. New chats get the browser tools; an open chat gets them after a respawn.",
      })}
      <div class="kit-row">
        <span class="kit-row-label">Browser window</span>
        <button type="button" class="btn-secondary" id="chatDefaultsBrowserShow">Show</button>
      </div>
      <p class="cd-hint">Sign in to Claude's accounts here, and finish any check a chat says it is stuck on.</p>
    </div>
  `;
}

/** Wires the Show/Hide button. The label follows the daemon's own view of
 *  the window, so a browser left shown from an earlier visit reads "Hide". */
export function wireBrowserSection(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>("#chatDefaultsBrowserShow");
  if (!btn) return;
  let shown = false;
  const paint = (): void => { btn.textContent = shown ? "Hide" : "Show"; };
  void api.browserStatus().then((s) => { shown = s.shown; paint(); }).catch(() => {});
  btn.addEventListener("click", () => {
    const next = !shown;
    btn.disabled = true;
    btn.textContent = next ? "Opening..." : "Hiding...";
    api.browserSetShown(next)
      .then(() => { shown = next; })
      .catch((e: unknown) => { console.warn("browser_set_shown failed", e); })
      .finally(() => { btn.disabled = false; paint(); });
  });
}
