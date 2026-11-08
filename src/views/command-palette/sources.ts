// Where the palette's rows come from. Each source reads live state at open time
// and returns plain PaletteCommands, so the palette itself knows nothing about
// shortcuts, chats or settings.

import * as shortcuts from "../../shared/shortcuts";
import { modelShortcutLabel, modelShortcutSlot } from "../../shared/model-shortcuts";
import { SHORTCUT_RANGES } from "../../shared/shortcuts";
import { showView } from "../../shared/navigation";
import { isRemote } from "../../shared/transport";
import { invoke } from "../../shared/ipc";
import { state } from "../sessions/state";
import { isSubchat, loadHiddenSessions, projectName, sessionSubtitle } from "../sessions/sessions-helpers";
import { openChatById, startNewChatInProject } from "../sessions/session-controls";
import { projectGroupsData, resolveCached } from "../sessions/new-session-cache";
import { liveChatMenuCtx } from "../sessions/chat-menu-ctx";
import { PENDING_SESSION_ID_PREFIX } from "../../shared/chat/pending-session-id";
import {
  buildAgentItems,
  buildChatItems,
  buildConfigureItems,
  buildOpenProjectItems,
  type ItemDesc,
} from "../sessions/chat-menu-items";
import type { BranchEntry } from "../../types/ipc.generated";
import { SETTINGS_PAGES, SETTING_ENTRIES } from "./settings-index";
import { focusSettingRow } from "./settings-focus";
import type { PaletteCommand } from "./types";

// ── Shortcuts ───────────────────────────────────────────────────────────────

// Not worth a row: the palette itself, Escape-in-composer, and the numbered
// families, which "Switch chat" and "New chat in" cover by name instead.
const SKIPPED_SHORTCUTS = new Set(["command-palette", "blur-composer"]);

export function shortcutCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const def of shortcuts.getAll()) {
    if (SKIPPED_SHORTCUTS.has(def.id)) continue;
    if (SHORTCUT_RANGES.some((r) => def.id.startsWith(r.prefix))) continue;
    if (!shortcuts.hasHandler(def.id)) continue;
    let title = def.label;
    const slot = modelShortcutSlot(def.id);
    if (slot !== null) {
      // A model slot is named after what it picks now; one past the list picks nothing.
      const live = modelShortcutLabel(slot);
      if (!live) continue;
      title = live;
    }
    out.push({
      id: `shortcut:${def.id}`,
      title,
      group: "Shortcut",
      icon: "keyboard",
      detail: def.description,
      keys: shortcuts.getBinding(def.id) || undefined,
      run: () => shortcuts.fire(def.id),
    });
  }
  return out;
}

// ── Settings ────────────────────────────────────────────────────────────────

export function settingsCommands(): PaletteCommand[] {
  const phone = isRemote();
  const pages = SETTINGS_PAGES.filter((p) => !(phone && p.desktopOnly));
  const out: PaletteCommand[] = pages.map((p) => ({
    id: `settings:${p.route}`,
    title: `Settings: ${p.title}`,
    group: "Settings",
    icon: p.icon,
    keywords: p.keywords,
    run: () => showView(p.route),
  }));
  for (const e of SETTING_ENTRIES) {
    const page = pages.find((p) => p.route === e.route);
    if (!page) continue;
    out.push({
      id: `setting:${e.route}:${e.label}`,
      title: e.label,
      group: "Setting",
      icon: "sliders-horizontal",
      detail: `Settings › ${page.title}`,
      keywords: e.keywords,
      run: () => {
        showView(e.route);
        void focusSettingRow(e.label);
      },
    });
  }
  return out;
}

// ── Chats and projects ──────────────────────────────────────────────────────

export function chatCommands(): PaletteCommand[] {
  const hidden = loadHiddenSessions();
  const live = state.sessions.filter((s) => !s.ended_at && !isSubchat(s));
  // The sidebar's own order, so the first rows match what Ctrl+1..9 would open.
  const order = new Map(state.sortedSessionIds.map((id, i) => [id, i]));
  live.sort((a, b) => (order.get(a.session_id) ?? Infinity) - (order.get(b.session_id) ?? Infinity));
  return live.map((s) => ({
    id: `chat:${s.session_id}`,
    title: sessionSubtitle(s),
    group: "Chat",
    icon: "chat-circle",
    detail: hidden.has(s.session_id) ? `${projectName(s)} (hidden)` : projectName(s),
    keywords: ["switch", "open", "chat"],
    run: () => openChatById(s.session_id),
  }));
}

export async function projectCommands(): Promise<PaletteCommand[]> {
  const groups = await resolveCached(projectGroupsData(), []);
  return groups
    .filter((g) => g.path_exists !== false)
    .map((g) => ({
      id: `new-chat-in:${g.id ?? g.path}`,
      title: `New chat in ${g.name}`,
      group: "New chat",
      icon: "plus-circle",
      detail: g.parent_segment ?? undefined,
      keywords: ["start", "project", g.path],
      run: () => startNewChatInProject(g),
    }));
}

// ── This chat ───────────────────────────────────────────────────────────────

// The menu relabels a toggle by state ("Hide chat" / "Unhide chat"); the id must
// not flip with it or the recents entry would stop matching.
const CANONICAL_LABEL: Record<string, string> = {
  "Unhide chat": "Hide chat",
  "Unfreeze chat": "Freeze chat",
  "Move into main chat": "Move to sidebar",
};

function fromItems(items: ItemDesc[], titleOf: (label: string) => string): PaletteCommand[] {
  return items.map((item) => ({
    id: `this-chat:${CANONICAL_LABEL[item.label] ?? item.label}`,
    title: titleOf(item.label),
    group: "This chat",
    icon: item.icon,
    detail: item.isOn === undefined ? undefined : item.isOn ? "on" : "off",
    disabledReason: item.run ? undefined : (item.disabledReason ?? "Not available"),
    run: item.run,
  }));
}

const OPEN_IN = (label: string) => `Open project in ${label}`;

export function thisChatCommands(): PaletteCommand[] {
  const id = state.selectedId;
  if (!id || id.startsWith(PENDING_SESSION_ID_PREFIX)) return [];
  if (!state.sessions.some((s) => s.session_id === id)) return [];
  const ctx = liveChatMenuCtx(id);
  // A Dashboard row would duplicate the "Project dashboard" shortcut row.
  const open = buildOpenProjectItems(ctx).filter((i) => i.label !== "Dashboard");
  return [
    ...fromItems(buildChatItems(ctx), (l) => l),
    ...fromItems(buildConfigureItems(ctx), (l) => l),
    ...fromItems(buildAgentItems(ctx), (l) => l),
    ...fromItems(open, OPEN_IN),
    branchCommand(ctx.cwd, id, ctx.mirrored === true),
  ];
}

function branchCommand(cwd: string | null, sessionId: string, mirrored: boolean): PaletteCommand {
  return {
    id: "this-chat:Switch branch",
    title: "Switch branch",
    group: "This chat",
    icon: "git-branch",
    keywords: ["checkout", "git"],
    disabledReason: !cwd ? "No project directory" : mirrored ? "Chat is on another machine" : undefined,
    stage: {
      placeholder: "Switch branch",
      load: async () => {
        const branches = await invoke<BranchEntry[]>("get_recent_branches", { cwd, sessionId });
        return branches.map((b) => ({
          id: `branch:${b.name}`,
          title: b.name,
          group: b.current ? "Current" : "Branch",
          icon: "git-branch",
          detail: b.short_sha ?? undefined,
          // Git refuses a checkout a dirty file blocks and returns its own text,
          // which the palette shows under the list.
          run: b.current ? () => {} : () => invoke<void>("checkout_branch", { cwd, name: b.name }),
        }));
      },
    },
  };
}
