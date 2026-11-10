// Which view a chat window draws: the dashboard (docs/chat-dashboard-design.md)
// or the Messages transcript it replaces. One app-wide setting in Chat
// defaults, stored in settings.json's extra map, so it needs no Rust field.

import { getSettings } from "../../../shared/state";
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

/** The phone keeps Messages for now: the dashboard is designed desktop first. */
export function dashboardEnabled(remote: boolean = isRemote(), settings: Record<string, unknown> = getSettings()): boolean {
  return !remote && readChatView(settings) === "dashboard";
}
