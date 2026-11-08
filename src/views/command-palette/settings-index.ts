// Every Settings page plus the single settings worth jumping straight to.
// Hand-kept because a subview only renders its rows when it is open, so there is
// nothing to scan ahead of time. tests/command-palette-settings-index.test.mjs
// fails when a `label` no longer appears in its page's source, which is how a
// renamed row gets caught instead of silently opening the page and flashing nothing.

export interface SettingsPage {
  route: string;
  title: string;
  icon: string;
  /** Folder under src/views/settings/subviews/ the drift test reads. */
  dir: string;
  /** Hidden on the phone, same split as settings.ts. */
  desktopOnly?: boolean;
  keywords?: string[];
}

export interface SettingEntry {
  route: string;
  /** Text of the row's label, as the page renders it (matched by prefix, case-insensitive). */
  label: string;
  keywords?: string[];
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { route: "settings-appearance", title: "Appearance", icon: "paint-brush", dir: "appearance", keywords: ["theme", "colors", "look"] },
  { route: "settings-usage-meter", title: "Usage meter", icon: "gauge", dir: "usage-meter", desktopOnly: true, keywords: ["overlay", "taskbar", "limits"] },
  { route: "settings-notifications", title: "Notifications", icon: "bell", dir: "notifications", keywords: ["sounds", "alerts"] },
  { route: "settings-voice", title: "Voice & dictation", icon: "microphone", dir: "voice", keywords: ["mic", "speech"] },
  { route: "settings-characters", title: "Characters", icon: "smiley", dir: "characters", keywords: ["avatars"] },
  { route: "settings-chat-defaults", title: "Chat defaults", icon: "chats-circle", dir: "chat-defaults", keywords: ["model", "effort"] },
  { route: "settings-permissions", title: "Permissions", icon: "shield-check", dir: "permissions", keywords: ["allow", "auto-accept"] },
  { route: "settings-browser", title: "Claude's browser", icon: "browser", dir: "browser", desktopOnly: true },
  { route: "settings-accounts", title: "Claude accounts & API keys", icon: "user-circle", dir: "accounts", keywords: ["login", "payment", "billing", "api key"] },
  { route: "settings-remote-access", title: "Remote access", icon: "device-mobile", dir: "remote-access", keywords: ["phone", "pairing", "machines"] },
  { route: "settings-power", title: "Power & startup", icon: "power", dir: "power", keywords: ["sleep", "shutdown", "login"] },
  { route: "settings-shortcuts", title: "Shortcuts", icon: "keyboard", dir: "shortcuts", desktopOnly: true, keywords: ["keybindings", "hotkeys"] },
  { route: "settings-data", title: "Data & storage", icon: "database", dir: "data", desktopOnly: true, keywords: ["retention", "history"] },
  { route: "settings-about", title: "About & updates", icon: "info", dir: "about", keywords: ["version", "update"] },
];

export const SETTING_ENTRIES: readonly SettingEntry[] = [
  { route: "settings-appearance", label: "Animated background" },
  { route: "settings-appearance", label: "Sidebar animations" },
  { route: "settings-appearance", label: "Hide from screen capture", keywords: ["privacy", "screenshot"] },
  { route: "settings-usage-meter", label: "Colour numbers in overlay" },
  { route: "settings-usage-meter", label: "Colour numbers on Dashboard" },
  { route: "settings-notifications", label: "Mute all notifications" },
  { route: "settings-notifications", label: "Mute sounds" },
  { route: "settings-notifications", label: "Notify me when Claude is blocked", keywords: ["idle"] },
  { route: "settings-notifications", label: "Pause sounds during meetings" },
  { route: "settings-notifications", label: "Show chat name in notifications" },
  { route: "settings-notifications", label: "Output device", keywords: ["speaker"] },
  { route: "settings-voice", label: "Voice dictation" },
  { route: "settings-voice", label: "Push-to-talk" },
  { route: "settings-voice", label: "Microphone" },
  { route: "settings-chat-defaults", label: "Default model" },
  { route: "settings-chat-defaults", label: "Default effort" },
  { route: "settings-chat-defaults", label: "Quick reply chips" },
  { route: "settings-chat-defaults", label: "Sort chats by", keywords: ["order", "sidebar"] },
  { route: "settings-permissions", label: "Auto-allow permissions by default" },
  { route: "settings-permissions", label: "Chats an agent starts inherit auto-allow" },
  { route: "settings-permissions", label: "Jarvis workers auto-allow" },
  { route: "settings-browser", label: "Let chats use a browser" },
  { route: "settings-browser", label: "Chats start on", keywords: ["my browser"] },
  { route: "settings-browser", label: "Script tool" },
  { route: "settings-browser", label: "Profile folder" },
  { route: "settings-remote-access", label: "Enable remote access" },
  { route: "settings-remote-access", label: "Lock this app", keywords: ["password", "fingerprint"] },
  { route: "settings-remote-access", label: "Ask for fingerprint" },
  { route: "settings-power", label: "Launch at login", keywords: ["startup", "autostart"] },
  { route: "settings-power", label: "Gaming mode" },
  { route: "settings-power", label: "Sleep or shut down once chats are done", keywords: ["when done"] },
];
