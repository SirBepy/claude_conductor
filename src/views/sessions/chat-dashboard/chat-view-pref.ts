// Which view a chat window draws: the dashboard (docs/chat-dashboard-design.md)
// or the Messages transcript it replaces. One app-wide setting in Chat
// defaults, stored in settings.json's extra map, so it needs no Rust field.

import { getSettings } from "../../../shared/state";
import { updateSettings } from "../../../shared/settings-update";
import { isRemote } from "../../../shared/transport";

export const CHAT_VIEW_KEY = "chatView";
/** Fired on `document` when the setting changes, so an open chat switches in place. */
export const CHAT_VIEW_CHANGED = "cc-chat-view-changed";

export type ChatView = "dashboard" | "messages";

/** Dashboard unless the setting says Messages: Joe asked for the dashboard to be
 *  what he sees first (2026-11-10), so an absent or unknown value is Dashboard. */
export function readChatView(settings: Record<string, unknown>): ChatView {
  return settings[CHAT_VIEW_KEY] === "messages" ? "messages" : "dashboard";
}

/** Saves the app-wide view and switches the open chat in place. updateSettings
 *  refreshes the settings cache before the event fires, so the chat reads the new value. */
export function saveChatView(view: ChatView): Promise<void> {
  return updateSettings((fresh) => ({ ...fresh, [CHAT_VIEW_KEY]: view }))
    .then(() => { document.dispatchEvent(new CustomEvent(CHAT_VIEW_CHANGED)); });
}

/** The command palette's "Toggle Dashboard / Messages": flips the same app-wide
 *  setting as Settings > Chat defaults (Joe, 2026-11-13: app-wide, not per chat). */
export function toggleChatView(): Promise<void> {
  return saveChatView(readChatView(getSettings()) === "dashboard" ? "messages" : "dashboard");
}

/** The phone keeps Messages for now: the dashboard is designed desktop first. */
export function dashboardEnabled(remote: boolean = isRemote(), settings: Record<string, unknown> = getSettings()): boolean {
  return !remote && readChatView(settings) === "dashboard";
}

/** Joe's per-section choices (Settings > Chat defaults), zone id -> shown. Only
 *  what he changed is stored; a section he has not touched follows
 *  SECTION_DEFAULTS in dashboard-model.ts. Lives in settings.json's extra map. */
export const SECTIONS_KEY = "dashboardSections";

export function readSections(settings: Record<string, unknown>): Record<string, boolean> {
  const raw = settings[SECTIONS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
}
