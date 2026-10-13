import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { settingsHeader, navRow, toggleRow } from "./ui";
import { api } from "../../shared/api";
import { showToast } from "../../shared/toast";
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
  let gamingModeOn = false;
  try { gamingModeOn = (await api.getGamingMode()).on; }
  catch (e) { console.error("get_gaming_mode failed", e); }

  const draw = () => {
    render(template(gamingModeOn, onToggleGamingMode), root);
    const burger = root.querySelector<HTMLButtonElement>('[data-burger="true"]');
    if (burger) burger.onclick = () => openSidemenu();
  };

  const onToggleGamingMode = () => {
    void (async () => {
      const next = !gamingModeOn;
      try {
        const v = await api.setGamingMode(next);
        gamingModeOn = v.on;
        showToast(
          gamingModeOn
            ? `Gaming mode on - ${v.paused_sessions} chat(s) parked, ${v.stopped_procs} dev server(s) and ${v.stopped_containers} container(s) stopped.`
            : "Gaming mode off - resuming parked chats and dev servers.",
        );
      } catch (e) {
        console.error("set_gaming_mode failed", e);
        showToast(`Could not toggle gaming mode: ${e}`);
      }
      draw();
    })();
  };

  draw();

  const unlisten = api.onGamingModeChanged((v) => {
    gamingModeOn = v.on;
    draw();
  });

  return () => { unlisten(); };
}

function template(gamingModeOn: boolean, onToggleGamingMode: () => void) {
  const nav = (name: string) => void g().navigateTo(name);
  return html`
    <div class="view view-settings">
      ${settingsHeader("Settings", { burger: true })}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">General</div>
          ${navRow("Appearance", "ph-paint-brush", () => nav("settings-appearance"))}
          ${navRow("Notifications & Sound", "ph-bell", () => nav("settings-notifications"))}
          ${navRow("Characters", "ph-smiley", () => nav("settings-characters"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Chats</div>
          ${navRow("Chat defaults", "ph-chats-circle", () => nav("settings-chat-defaults"))}
          ${navRow("Permissions", "ph-shield-check", () => nav("settings-permissions"))}
          ${navRow("Statusline", "ph-list-dashes", () => nav("settings-statusline"))}
          ${toggleRow({
            label: "Gaming mode",
            inputId: "gamingModeToggle",
            checked: gamingModeOn,
            onChange: onToggleGamingMode,
            tooltip: "Parks every chat (except projects marked “Keep running”) and stops dev servers, Docker containers and Docker Desktop. Flip off to resume everything.",
          })}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Accounts</div>
          ${navRow("Claude accounts", "ph-user-circle", () => nav("settings-accounts"))}
          ${navRow("Remote access", "ph-device-mobile", () => nav("settings-remote-access"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">System</div>
          ${navRow("System", "ph-gear", () => nav("settings-system"))}
          ${navRow("About & updates", "ph-info", () => nav("settings-about"))}
        </div>

      </div>
    </div>
  `;
}
