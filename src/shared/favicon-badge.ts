// Browser-tab favicon badge for the remote (phone/browser) client. The
// desktop app has no tab, so this is a no-op inside the Tauri webview
// (window.__TAURI__ present) - a real browser tab is the only surface that
// benefits from a glanceable "something needs you" signal.
//
// Priority: unread "input needed" sessions (red) beats unread "done" sessions
// (green) beats the plain app icon. The badge flickers on/off while a count
// is active so a backgrounded tab still catches the eye.

import type { Instance } from "../types/ipc.generated";
import { deriveQuestionSet } from "../views/sessions/sessions-helpers";
import { isRemote } from "./transport";

const SIZE = 32;
const FLICKER_MS = 600;
const RED = "#ef4444";
const GREEN = "#22c55e";
const DEFAULT_ICON_HREF = "/icons/icon-192.png";

let iconImg: HTMLImageElement | null = null;
let iconLoadFailed = false;
let canvas: HTMLCanvasElement | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let flashOn = true;
let currentColor: string | null = null;
let currentCount = 0;

function faviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>("link#favicon-link");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.id = "favicon-link";
    document.head.appendChild(link);
  }
  return link;
}

function loadBaseIcon(): Promise<HTMLImageElement | null> {
  if (iconImg) return Promise.resolve(iconImg);
  if (iconLoadFailed) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { iconImg = img; resolve(img); };
    img.onerror = () => { iconLoadFailed = true; resolve(null); };
    img.src = DEFAULT_ICON_HREF;
  });
}

function isLightMode(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

// Re-render on a live theme flip so the halo appears/disappears without a reload.
// Gated like the rest of the module: a no-op listener inside the Tauri webview.
if (isRemote() && typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    render(currentCount, currentColor, flashOn);
  });
}

function render(count: number, color: string | null, on: boolean): void {
  if (!iconImg) return;
  canvas ??= document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, SIZE, SIZE);
  if (isLightMode()) {
    // Raster source has no built-in stroke; fake one with a stacked shadow
    // halo, then draw the crisp icon on top so the mark itself is unblurred.
    ctx.shadowColor = "#16151f";
    ctx.shadowBlur = 2;
    for (let i = 0; i < 3; i++) ctx.drawImage(iconImg, 0, 0, SIZE, SIZE);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }
  ctx.drawImage(iconImg, 0, 0, SIZE, SIZE);
  if (color && on && count > 0) {
    const r = 11;
    const cx = SIZE - r - 1;
    const cy = r + 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#16151f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 9 ? "9+" : String(count), cx, cy + 1);
  }
  faviconLink().href = canvas.toDataURL("image/png");
}

function stopFlicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Recomputes and applies the favicon badge from the live session list plus
 *  the caller's unread set (same `loadUnreadSet()` the sidebar uses). */
export function updateFaviconBadge(sessions: Instance[], unread: ReadonlySet<string>): void {
  if (typeof document === "undefined" || !isRemote()) return;

  const question = deriveQuestionSet(sessions);
  let inputNeeded = 0;
  let done = 0;
  for (const s of sessions) {
    if (!unread.has(s.session_id)) continue;
    if (question.has(s.session_id)) inputNeeded++;
    else done++;
  }

  currentColor = inputNeeded > 0 ? RED : done > 0 ? GREEN : null;
  currentCount = inputNeeded > 0 ? inputNeeded : done;

  void loadBaseIcon().then((img) => {
    if (!img) return;
    if (!currentColor) {
      stopFlicker();
      render(0, null, true);
      return;
    }
    if (!timer) {
      flashOn = true;
      timer = setInterval(() => {
        flashOn = !flashOn;
        render(currentCount, currentColor, flashOn);
      }, FLICKER_MS);
    }
    render(currentCount, currentColor, flashOn);
  });
}
