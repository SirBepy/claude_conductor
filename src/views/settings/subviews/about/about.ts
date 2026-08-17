import { html, render } from "lit-html";
import {
  aboutPage,
  type AboutPageDeps,
  type AboutUpdateDeps,
  type AutoUpdateMode,
} from "../../../../../vendor/tauri_kit/frontend/settings/pages/about";
import { api, type UpdateState } from "../../../../shared/api";
import { getSettings, setSettings } from "../../../../shared/state";
import { settingsHeader } from "../../ui";

function deriveUpdateDeps(state: UpdateState, isMac: boolean): AboutUpdateDeps {
  if (isMac && (state.state === "available" || state.state === "downloading" ||
      state.state === "downloaded" || state.state === "error")) {
    return {
      statusText: state.version ? `v${state.version} available` : "Update available",
      actionLabel: "Download from GitHub",
      onAction: () => {
        if (state.version) {
          void api.openExternal(
            `https://github.com/SirBepy/claude_conductor/releases/tag/v${state.version}`,
          );
        }
      },
    };
  }
  if (state.state === "downloaded") {
    return {
      statusText: "Ready to install",
      statusColor: "var(--primary)",
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
    return { statusText: "Downloading...", statusColor: "var(--text-dim)" };
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

export async function renderAboutView(root: HTMLElement): Promise<() => void> {
  const platform = await api.getPlatform();
  const isMac = platform === "darwin";

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
      : "immediate";

  const deps: AboutPageDeps = {
    appName: "Claude Companion",
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
      const updated = { ...getSettings(), autoUpdate: mode };
      setSettings(updated);
      void api.saveSettings(updated);
    },
    onCheckNow: async () => {
      await api.checkForUpdates();
    },
    onCopyLogs: async () => {
      await api.copyLogs();
    },
    onBack: () => { void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("settings"); },
    onOpenLink: (url) => { void api.openExternal(url); },
    update: deriveUpdateDeps(updateState, isMac),
    onRerender: () => doRender(),
  };

  const page = aboutPage(deps);

  function doRender() {
    render(
      html`
        <div class="view view-settings">
          ${settingsHeader("About & updates")}
          <div class="view-body">
            ${page.render()}
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
    deps.update = deriveUpdateDeps(updateState, isMac);
    doRender();
  }

  const unlisten = api.onUpdateStateChange((state) => {
    updateState = state;
    deps.update = deriveUpdateDeps(updateState, isMac);
    doRender();
  });

  return () => { unlisten(); };
}
