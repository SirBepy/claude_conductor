/**
 * Masked-secret relay card: the `request_secret` MCP tool asks the
 * user to paste a value that gets written straight into a key=value file on
 * disk, never surfaced to the model. Floating-card sibling of
 * permission-card.ts, but the typed value follows api-key-modal.ts's
 * discipline exactly: it lives only in this closure's local `value` string
 * (read once off the input at submit time), is never stored in any state
 * object, never logged, and is cleared the instant `respond_secret` settles
 * (success or error) - see the `save()` closure below.
 */

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { isRemote } from "../../../shared/transport";
import { state } from "../state";
import { sessionSubtitle, projectName } from "../sessions-helpers";
import { clearHost, ensureHost, renderCardShell } from "./host";
import { clearActivePermissionCardIfCurrent, setActivePermissionCard } from "./question-state";
import { storePendingPrompt } from "./gating";
import type { SecretRequestedPayload } from "./types";

/** Id-scoped registry so `index.ts`'s `prompt-resolved` handler can dismiss
 *  THIS card specifically (a daemon-side timeout/cancel), without reaching
 *  for the non-id-scoped `activePermissionCardTeardown` single slot, which
 *  would also tear down an unrelated permission card sharing that slot. */
let _active: { id: string; teardown: () => void } | null = null;

/** Dismiss the live secret card if it matches `id` (or unconditionally with
 *  no id). No-op if nothing matches. */
export function dismissSecretCard(id?: string): void {
  if (!_active) return;
  if (id && _active.id !== id) return;
  _active.teardown();
}

/** The asking chat's name the way the sidebar/header already resolve it
 *  (sessionSubtitle), so the card calls it what the rest of the app does.
 *  `title` carries the project too. Falls back for a session not (or no
 *  longer) in `state.sessions`. */
function sessionLabel(sessionId: string | undefined): { name: string; project: string } {
  const inst = sessionId ? state.sessions.find((s) => s.session_id === sessionId) : undefined;
  if (!inst) return { name: "Unknown chat", project: "" };
  return { name: sessionSubtitle(inst), project: projectName(inst) };
}

/** The daemon canonicalizes the target on Windows, which prefixes it with the
 *  verbatim `\\?\` marker. That is plumbing, not part of the path the user
 *  would recognise. */
function displayPath(file: string): string {
  return file.replace(/^\\\\\?\\/, "");
}

export function showSecretCard(payload: SecretRequestedPayload): void {
  // Park while on screen so a chat switch-and-back re-surfaces it (same
  // reasoning as showQuestionCard/showPermissionCard) - cleared by the
  // `prompt-resolved` poll via clearPendingPromptById.
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "secret", payload });
  }

  const { host } = ensureHost();
  let saving = false;
  let error: string | null = null;

  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { if (isRemote()) teardownEsc(); else void cancel(); }
  };

  // Removes the DOM too (not just the Escape listener) - this is the same
  // function `dismissSecretCard` fires for an EXTERNAL resolve (daemon-side
  // timeout/cancel), which has no button click of its own to call clearHost().
  function teardownEsc(): void {
    clearHost();
    document.removeEventListener("keydown", escHandler);
    clearActivePermissionCardIfCurrent(teardownEsc);
    if (_active?.teardown === teardownEsc) _active = null;
  }

  async function cancel(): Promise<void> {
    if (saving) return;
    teardownEsc();
    try {
      await invoke("respond_secret", { requestId: payload.id, value: null, cancelled: true });
    } catch (e) {
      console.warn("respond_secret (cancel) failed:", e);
    }
  }

  document.addEventListener("keydown", escHandler);
  setActivePermissionCard(teardownEsc);
  _active = { id: payload.id, teardown: teardownEsc };

  // The AI-written `label` is deliberately not rendered: model-written free
  // text could pass for the app's own re-authentication prompt, and the key
  // name plus target file already say what is being asked. The header names
  // the asking chat instead.
  const asker = sessionLabel(payload.session_id);
  const title = `
    <span class="prompt-card__title">
      <i class="ph ph-lock-key"></i>
      Secret requested
    </span>
    <span class="secret-card__from"${asker.project ? ` title="${escapeHtml(asker.project)}"` : ""}>
      <i class="ph ph-chat-circle-text"></i> from <b>${escapeHtml(asker.name)}</b>
    </span>
    <button type="button" class="icon-btn-sq prompt-icon-btn" data-act="minimize" title="Minimize to read the chat"><i class="ph ph-minus"></i></button>
  `;

  function bodyHtml(): string {
    // reveal_file_in_explorer acts on the desktop's own disk - the phone has
    // none, so the path renders as inert text there instead of a dead button
    // (same gate file-surface.ts uses for its own desktop-only reveal action).
    const shown = escapeHtml(displayPath(payload.file));
    const path = `<span class="secret-card__path"><bdi>${shown}</bdi></span>`;
    const fileRow = isRemote()
      ? path
      : `<button type="button" class="secret-card__file" data-act="reveal" title="Show in File Explorer">
          ${path}
          <i class="ph ph-arrow-square-out"></i>
        </button>`;
    return `
      <dl class="secret-card__ledger">
        <dt>File</dt><dd>${fileRow}</dd>
        <dt>Key</dt><dd><span class="secret-card__key">${escapeHtml(payload.key)}</span></dd>
      </dl>
      ${payload.temporary
        // Plain muted text, no badge: it is a fact about the file, not a state to flag.
        // Reuses the desktop-only note's muted styling.
        ? `<p class="secret-card__desktop-only secret-card__temporary">Temporary: deleted when this chat closes</p>`
        : ""}
      ${isRemote()
        ? `<p class="secret-card__desktop-only"><i class="ph ph-desktop"></i> Enter this secret on the desktop. A phone can't submit it.</p>`
        : `<div class="secret-card__input-wrap">
        <input
          type="password"
          class="secret-card__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="Paste the secret value"
        >
        <button type="button" class="secret-card__eye" data-act="peek" aria-label="Show value" title="Show value"><i class="ph ph-eye"></i></button>
      </div>`}
      ${error ? `<div class="secret-card__error"><i class="ph ph-warning-circle"></i> ${escapeHtml(error)}</div>` : ""}
    `;
  }

  function footerHtml(): string {
    // No icon on Save - the app's other Save buttons (e.g. cc-modal-save) are
    // text-only, and a one-off icon here read as inconsistent (Joe, 2026-10-19).
    // The phone can't answer a secret prompt (respond_secret is desktop-only),
    // so it only gets a local dismiss; the daemon-side prompt stays pending
    // for the desktop.
    if (isRemote()) {
      return `<button type="button" class="btn btn-secondary" data-act="dismiss">Close</button>`;
    }
    return `
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save" disabled>Save</button>
    `;
  }

  function render(): void {
    host.innerHTML = renderCardShell(title, bodyHtml(), footerHtml());
    attach();
  }

  function setBusy(busy: boolean, input: HTMLInputElement, saveBtn: HTMLButtonElement, cancelBtn: HTMLButtonElement): void {
    input.disabled = busy;
    cancelBtn.disabled = busy;
    saveBtn.disabled = busy || !input.value;
    saveBtn.innerHTML = busy
      ? `<i class="ph ph-spinner secret-card__spin"></i> Saving&hellip;`
      : `Save`;
  }

  async function save(): Promise<void> {
    const input = host.querySelector<HTMLInputElement>(".secret-card__input");
    const saveBtn = host.querySelector<HTMLButtonElement>('[data-act="save"]');
    const cancelBtn = host.querySelector<HTMLButtonElement>('[data-act="cancel"]');
    if (!input || !saveBtn || !cancelBtn || saving || !input.value) return;
    // Read once into a local - this is the ONLY place the typed value is
    // ever referenced beyond the input element itself.
    const value = input.value;
    saving = true;
    error = null;
    setBusy(true, input, saveBtn, cancelBtn);
    try {
      // Mirrors respond_permission/respond_question: resolves on success,
      // rejects (with the daemon's error text) on a refused target or a
      // failed write - never a `{ok: false}` the caller has to notice.
      await invoke<boolean>("respond_secret", {
        requestId: payload.id,
        value,
        cancelled: false,
      });
      // Cleared the instant the invoke settles, success or error - never left
      // sitting in the DOM past this point.
      input.value = "";
      saving = false;
      teardownEsc();
    } catch (e) {
      input.value = "";
      saving = false;
      error = e instanceof Error ? e.message : "Failed to save.";
      render();
      host.querySelector<HTMLInputElement>(".secret-card__input")?.focus();
    }
  }

  // The card floats over the chat, and the message above it often says where
  // to find the secret. Hiding (not re-rendering) keeps the typed value in the
  // input while the bar stands in for the card.
  function attachMinimize(): void {
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!card) return;
    host.querySelector('[data-act="minimize"]')?.addEventListener("click", () => {
      const bar = document.createElement("div");
      bar.className = "prompt-collapsed";
      bar.style.setProperty("--dom", "var(--color-text-muted)");
      bar.innerHTML = `
        <span class="prompt-collapsed__dot"></span>
        <span class="prompt-collapsed__q">Secret requested: ${escapeHtml(payload.key)}</span>
        <button type="button" class="icon-btn-sq prompt-icon-btn" data-act="restore" title="Restore"><i class="ph ph-caret-up"></i></button>
      `;
      bar.addEventListener("click", () => {
        bar.remove();
        card.style.display = "";
        host.querySelector<HTMLInputElement>(".secret-card__input")?.focus();
      });
      card.style.display = "none"; // .prompt-card sets display:flex, which beats [hidden]
      host.appendChild(bar);
    });
  }

  function attach(): void {
    attachMinimize();
    if (isRemote()) {
      host.querySelector<HTMLButtonElement>('[data-act="dismiss"]')!.addEventListener("click", teardownEsc);
      return;
    }
    const input = host.querySelector<HTMLInputElement>(".secret-card__input")!;
    const saveBtn = host.querySelector<HTMLButtonElement>('[data-act="save"]')!;
    input.addEventListener("input", () => {
      saveBtn.disabled = saving || !input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !saveBtn.disabled) {
        e.preventDefault();
        void save();
      }
    });
    saveBtn.addEventListener("click", () => void save());
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.addEventListener("click", () => void cancel());
    // Reveal toggles the input type only; the value never leaves the element.
    const peek = host.querySelector<HTMLButtonElement>('[data-act="peek"]');
    peek?.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      peek.setAttribute("aria-label", show ? "Hide value" : "Show value");
      peek.title = show ? "Hide value" : "Show value";
      peek.innerHTML = `<i class="ph ph-${show ? "eye-slash" : "eye"}"></i>`;
      input.focus();
    });
    host.querySelector<HTMLButtonElement>('[data-act="reveal"]')?.addEventListener("click", () => {
      void invoke<void>("reveal_file_in_explorer", { path: payload.file })
        .catch((err) => console.warn("[secret-card] reveal failed:", err));
    });
    input.focus();
  }

  render();
}
