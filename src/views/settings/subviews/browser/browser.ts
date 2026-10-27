import { html, render } from "lit-html";
import { getSettings } from "../../../../shared/state";
import { updateSettings } from "../../../../shared/settings-update";
import { isRemote } from "../../../../shared/transport";
import { attachTooltips } from "../../../../shared/row-tooltip";
import { settingsHeader } from "../../ui";
import {
  browserSectionTemplate,
  browserSettingsPatch,
  readBrowserChoice,
  readBrowserFields,
  wireBrowserSection,
  type BrowserChoice,
} from "./browser-section";
import "./browser.css";

// The whole page is desktop-only: the Show button would open a window on the
// PC, and every control persists through updateSettings, which the daemon
// refuses from the phone.
function template(browser: BrowserChoice) {
  return html`
    <div class="view view-settings-browser">
      ${settingsHeader("Claude's browser")}
      <div class="view-body">
        ${isRemote() ? "" : browserSectionTemplate(browser)}
      </div>
    </div>
  `;
}

export async function renderBrowserView(root: HTMLElement): Promise<() => void> {
  let browser = readBrowserChoice(getSettings());

  render(template(browser), root);
  if (isRemote()) return () => {};
  wireBrowserSection(root);
  // The info icons only show their text once this is wired.
  attachTooltips(document.getElementById("app") || document.body, { placement: "above" });

  // Fresh-read + retry: building from the frontend's own settings
  // cache could revert a concurrent daemon-owned write.
  async function persist(): Promise<void> {
    browser = readBrowserFields(root, browser);
    await updateSettings((fresh) => ({ ...fresh, ...browserSettingsPatch(browser) }));
  }

  // The app and profile rows exist only in My browser mode, so the section
  // is delegated from root and redrawn when the mode flips.
  const onChange = (e: Event) => {
    const id = (e.target as HTMLElement | null)?.id ?? "";
    if (!id.startsWith("chatDefaultsBrowser")) return;
    // The app names its own extensions page in the setup hint.
    const redraw = id === "chatDefaultsBrowserMode" || id === "chatDefaultsBrowserApp";
    void persist().then(() => {
      if (!redraw) return;
      render(template(browser), root);
      wireBrowserSection(root);
    });
  };
  root.addEventListener("change", onChange);

  // A text field's change event waits for blur, so typing a profile and
  // refreshing straight away lost it; save shortly after the last keystroke.
  let typing: ReturnType<typeof setTimeout> | undefined;
  const onInput = (e: Event) => {
    if ((e.target as HTMLElement | null)?.id !== "chatDefaultsBrowserProfile") return;
    clearTimeout(typing);
    typing = setTimeout(() => { void persist(); }, 400);
  };
  root.addEventListener("input", onInput);

  return () => {
    clearTimeout(typing);
    root.removeEventListener("change", onChange);
    root.removeEventListener("input", onInput);
  };
}
