// Upload-in-progress overlay and pop-in motion for a staged attachment chip,
// shared by the composer's strip and the question card's strip. Both strips
// rebuild every chip from scratch on each render (innerHTML = ""), and one
// upload renders several times (placeholder, bytes read, upload done), so the
// pop is keyed on the attachment object and resumed with a negative
// animation-delay rather than restarting on each rebuild.

/** Set inline on the chip, so the CSS keyframes and this cutoff never drift. */
export const ATTACHMENT_POP_MS = 380;

const popStartedAt = new WeakMap<object, number>();

/** Call once when an attachment is first staged by the user. Restored or
 *  rehydrated attachments never get this, so switching chats does not replay
 *  the pop on chips that were already there. */
export function markAttachmentPop(a: object): void {
  popStartedAt.set(a, performance.now());
}

export function decorateAttachmentChip(div: HTMLElement, a: object & { uploading?: boolean }): void {
  const started = popStartedAt.get(a);
  if (started !== undefined) {
    const elapsed = performance.now() - started;
    if (elapsed < ATTACHMENT_POP_MS) {
      div.classList.add("attachment--pop");
      div.style.animationDuration = `${ATTACHMENT_POP_MS}ms`;
      div.style.animationDelay = `${-elapsed}ms`;
    } else {
      popStartedAt.delete(a);
    }
  }
  if (a.uploading) {
    div.classList.add("uploading");
    div.setAttribute("aria-busy", "true");
    div.title = "Uploading...";
    const progress = document.createElement("span");
    progress.className = "attachment-progress";
    progress.innerHTML = '<i class="ph ph-circle-notch"></i>';
    div.appendChild(progress);
  }
}
