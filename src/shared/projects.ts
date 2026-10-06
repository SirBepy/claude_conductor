/**
 * Project-path helpers.
 * Ported from src/dashboard.js (renderAvatar, basenameProj)
 * and src/modules/stats.js (projectLabel, isSubagentCwd, isBlacklisted).
 */

import type { AliasMap } from "./tokens";
import { resolveMergeChain } from "./merges";
import { api } from "./api";
import { getCharacterIconUrl } from "./character-icon";
import { escapeHtml } from "./escape-html";
import { isNoProjectPath, NO_PROJECT_ICON_HTML } from "./no-project";

export interface Avatar {
  kind?: "emoji" | "image" | "none" | "character";
  value?: string;
}

export function basenameProj(p: string | null | undefined): string {
  if (!p) return "(unknown)";
  const parts = String(p).split(/[\\/]/);
  return parts.filter(Boolean).pop() || "(unknown)";
}

export function isSubagentCwd(cwd: string | null | undefined): boolean {
  return !!cwd && /[/\\]\.claude[/\\]subagents[/\\]/i.test(cwd);
}

export function isBlacklisted(
  cwd: string,
  aliases: AliasMap,
  blacklist: string[] | null | undefined,
): boolean {
  if (!blacklist || !blacklist.length) return false;
  return blacklist.includes(resolveMergeChain(cwd, aliases));
}

export function projectLabel(cwd: string, aliases: AliasMap): string {
  const alias = aliases[cwd];
  const fallback = cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() || cwd : "(unknown)";
  if (!alias) return fallback;
  const name = alias.name || fallback;
  const emoji = alias.emoji || "";
  return emoji && !name.startsWith(emoji) ? `${emoji} ${name}` : name;
}

// Tech-stack key -> Devicon class (ai_todo 99). Mirrors server_supervisor's map.
// `colored` applies the brand colour where Devicon ships a coloured variant.
const TECH_DEVICON: Record<string, string> = {
  rust: "devicon-rust-plain",
  flutter: "devicon-flutter-plain colored",
  node: "devicon-nodejs-plain colored",
  python: "devicon-python-plain colored",
  go: "devicon-go-original-wordmark colored",
  deno: "devicon-denojs-original",
  dotnet: "devicon-dotnetcore-plain colored",
};

// Lazy per-project-path caches so a re-render never re-hits IPC. undefined =
// not fetched; null = fetched, none found; string = the resolved value.
const projectIconUrlCache = new Map<string, string | null>();
const projectTechCache = new Map<string, string | null>();

export function renderAvatar(avatar: Avatar | undefined | null, projectPath?: string): string {
  if (isNoProjectPath(projectPath)) return NO_PROJECT_ICON_HTML;
  if (!avatar || avatar.kind === "none") {
    // No user-set avatar: render a hydratable project-face placeholder (a
    // generic folder until hydrateProjectTechIcons fills the real icon / tech
    // logo). Falls back to "?" when no path is available to detect against.
    if (projectPath) {
      return `<span class="proj-face" data-proj-face="${escapeHtml(projectPath)}"><i class="ph ph-folder"></i></span>`;
    }
    return "?";
  }
  if (avatar.kind === "emoji") return escapeHtml(avatar.value ?? "");
  if (avatar.kind === "image") {
    const src = `file:///${String(avatar.value).replaceAll("\\", "/")}`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`;
  }
  if (avatar.kind === "character") {
    const id = escapeHtml(avatar.value ?? "");
    return `<img class="char-avatar" data-character-id="${id}" alt="${id}" style="width:100%;height:100%;object-fit:cover;border-radius:7px;image-rendering:pixelated">`;
  }
  return "?";
}

/**
 * Resolves data URLs for any rendered character avatars within `root`.
 * Call after `renderAvatar` output is in the DOM. Idempotent per character id:
 * skips imgs already hydrated for their current `data-character-id`.
 */
export async function hydrateCharacterAvatars(root: HTMLElement | Document = document): Promise<void> {
  const imgs = root.querySelectorAll<HTMLImageElement>("img.char-avatar[data-character-id]");
  for (const img of Array.from(imgs)) {
    const id = img.dataset.characterId;
    if (!id) continue;
    if (img.dataset.hydrated === id) continue;
    try {
      const url = await getCharacterIconUrl(id);
      if (url) {
        img.src = url;
        img.dataset.hydrated = id;
      }
    } catch (e) {
      console.warn("[avatar] failed to load character icon", id, e);
    }
  }
}

/**
 * Fill project-face placeholders (`span.proj-face[data-proj-face]`) rendered by
 * renderAvatar for the no-user-avatar path (ai_todo 99). Three-tier fallback,
 * mirroring server_supervisor: (1) the project's own icon/logo file, (2) a
 * detected tech-stack Devicon logo, (3) leave the generic Phosphor folder.
 * Idempotent per path; results cached so a re-render is instant.
 */
export async function hydrateProjectTechIcons(root: HTMLElement | Document = document): Promise<void> {
  const faces = root.querySelectorAll<HTMLElement>("span.proj-face[data-proj-face]");
  for (const el of Array.from(faces)) {
    const path = el.dataset.projFace;
    if (!path) continue;
    if (el.dataset.hydrated === path) continue;
    el.dataset.hydrated = path; // mark before await so a rapid re-call won't double-fetch
    try {
      // Tier 1: the project's own icon file.
      let iconUrl = projectIconUrlCache.get(path);
      if (iconUrl === undefined) {
        const icon = await api.getProjectIcon(path);
        iconUrl = icon ? `data:${icon.mime};base64,${icon.base64}` : null;
        projectIconUrlCache.set(path, iconUrl);
      }
      if (iconUrl) {
        el.innerHTML = `<img src="${iconUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:7px">`;
        continue;
      }
      // Tier 2: detected tech-stack logo.
      let tech = projectTechCache.get(path);
      if (tech === undefined) {
        tech = (await api.getProjectTech(path)) ?? null;
        projectTechCache.set(path, tech);
      }
      const cls = tech ? TECH_DEVICON[tech] : undefined;
      if (cls) {
        el.innerHTML = `<i class="${cls}"></i>`;
        continue;
      }
      // Tier 3: no icon and no known tech -> keep the generic folder placeholder.
    } catch (e) {
      console.warn("[proj-face] failed to hydrate", path, e);
    }
  }
}
