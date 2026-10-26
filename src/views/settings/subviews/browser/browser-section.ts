// "Claude's browser" section of Chat defaults: the switch that gives chats the
// browser_* tools, the opt-in script tool, the browser a chat starts on
// (Claude's own off-screen Chrome, or one of Joe's own driven through the
// Claude Conductor Browser Bridge extension; a chat can switch itself with
// browser_target), and the button that brings the daemon's Chrome onto this
// screen so Joe can sign in or clear a CAPTCHA for Claude.
import { html, type TemplateResult } from "lit-html";
import { api } from "../../../../shared/api";
import { toggleRow } from "../../ui";

export const BROWSER_SETTING_KEY = "claudeBrowserEnabled";
export const BROWSER_SCRIPT_KEY = "claudeBrowserScriptTool";
export const BROWSER_MODE_KEY = "claudeBrowserMode";
export const BROWSER_APP_KEY = "claudeBrowserMineApp";
export const BROWSER_PROFILE_KEY = "claudeBrowserMineProfile";

export type BrowserMode = "own" | "mine";
export type BrowserApp = "chrome" | "edge" | "brave";

export interface BrowserChoice {
  enabled: boolean;
  script: boolean;
  mode: BrowserMode;
  app: BrowserApp;
  /** Profile folder name ("Default", "Profile 1"); blank lets the browser pick its last used. */
  profile: string;
}

export function readBrowserChoice(settings: Record<string, unknown>): BrowserChoice {
  const app = settings[BROWSER_APP_KEY];
  const profile = settings[BROWSER_PROFILE_KEY];
  return {
    enabled: settings[BROWSER_SETTING_KEY] === true,
    script: settings[BROWSER_SCRIPT_KEY] === true,
    mode: settings[BROWSER_MODE_KEY] === "mine" ? "mine" : "own",
    app: app === "edge" || app === "brave" ? app : "chrome",
    profile: typeof profile === "string" ? profile : "",
  };
}

/** Reads the section's live controls, keeping `prev` for any control the
 *  current mode does not render (the app and profile rows exist only in My browser). */
export function readBrowserFields(root: HTMLElement, prev: BrowserChoice): BrowserChoice {
  const app = root.querySelector<HTMLSelectElement>("#chatDefaultsBrowserApp")?.value;
  const mode = root.querySelector<HTMLSelectElement>("#chatDefaultsBrowserMode")?.value;
  return {
    enabled: root.querySelector<HTMLInputElement>("#chatDefaultsBrowser")?.checked ?? prev.enabled,
    script: root.querySelector<HTMLInputElement>("#chatDefaultsBrowserScript")?.checked ?? prev.script,
    mode: mode === undefined ? prev.mode : mode === "mine" ? "mine" : "own",
    app: app === "edge" || app === "brave" || app === "chrome" ? app : prev.app,
    profile: root.querySelector<HTMLInputElement>("#chatDefaultsBrowserProfile")?.value.trim() ?? prev.profile,
  };
}

export function browserSettingsPatch(choice: BrowserChoice): Record<string, unknown> {
  return {
    [BROWSER_SETTING_KEY]: choice.enabled,
    [BROWSER_SCRIPT_KEY]: choice.script,
    [BROWSER_MODE_KEY]: choice.mode,
    [BROWSER_APP_KEY]: choice.app,
    [BROWSER_PROFILE_KEY]: choice.profile,
  };
}

const EXTENSIONS_PAGE: Record<BrowserApp, string> = {
  chrome: "chrome://extensions",
  edge: "edge://extensions",
  brave: "brave://extensions",
};

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
      <span class="kit-row-label">Bridge extension</span>
      <span class="cd-bridge-status" id="chatDefaultsBrowserBridge">Checking...</span>
      <button type="button" class="btn-secondary" id="chatDefaultsBrowserExtFolder">Open folder</button>
    </div>
    <p class="cd-hint">Best set up as a separate profile made for Claude, signed in only to the accounts you want it to use. Install the bridge once in that profile: open ${EXTENSIONS_PAGE[choice.app]}, turn on Developer mode, click Load unpacked and pick the folder this button opens. Each chat then works in a minimized window of its own there, and several chats can work at once. Leave the profile blank to use the one you used last.</p>
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
        tooltip: "New chats get the browser tools; an open chat gets them after a respawn. Claude's own browser is a separate Chrome profile for accounts made for Claude, never yours, and runs off-screen. My browser drives one of yours through the Claude Conductor Browser Bridge extension. Tell any chat \"use my browser\" or \"use your own\" to switch just that chat.",
      })}
      ${toggleRow({
        label: "Script tool",
        inputId: "chatDefaultsBrowserScript",
        checked: choice.script,
        tooltip: "Also gives chats a tool that runs a whole Playwright script in one call: fewer steps and less context for long tasks. The script runs on this PC with file access, outside the page sandbox, so leave it off unless you want that trade.",
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

/** Wires the Show/Hide button and the bridge row. The Show label follows the
 *  daemon's own view of the window, so a browser left shown from an earlier
 *  visit reads "Hide". */
export function wireBrowserSection(root: HTMLElement): void {
  const status = api.browserStatus();
  const bridge = root.querySelector<HTMLElement>("#chatDefaultsBrowserBridge");
  const folder = root.querySelector<HTMLButtonElement>("#chatDefaultsBrowserExtFolder");
  let extensionDir: string | null = null;
  void status
    .then((s) => {
      extensionDir = s.extensionDir ?? null;
      const connected = s.bridgeConnected ?? [];
      if (bridge) bridge.textContent = connected.length ? `Connected: ${connected.join(", ")}` : "Not connected";
      if (folder) folder.disabled = !extensionDir;
    })
    .catch(() => { if (bridge) bridge.textContent = ""; });
  folder?.addEventListener("click", () => {
    if (extensionDir) void api.openInExplorer(extensionDir);
  });

  const btn = root.querySelector<HTMLButtonElement>("#chatDefaultsBrowserShow");
  if (!btn) return;
  let shown = false;
  const paint = (): void => { btn.textContent = shown ? "Hide" : "Show"; };
  void status.then((s) => { shown = s.shown; paint(); }).catch(() => {});
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
