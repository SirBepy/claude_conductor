import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { settingsHeader, navRow } from "./ui";
import { isRemote } from "../../shared/transport";
import "./settings.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderSettingsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);
  const burger = root.querySelector<HTMLButtonElement>('[data-burger="true"]');
  if (burger) burger.onclick = () => openSidemenu();
  return () => { /* nothing to tear down */ };
}

function template() {
  const nav = (name: string) => void g().navigateTo(name);
  // Usage meter, Claude's browser and Data & storage gate every control behind
  // !isRemote(), so on the phone their rows would open an empty page. Shortcuts
  // are keyboard bindings, which a phone has no use for.
  const desktop = !isRemote();
  return html`
    <div class="view view-settings">
      ${settingsHeader("Settings", { burger: true })}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Look &amp; sound</div>
          ${navRow("Appearance", "ph-paint-brush", () => nav("settings-appearance"))}
          ${desktop ? navRow("Usage meter", "ph-gauge", () => nav("settings-usage-meter")) : ""}
          ${navRow("Notifications", "ph-bell", () => nav("settings-notifications"))}
          ${navRow("Voice & dictation", "ph-microphone", () => nav("settings-voice"))}
          ${navRow("Characters", "ph-smiley", () => nav("settings-characters"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Chats</div>
          ${navRow("Chat defaults", "ph-chats-circle", () => nav("settings-chat-defaults"))}
          ${navRow("Permissions", "ph-shield-check", () => nav("settings-permissions"))}
          ${desktop ? navRow("Claude's browser", "ph-browser", () => nav("settings-browser")) : ""}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Accounts</div>
          ${navRow("Claude accounts & API keys", "ph-user-circle", () => nav("settings-accounts"))}
          ${navRow("Remote access", "ph-device-mobile", () => nav("settings-remote-access"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">System</div>
          ${navRow("Power & startup", "ph-power", () => nav("settings-power"))}
          ${desktop ? navRow("Shortcuts", "ph-keyboard", () => nav("settings-shortcuts")) : ""}
          ${desktop ? navRow("Data & storage", "ph-database", () => nav("settings-data")) : ""}
          ${navRow("About & updates", "ph-info", () => nav("settings-about"))}
        </div>

      </div>
    </div>
  `;
}
