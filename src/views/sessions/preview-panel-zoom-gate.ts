// Decides when the Preview panel's stage zooms and pans instead of handing
// the pointer to the page. The page gets every click by default; zoom/pan is
// armed only while Ctrl (Cmd on macOS) is held, the way design tools and
// map embeds gate wheel-zoom so a plain scroll or click still reaches the
// content. Touch has no modifier key, so the stage's Zoom toggle arms it too.
//
// Arming flips `.is-zoom` on the stage, which turns the iframe's pointer
// events off (preview-panel.css) so image-zoom-pan.ts's stage listeners see
// the wheel, drag and click instead of the cross-origin page swallowing them.

import { ZOOM_KEY_MESSAGE } from "./preview-panel-document";

/** Returns a cleanup that removes every listener it added. */
export function mountZoomGate(stage: HTMLElement, iframe: HTMLIFrameElement, toggle: HTMLElement): () => void {
  let keyHeld = false;
  let toggled = false;

  function sync(): void {
    stage.classList.toggle("is-zoom", keyHeld || toggled);
    toggle.setAttribute("aria-pressed", String(toggled));
  }

  function setKeyHeld(held: boolean): void {
    if (keyHeld === held) return;
    keyHeld = held;
    sync();
  }

  // The panel's own window sees the key while focus is anywhere in the app
  // outside the iframe; the page's forwarder covers focus inside it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") setKeyHeld(e.type === "keydown");
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: unknown; held?: unknown; blur?: unknown } | null;
    if (data?.type !== ZOOM_KEY_MESSAGE) return;
    // The page blurs when a Ctrl+click on the stage moves focus out to the
    // panel, with Ctrl still down; the panel's own keyup reports the release
    // then. Only a blur to another app (panel unfocused too) is a release.
    if (data.blur === true) {
      setTimeout(() => { if (!document.hasFocus()) setKeyHeld(false); }, 0);
      return;
    }
    setKeyHeld(data.held === true);
  };
  // A key released while another app has focus never sends a keyup, which
  // would leave the page unclickable until Ctrl is pressed again.
  // Focus moving INTO the iframe also blurs the parent window; the key is
  // still down then, and the page's forwarder reports its release. Checked a
  // tick later, once activeElement has settled on the iframe.
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const onBlur = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (document.activeElement !== iframe) setKeyHeld(false);
    }, 0);
  };
  const onToggle = (e: MouseEvent) => {
    e.stopPropagation();
    toggled = !toggled;
    sync();
  };

  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("message", onMessage);
  window.addEventListener("blur", onBlur);
  toggle.addEventListener("click", onToggle);
  sync();

  return () => {
    clearTimeout(blurTimer);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    window.removeEventListener("message", onMessage);
    window.removeEventListener("blur", onBlur);
    toggle.removeEventListener("click", onToggle);
  };
}
