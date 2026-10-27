// "Claude's browser" section of Chat defaults: the switch that gives chats the
// browser_* tools, the opt-in script tool, the browser a chat starts on
// (Claude's own Chrome, or one of Joe's own driven through the
// Claude Conductor Browser Bridge extension; a chat can switch itself with
// browser_target).
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
    <div class="cd-steps">
      <div class="cd-steps-title">Set up the bridge (once)</div>
      <ol>
        <li>Use a separate browser profile made for Claude, signed in only to the accounts you want it to use.</li>
        <li>In that profile, open <code>${EXTENSIONS_PAGE[choice.app]}</code> and turn on <b>Developer mode</b>.</li>
        <li>Click <b>Load unpacked</b>, then pick the folder that <b>Open folder</b> above opens.</li>
        <li>Wait for the status above to read <b>Connected</b>.</li>
      </ol>
      <p>Each chat then works in its own minimized window, and several chats can run at once. Leave <b>Profile folder</b> blank to use the profile you used last.</p>
    </div>
  `;
}

function ownPart(): TemplateResult {
  return html`
    <p class="cd-hint">Its window opens the first time a chat needs it. Sign in to Claude's accounts there, finish any check a chat says it is stuck on, and minimize it when it is in the way.</p>
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
        tooltip: "New chats get the browser tools; an open chat gets them after a respawn. Claude's own browser is a separate Chrome profile for accounts made for Claude, never yours. My browser drives one of yours through the Claude Conductor Browser Bridge extension. Tell any chat \"use my browser\" or \"use your own\" to switch just that chat.",
      })}
      ${toggleRow({
        label: "Script tool",
        inputId: "chatDefaultsBrowserScript",
        checked: choice.script,
        tooltip: "Lets a chat write one short program that does a whole task in the browser (open pages, click, read, repeat) instead of one tool call per click. Faster and cheaper for long jobs. Risk: that program runs on this PC with access to your files, not inside the web page, so keep it off unless you trust the chat with that.",
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

/** Wires the bridge row (My browser mode). */
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
}
