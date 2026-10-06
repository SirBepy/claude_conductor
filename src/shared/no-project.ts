/**
 * "No project" chats: a chat that should feel like it was started nowhere
 * still needs a real cwd, so it runs in one designated folder and every
 * surface that would name that folder shows NO_PROJECT_LABEL instead.
 */

import { getSettings } from "./state";

/** Settings key (extra bag) overriding which folder backs "No project". */
export const NO_PROJECT_DIR_SETTINGS_KEY = "noProjectDir";

export const NO_PROJECT_LABEL = "No project";

export const NO_PROJECT_ICON_HTML = `<i class="ph ph-circle-dashed"></i>`;

// Used when the setting is unset: the Obsidian vault is the folder the user
// already keeps general-purpose Claude context in.
const DEFAULT_DIR_SUFFIX = /[\\/]documents[\\/]obsidianvault$/i;

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, "").replaceAll("/", "\\").toLowerCase();
}

export function isNoProjectPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const configured = (getSettings() as Record<string, unknown>)[NO_PROJECT_DIR_SETTINGS_KEY];
  if (typeof configured === "string" && configured.trim()) {
    return normalize(path) === normalize(configured);
  }
  return DEFAULT_DIR_SUFFIX.test(path.replace(/[\\/]+$/, ""));
}
