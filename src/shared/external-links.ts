import { api } from "./api";
import { isRemote } from "./transport";

const EXTERNAL_SCHEMES = ["http://", "https://", "mailto:", "file://"];

function isExternal(href: string): boolean {
  const lower = href.toLowerCase();
  return EXTERNAL_SCHEMES.some((s) => lower.startsWith(s));
}

function handleClick(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  if (!isExternal(href)) return;
  e.preventDefault();
  e.stopPropagation();
  // On the phone, open_external would launch the URL on the PC running the
  // daemon, so the phone's own browser has to open it.
  if (isRemote()) {
    // file: names a path on the PC, meaningless on the phone.
    if (href.toLowerCase().startsWith("file://")) return;
    // The Android shell has no multi-window support, so window.open would load
    // the page inside the app; its bridge hands the URL to the system instead.
    const bridge = (window as unknown as { ConductorLinks?: { openExternal?: (url: string) => void } }).ConductorLinks;
    if (typeof bridge?.openExternal === "function") {
      bridge.openExternal(href);
    } else {
      window.open(href, "_blank", "noopener");
    }
    return;
  }
  void api.openExternal(href).catch((err) => {
    console.warn("[external-links] openExternal failed", err);
  });
}

export function installExternalLinkInterceptor(): void {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("auxclick", handleClick, true);
}
