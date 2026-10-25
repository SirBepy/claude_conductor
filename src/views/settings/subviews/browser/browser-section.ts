// "Claude's browser" section of Chat defaults: the switch that gives chats the
// browser_* tools, the browser a chat starts on (Claude's own off-screen Chrome
// or one of Joe's own, driven through the Playwright extension he approves; a
// chat can switch itself with browser_target), and the button that brings the
// daemon's Chrome onto this screen so Joe can sign in or clear a CAPTCHA for
// Claude.
import { html, type TemplateResult } from "lit-html";
import { api } from "../../../../shared/api";
import { toggleRow } from "../../ui";

export const BROWSER_SETTING_KEY = "claudeBrowserEnabled";
export const BROWSER_MODE_KEY = "claudeBrowserMode";
export const BROWSER_APP_KEY = "claudeBrowserMineApp";
export const BROWSER_PROFILE_KEY = "claudeBrowserMineProfile";

export const BROWSER_EXT_PAIRING_MAP_KEY = "claudeBrowserExtensionTokens";
export const BROWSER_EXT_PAIRING_INPUT_ID = "chatDefaultsBrowserToken";

export type BrowserMode = "own" | "mine";
export type BrowserApp = "chrome" | "edge" | "brave";

export interface BrowserChoice {
  enabled: boolean;
  mode: BrowserMode;
  app: BrowserApp;
  /** Profile folder name ("Default", "Profile 1"); blank lets the browser pick its last used. */
  profile: string;
  /** Playwright extension token per "<app>/<profile folder>"; each extension install has its own. */
  tokens: Record<string, string>;
}

/** Same key the daemon looks up (`token_key` in browser/target.rs). */
export function tokenKey(app: BrowserApp, profile: string): string {
  return `${app}/${profile.trim()}`;
}

/** The Playwright extension's store page, from the pinned @playwright/mcp's own install hint. */
const EXTENSION_URL = "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

export function readBrowserChoice(settings: Record<string, unknown>): BrowserChoice {
  const app = settings[BROWSER_APP_KEY];
  const profile = settings[BROWSER_PROFILE_KEY];
  const rawTokens = settings[BROWSER_EXT_PAIRING_MAP_KEY];
  const tokens: Record<string, string> = {};
  if (rawTokens && typeof rawTokens === "object") {
    for (const [k, v] of Object.entries(rawTokens)) if (typeof v === "string") tokens[k] = v;
  }
  return {
    tokens,
    enabled: settings[BROWSER_SETTING_KEY] === true,
    mode: settings[BROWSER_MODE_KEY] === "mine" ? "mine" : "own",
    app: app === "edge" || app === "brave" ? app : "chrome",
    profile: typeof profile === "string" ? profile : "",
  };
}

/** Reads the section's live controls, keeping `prev` for any control the
 *  current mode does not render (the app and profile rows exist only in My browser).
 *  The token input shows the token of the app and profile it was drawn for, so it
 *  is saved only when it is what changed; after an app/profile change the page is
 *  redrawn with the new pair's token. */
export function readBrowserFields(root: HTMLElement, prev: BrowserChoice, changedId?: string): BrowserChoice {
  const app = root.querySelector<HTMLSelectElement>("#chatDefaultsBrowserApp")?.value;
  const mode = root.querySelector<HTMLSelectElement>("#chatDefaultsBrowserMode")?.value;
  const tokens = { ...prev.tokens };
  const tokenInput = root.querySelector<HTMLInputElement>(`#${BROWSER_EXT_PAIRING_INPUT_ID}`);
  if (tokenInput && changedId === BROWSER_EXT_PAIRING_INPUT_ID) {
    const key = tokenKey(prev.app, prev.profile);
    const value = tokenInput.value.trim();
    if (value) tokens[key] = value;
    else delete tokens[key];
  }
  return {
    tokens,
    enabled: root.querySelector<HTMLInputElement>("#chatDefaultsBrowser")?.checked ?? prev.enabled,
    mode: mode === undefined ? prev.mode : mode === "mine" ? "mine" : "own",
    app: app === "edge" || app === "brave" || app === "chrome" ? app : prev.app,
    profile: root.querySelector<HTMLInputElement>("#chatDefaultsBrowserProfile")?.value.trim() ?? prev.profile,
  };
}

export function browserSettingsPatch(choice: BrowserChoice): Record<string, unknown> {
  return {
    [BROWSER_SETTING_KEY]: choice.enabled,
    [BROWSER_MODE_KEY]: choice.mode,
    [BROWSER_APP_KEY]: choice.app,
    [BROWSER_PROFILE_KEY]: choice.profile,
    [BROWSER_EXT_PAIRING_MAP_KEY]: choice.tokens,
  };
}

function minePart(choice: BrowserChoice): TemplateResult {
  return html`
    <div class="kit-row">
      <span class="kit-row-label">Browser</span>
      <select id="chatDefaultsBrowserApp" class="kit-select">
        <option value="chrome" ?selected=${choice.app === "chrome"}>Chrome</option>
        <option value="edge" ?selected=${choice.app === "edge"}>Edge</option>
        <option value="brave" ?selected=${choice.app === "brave"}>Brave</option>
      </select>
    </div>
    <div class="kit-row">
      <span class="kit-row-label">Profile folder</span>
      <input
        type="text"
        id="chatDefaultsBrowserProfile"
        class="cd-profile-input"
        .value=${choice.profile}
        placeholder="Last used"
        spellcheck="false"
      >
    </div>
    <div class="kit-row">
      <span class="kit-row-label">Extension token</span>
      <input
        type="password"
        id="${BROWSER_EXT_PAIRING_INPUT_ID}"
        class="cd-profile-input"
        .value=${choice.tokens[tokenKey(choice.app, choice.profile)] ?? ""}
        placeholder="Paste from connect page"
        autocomplete="off"
        spellcheck="false"
      >
    </div>
    <div class="kit-row">
      <span class="kit-row-label">Playwright extension</span>
      <button type="button" class="btn-secondary" id="chatDefaultsBrowserInstall">Install page</button>
    </div>
    <p class="cd-hint">Used when a chat starts on, or is told to switch to, your browser. Install the extension once in that browser. Each chat opens a connect page there for you to approve, so Claude acts with your real sign-ins only after you say yes. Leave the profile blank to use the one you used last, or name a folder such as Profile 1 to point Claude at a dedicated profile. Every profile's extension has its own token: paste the one shown on its connect page into Extension token for that browser and profile (blank profile covers the browser's last-used one).</p>
  `;
}

function ownPart(): TemplateResult {
  return html`
    <div class="kit-row">
      <span class="kit-row-label">Browser window</span>
      <button type="button" class="btn-secondary" id="chatDefaultsBrowserShow">Show</button>
    </div>
    <p class="cd-hint">Sign in to Claude's accounts here, and finish any check a chat says it is stuck on.</p>
  `;
}

export function browserSectionTemplate(choice: BrowserChoice): TemplateResult {
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Claude's browser</div>
      ${toggleRow({
        label: "Let chats use a browser",
        inputId: "chatDefaultsBrowser",
        checked: choice.enabled,
        tooltip: "New chats get the browser tools; an open chat gets them after a respawn. Claude's own browser is a separate Chrome profile for accounts made for Claude, never yours, and runs off-screen. My browser drives one of yours through the Playwright extension. Tell any chat \"use my browser\" or \"use your own\" to switch just that chat.",
      })}
      <div class="kit-row">
        <span class="kit-row-label">Chats start on</span>
        <select id="chatDefaultsBrowserMode" class="kit-select">
          <option value="own" ?selected=${choice.mode === "own"}>Claude's own</option>
          <option value="mine" ?selected=${choice.mode === "mine"}>My browser</option>
        </select>
      </div>
      ${choice.mode === "mine" ? minePart(choice) : ownPart()}
    </div>
  `;
}

/** Wires the Show/Hide button. The label follows the daemon's own view of
 *  the window, so a browser left shown from an earlier visit reads "Hide". */
export function wireBrowserSection(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>("#chatDefaultsBrowserInstall")?.addEventListener("click", () => {
    void api.openExternal(EXTENSION_URL).catch((e: unknown) => { console.warn("open_external failed", e); });
  });
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
