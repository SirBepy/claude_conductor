import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { showToast } from "../../../../shared/toast";
import { isRemote } from "../../../../shared/transport";
import { settingsHeader, toggleRow } from "../../ui";
import { readNightly, wireNightly, nightlySection } from "./nightly";

export async function renderPowerView(root: HTMLElement): Promise<() => void> {
  let gamingModeOn = false;
  try { gamingModeOn = (await api.getGamingMode()).on; }
  catch (e) { console.error("get_gaming_mode failed", e); }

  const nightly = readNightly(getSettings());
  const autostart = !!getSettings().autostart;

  const draw = () => render(template(autostart, nightly, gamingModeOn, onToggleGamingMode), root);

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

  const launchAtLogin = root.querySelector<HTMLInputElement>("#launchAtLogin");
  if (launchAtLogin) launchAtLogin.addEventListener("change", saveSettings);
  wireNightly(root);

  const unlisten = api.onGamingModeChanged((v) => {
    gamingModeOn = v.on;
    draw();
  });

  return () => { unlisten(); };
}

function template(
  autostart: boolean,
  nightly: ReturnType<typeof readNightly>,
  gamingModeOn: boolean,
  onToggleGamingMode: () => void,
) {
  return html`
    <div class="view view-settings-power">
      ${settingsHeader("Power & startup")}
      <div class="view-body">

        ${isRemote() ? "" : html`
        <div class="kit-section">
          <div class="kit-section-title">Startup</div>
          ${toggleRow({ label: "Launch at login", inputId: "launchAtLogin", checked: autostart })}
        </div>
        `}

        ${isRemote() || !navigator.userAgent.includes("Windows") ? "" : nightlySection(nightly)}

        <div class="kit-section">
          <div class="kit-section-title">Gaming mode</div>
          ${toggleRow({
            label: "Gaming mode",
            inputId: "gamingModeToggle",
            checked: gamingModeOn,
            onChange: onToggleGamingMode,
            tooltip: "Parks every chat (except projects marked “Keep running”) and stops dev servers, Docker containers and Docker Desktop. Flip off to resume everything.",
          })}
        </div>

      </div>
    </div>
  `;
}
