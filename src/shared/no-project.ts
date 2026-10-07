/**
 * "No project" chats: a chat that should feel like it was started nowhere
 * still needs a real cwd, so it runs in one designated folder and every
 * surface that would name that folder shows NO_PROJECT_LABEL instead.
 */

export const NO_PROJECT_LABEL = "No project";

export const NO_PROJECT_ICON_HTML = `<i class="ph ph-circle-dashed"></i>`;

// The Obsidian vault is the folder the user already keeps general-purpose
// Claude context in.
const NO_PROJECT_DIR_SUFFIX = /[\\/]documents[\\/]obsidianvault$/i;

export function isNoProjectPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return NO_PROJECT_DIR_SUFFIX.test(path.replace(/[\\/]+$/, ""));
}
