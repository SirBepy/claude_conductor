// The Chats window's right-hand rail, global half. The window is the app's one
// desktop window now, so Home, Schedule and Settings are reached from here
// instead of from their own windows, and Jarvis sits on the boundary between
// this chat's panels (split.ts's strip) and these screens.
//
// One rail, two homes: while a chat's split strip is on screen the global group
// is appended to that strip (globalGroupHtml), so chat tools and global screens
// read as one column. Everywhere else (Home, Schedule, Settings, History, and
// Chats with no chat open) there is no strip, so a standalone column with the
// same look carries the group plus a way back to Chats.

import { getActiveView, showView } from "./navigation";
import { isTauri } from "./transport";
// The standalone column reuses the strip's own look, so it needs split.css even
// when no chat (and so no split.ts) has loaded yet.
import "../views/sessions/split-panels/split.css";
import "./app-rail.css";

/** Rail entries that route in-window. `view` is the router name. */
const GLOBAL_ENTRIES = [
  { view: "dashboard", label: "Home", icon: "ph-house" },
  { view: "schedule", label: "Schedule", icon: "ph-alarm" },
  { view: "settings", label: "Settings", icon: "ph-gear" },
] as const;

/** Which rail entry a router view lights up. Settings subpages and the
 *  skill/character detail pages hang off Settings; History hangs off Chats. */
export function railActiveFor(view: string): string | null {
  if (view === "dashboard" || view === "schedule") return view;
  if (view === "settings" || view.startsWith("settings-")) return "settings";
  if (view === "characters" || view === "character-detail" || view === "skills" || view === "skill-detail") return "settings";
  if (view === "sessions" || view === "history") return "sessions";
  return null;
}

function tab(attrs: string, label: string, icon: string, on: boolean): string {
  return (
    `<button type="button" class="sp-tab${on ? " is-on" : ""}" ${attrs} title="${label}" ` +
    `aria-label="${label}" aria-pressed="${on}"><i class="ph ${icon}"></i></button>`
  );
}

/** The Jarvis orb. It is the loudest thing on the rail on purpose, but only in
 *  proportion to what it is, so it carries no state glow yet. */
function jarvisOrb(): string {
  return (
    `<button type="button" class="sp-orb" data-rail-jarvis title="Jarvis" aria-label="Jarvis">` +
    `<i class="ph-fill ph-sparkle"></i></button>`
  );
}

/** The bottom half of the rail: Jarvis on the boundary, then the global screens. */
export function globalGroupHtml(activeView: string): string {
  const active = railActiveFor(activeView);
  const entries = GLOBAL_ENTRIES.map((e) => tab(`data-rail-go="${e.view}"`, e.label, e.icon, active === e.view)).join("");
  return `<div class="sp-global" role="group" aria-label="Global">${jarvisOrb()}<span class="sp-global-label">GLOBAL</span>${entries}</div>`;
}

/** Handles a click on any rail control. Returns true when it was one. */
export function handleRailClick(target: EventTarget | null): boolean {
  const el = (target as HTMLElement | null)?.closest<HTMLElement>("[data-rail-go], [data-rail-jarvis]");
  if (!el) return false;
  if (el.hasAttribute("data-rail-jarvis")) {
    void import("../views/sessions/open-jarvis")
      .then((m) => m.openJarvis())
      .catch((err) => console.error("[rail] open Jarvis failed", err));
    return true;
  }
  const view = el.dataset.railGo;
  if (view) showView(view);
  return true;
}

let solo: HTMLElement | null = null;
let stripOnScreen = false;

function syncSolo(view: string): void {
  if (!solo) return;
  const show = view !== "sessions" || !stripOnScreen;
  solo.hidden = !show;
  document.body.classList.toggle("app-rail-solo", show);
  if (!show) return;
  const active = railActiveFor(view);
  solo.innerHTML =
    tab(`data-rail-go="sessions"`, "Chats", "ph-chats-circle", active === "sessions") + globalGroupHtml(view);
}

/** Router hook: repaints the standalone rail for the view just shown. */
export function syncAppRail(view: string): void {
  syncSolo(view);
}

/** Mounts the standalone rail. Chats window only; the phone and the
 *  single-purpose windows never call it. */
export function mountAppRail(): void {
  if (solo || !isTauri()) return;
  solo = document.createElement("nav");
  solo.id = "app-rail";
  solo.className = "sp-strip app-rail";
  solo.setAttribute("aria-label", "Navigation");
  solo.addEventListener("click", (ev) => void handleRailClick(ev.target));
  document.body.appendChild(solo);
  // split.ts announces its strip so the two homes never show at once.
  window.addEventListener("cc:split-strip", (ev) => {
    stripOnScreen = (ev as CustomEvent<{ present: boolean }>).detail.present;
    syncSolo(getActiveView());
  });
  syncSolo(getActiveView());
}

/** split.ts calls this when its strip appears or goes away. */
export function announceSplitStrip(present: boolean): void {
  window.dispatchEvent(new CustomEvent("cc:split-strip", { detail: { present } }));
}
