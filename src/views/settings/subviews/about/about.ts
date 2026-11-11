import { html, render } from "lit-html";
import {
  aboutPage,
  type AboutPageDeps,
  type AboutUpdateDeps,
  type AutoUpdateMode,
} from "../../../../../vendor/tauri_kit/frontend/settings/pages/about";
import { api, type UpdateState } from "../../../../shared/api";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { settingsHeader } from "../../ui";
import { isRemote } from "../../../../shared/transport";
import { readShellVersion } from "../../../../shared/shell-version";

// Same on every platform: the release ends up with a signed darwin-aarch64
// updater entry, so the Mac installs in-app like Windows does. publish-macos adds
// it after Windows ships, so a Mac check made in that gap reports "error", even
// for a Mac already on the newest version (the plugin resolves the platform entry
// before it compares versions). The tray shows a disabled "Update failed" item
// for the same state, and an "On startup" Mac only rechecks on launch or Retry.
export function deriveUpdateDeps(state: UpdateState): AboutUpdateDeps {
  if (state.state === "downloaded") {
    return {
      statusText: "Ready to install",
      statusColor: "var(--color-primary)",
      actionLabel: state.version ? `Install v${state.version}` : "Install & Restart",
      onAction: () => { void api.installUpdate(); },
    };
  }
  if (state.state === "available") {
    return {
      statusText: state.version ? `v${state.version} available` : "Update available",
      actionLabel: state.version ? `Download & Install v${state.version}` : "Download & Install",
      onAction: () => { void api.downloadAndInstall(); },
    };
  }
  if (state.state === "downloading") {
    return { statusText: "Downloading...", statusColor: "var(--sb-muted)" };
  }
  if (state.state === "error") {
    return {
      statusText: "Error",
      statusColor: "#ff4444",
      actionLabel: "Retry",
      onAction: () => { void api.checkForUpdates(); },
    };
  }
  return { statusText: "Up to date" };
}

/** On the phone the kit's version line is the PC's, so both ends are named
 *  here: which PC build answers, and which app build the phone itself runs. */
export function phoneVersionLines(pcVersion: string, shellVersion: string | null): { pc: string; phone: string } {
  const label = (v: string) => (/^\d/.test(v) ? `v${v}` : v);
  return {
    pc: label(pcVersion),
    phone: shellVersion ? label(shellVersion) : "Not reported - update the app from Google Play",
  };
}

function phoneVersions(pcVersion: string) {
  const lines = phoneVersionLines(pcVersion, readShellVersion());
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Versions</div>
      <div class="settings-caption">PC app: <span class="about-pc-version">${lines.pc}</span></div>
      <div class="settings-caption">Phone app: <span class="about-phone-version">${lines.phone}</span></div>
    </div>
  `;
}

export async function renderAboutView(root: HTMLElement): Promise<() => void> {
  let updateState: UpdateState = { state: "up-to-date" };
  const versionInfo = await api.getVersionInfo().catch(() => ({
    version: "unknown",
    build_date: "unknown",
    installed_at: null as string | null,
  }));

  const s = getSettings();
  const rawAutoUpdate = s.autoUpdate;
  const initialAutoUpdate: AutoUpdateMode =
    rawAutoUpdate === true ? "immediate" :
    rawAutoUpdate === false ? "never" :
    (typeof rawAutoUpdate === "string" &&
     (rawAutoUpdate === "never" || rawAutoUpdate === "onStartup" || rawAutoUpdate === "immediate"))
      ? rawAutoUpdate
      : "onStartup";

  const deps: AboutPageDeps = {
    appName: "Claude Conductor",
    version: versionInfo.version,
    buildDate: versionInfo.build_date !== "unknown" ? versionInfo.build_date : undefined,
    installedAt: versionInfo.installed_at ?? undefined,
    developer: {
      name: "SirBepy",
      links: {
        github: "https://github.com/SirBepy",
        youtube: "https://youtube.com/@SirBepy",
      },
    },
    autoUpdate: initialAutoUpdate,
    onAutoUpdateChange: (mode) => {
      deps.autoUpdate = mode;
      // Fresh-read + retry (todo 1004): building from the frontend's own
      // settings cache could revert a concurrent daemon-owned write.
      void updateSettings((fresh) => ({ ...fresh, autoUpdate: mode })).catch((e) => {
        console.error("[about] failed to save autoUpdate", e);
      });
    },
    onCheckNow: async () => {
      await api.checkForUpdates();
    },
    onCopyLogs: async () => {
      await api.copyLogs();
    },
    onBack: () => { void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("settings"); },
    onOpenLink: (url) => { void api.openExternal(url); },
    update: deriveUpdateDeps(updateState),
    onRerender: () => doRender(),
  };

  const page = aboutPage(deps);

  function doRender() {
    render(
      html`
        <div class="view view-settings-about">
          ${settingsHeader("About & updates")}
          <div class="view-body">
            ${page.render()}
            ${isRemote() ? phoneVersions(versionInfo.version) : ""}
          </div>
        </div>
      `,
      root,
    );
  }

  doRender();

  const initialState = await api.getUpdateState().catch(() => null);
  if (initialState) {
    updateState = initialState;
    deps.update = deriveUpdateDeps(updateState);
    doRender();
  }

  const unlisten = api.onUpdateStateChange((state) => {
    updateState = state;
    deps.update = deriveUpdateDeps(updateState);
    doRender();
  });

  return () => { unlisten(); };
}
