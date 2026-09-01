// In-app awaitable confirm. Deliberately NOT window.confirm: Tauri patches
// that to the dialog plugin's `confirm` command, which (a) returns a Promise,
// so the classic `if (!confirm(...))` guard never waits (past incident:
// account removal ran with no confirmation shown), and (b) depends on the
// window's ACL granting `dialog:allow-confirm` - a silent no-op dialog when
// it doesn't. A DOM overlay has neither failure mode and can't block the
// webview thread.
import "./confirm.css";
import { lockInputToHost } from "./modal";

export interface ConfirmOptions {
  /** Confirm-button label, e.g. "Remove". Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). Defaults to true. */
  danger?: boolean;
}

/** Splits "Question? rest of the explanation" into a bold title (up to and
 *  including the first "?") and a muted description (everything after). No
 *  "?" at all just becomes the whole title with no description - every
 *  existing single-sentence call site still reads fine. */
function splitTitle(text: string): { title: string; desc: string } {
  const idx = text.indexOf("?");
  if (idx === -1) return { title: text, desc: "" };
  return { title: text.slice(0, idx + 1), desc: text.slice(idx + 1).trim() };
}

/** Shows an in-app modal confirm; resolves `true` only on explicit confirm.
 * Escape, the cancel button, and clicking the backdrop all resolve `false`. */
export function askConfirm(text: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const danger = options.danger !== false;
    const { title, desc } = splitTitle(text);

    // The project/location/worktree/new-session popup chain shares one
    // backdrop (#modal-host); don't paint a second tint on top of it when
    // it's already showing - see confirm.css's --bare modifier.
    const chainOpen = document.getElementById("modal-host")?.classList.contains("open") ?? false;

    const overlay = document.createElement("div");
    overlay.className = chainOpen ? "app-confirm-overlay app-confirm-overlay--bare" : "app-confirm-overlay";

    const box = document.createElement("div");
    box.className = `app-confirm${danger ? "" : " app-confirm--safe"}`;
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");

    const icon = document.createElement("div");
    icon.className = "app-confirm-icon";
    icon.innerHTML = `<i class="ph-fill ${danger ? "ph-warning" : "ph-question"}"></i>`;

    const textWrap = document.createElement("div");
    const titleEl = document.createElement("p");
    titleEl.className = "app-confirm-title";
    titleEl.textContent = title;
    textWrap.appendChild(titleEl);
    if (desc) {
      const descEl = document.createElement("p");
      descEl.className = "app-confirm-text";
      descEl.textContent = desc;
      textWrap.appendChild(descEl);
    }

    const head = document.createElement("div");
    head.className = "app-confirm-head";
    head.append(icon, textWrap);

    const actions = document.createElement("div");
    actions.className = "app-confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "app-confirm-cancel btn-secondary";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = `app-confirm-ok ${danger ? "btn-danger" : "btn-primary"}`;
    confirmBtn.textContent = options.confirmLabel ?? "Confirm";

    const unlock = lockInputToHost(overlay);

    function finish(result: boolean): void {
      document.removeEventListener("keydown", onKey, true);
      unlock();
      overlay.remove();
      resolve(result);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    }

    cancelBtn.addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    // Capture phase so an underlying modal's own Escape handler (e.g. the
    // add-account wizard) doesn't also fire while the confirm is up.
    document.addEventListener("keydown", onKey, true);

    actions.append(cancelBtn, confirmBtn);
    box.append(head, actions);
    overlay.append(box);
    document.body.appendChild(overlay);
    cancelBtn.focus();
  });
}
