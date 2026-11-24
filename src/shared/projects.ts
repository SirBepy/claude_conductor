/**
 * Project-path helpers.
 * Ported from src/dashboard.js (renderAvatar, basenameProj)
 * and src/modules/stats.js (projectLabel, isSubagentCwd, isBlacklisted).
 */

import type { AliasMap } from "./tokens";
import { monogramStyle, monogramText } from "./monogram";
import { resolveMergeChain } from "./merges";
import { api } from "./api";
import { getCharacterIconUrl } from "./character-icon";
import { escapeHtml } from "./escape-html";
import { isNoProjectPath, NO_PROJECT_ICON_HTML } from "./no-project";
import { dropPersistedProjectIcon, persistProjectIcon, readPersistedProjectIcon } from "./project-icon-store";
import { isRemote } from "./transport";

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
// not fetched; null = fetched, none found; string = the resolved value. Keyed
// by `machineId|path` so an identical-looking path on two different machines
// (unlikely, but possible) never shares a cache entry.
const projectIconUrlCache = new Map<string, string | null>();
const projectTechCache = new Map<string, string | null>();
const cacheKey = (path: string, machineId: string | null): string => `${machineId ?? ""}|${path}`;

export function renderAvatar(
  avatar: Avatar | undefined | null,
  projectPath?: string,
  machineId?: string | null,
): string {
  if (isNoProjectPath(projectPath)) return NO_PROJECT_ICON_HTML;
  if (!avatar || avatar.kind === "none") {
    // No user-set avatar: render a hydratable project-face placeholder (a
    // generic folder until hydrateProjectTechIcons fills the real icon / tech
    // logo). Falls back to "?" when no path is available to detect against.
    if (projectPath) {
      // `machineId` names the paired peer whose filesystem `projectPath`
      // lives on (multi-machine federation) - omitted for every local path,
      // same as before this attribute existed.
      const machineAttr = machineId ? ` data-proj-face-machine="${escapeHtml(machineId)}"` : "";
      return `<span class="proj-face" data-proj-face="${escapeHtml(projectPath)}"${machineAttr}><i class="ph ph-folder"></i></span>`;
    }
    return "?";
  }
  if (avatar.kind === "emoji") return escapeHtml(avatar.value ?? "");
  if (avatar.kind === "image") {
    const src = escapeHtml(`file:///${String(avatar.value).replaceAll("\\", "/")}`);
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

function paintProjectIcon(el: HTMLElement, url: string): void {
  el.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:7px">`;
}

const iconDataUrl = (icon: { mime: string; base64: string }): string => `data:${icon.mime};base64,${icon.base64}`;

/** Keys already asked about since this page loaded: one hash check per project per load. */
const checkedIcons = new Set<string>();
/** Kept icons painted but not yet checked against the daemon. */
const pendingHashChecks = new Map<string, { path: string; machineId: string | null; hash: string }>();

function startHashCheck(key: string): void {
  const pending = pendingHashChecks.get(key);
  if (!pending) return;
  pendingHashChecks.delete(key);
  void revalidateProjectIcon(pending.path, pending.machineId, key, pending.hash);
}

/**
 * The project's icon as a data URL, or null when it has none. On the phone the body is
 * kept between page loads (project-icon-store.ts): a kept icon paints at once, and one
 * `get_project_icon` call carrying its hash runs behind it, which costs a few bytes when
 * the file is unchanged and swaps in the new icon (and drops a deleted one) when it is not.
 * Everywhere else the daemon is local and the icon is fetched as before.
 */
async function resolveProjectIconUrl(path: string, machineId: string | null, key: string): Promise<string | null> {
  if (!isRemote()) {
    const icon = await api.getProjectIcon(path, machineId);
    return icon && icon.base64 ? iconDataUrl(icon as { mime: string; base64: string }) : null;
  }
  const kept = await readPersistedProjectIcon(key);
  if (kept) {
    pendingHashChecks.set(key, { path, machineId, hash: kept.hash });
    return kept.url;
  }
  const icon = await api.getProjectIcon(path, machineId);
  if (!icon || !icon.base64) return null;
  const url = iconDataUrl(icon as { mime: string; base64: string });
  if (icon.hash) void persistProjectIcon(key, { hash: icon.hash, url });
  return url;
}

async function revalidateProjectIcon(path: string, machineId: string | null, key: string, heldHash: string): Promise<void> {
  if (checkedIcons.has(key)) return;
  checkedIcons.add(key);
  try {
    const answer = await api.getProjectIcon(path, machineId, heldHash);
    if (answer?.unchanged) return;
    const url = answer && answer.base64 ? iconDataUrl(answer as { mime: string; base64: string }) : null;
    projectIconUrlCache.set(key, url);
    if (url && answer?.hash) void persistProjectIcon(key, { hash: answer.hash, url });
    if (!url) void dropPersistedProjectIcon(key);
    // Faces already on screen were painted from the kept copy.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("span.proj-face[data-proj-face]"))) {
      if (cacheKey(el.dataset.projFace ?? "", el.dataset.projFaceMachine ?? null) !== key) continue;
      if (url) paintProjectIcon(el, url);
      else {
        // The icon is gone: let the next hydrate pass pick the tech logo or the folder.
        delete el.dataset.hydrated;
        el.innerHTML = '<i class="ph ph-folder"></i>';
      }
    }
  } catch {
    // A failed check keeps the copy on screen; the next page load asks again.
    checkedIcons.delete(key);
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
    const machineId = el.dataset.projFaceMachine ?? null;
    const key = cacheKey(path, machineId);
    if (el.dataset.hydrated === key) continue;
    el.dataset.hydrated = key; // mark before await so a rapid re-call won't double-fetch
    try {
      // Tier 1: the project's own icon file.
      let iconUrl = projectIconUrlCache.get(key);
      if (iconUrl === undefined) {
        iconUrl = await resolveProjectIconUrl(path, machineId, key);
        projectIconUrlCache.set(key, iconUrl);
      }
      if (iconUrl) {
        paintProjectIcon(el, iconUrl);
        // After the paint, so a changed icon the check brings back is not overwritten by this one.
        startHashCheck(key);
        continue;
      }
      // A face that asks for a monogram (a chat head) skips the tech logo: two letters on a
      // colour from the path tell two projects of one stack apart, a Rust crate's gear does not.
      const monoName = el.dataset.projMono;
      if (monoName !== undefined) {
        el.classList.add("is-monogram");
        el.setAttribute("style", monogramStyle(path));
        el.textContent = monogramText(monoName || path);
        continue;
      }
      // Tier 2: detected tech-stack logo.
      let tech = projectTechCache.get(key);
      if (tech === undefined) {
        tech = (await api.getProjectTech(path, machineId)) ?? null;
        projectTechCache.set(key, tech);
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
