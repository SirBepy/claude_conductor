import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { buildRule, describeRule, isDestructive, withAddedRule } from "../permission-rules";
import { clearHost, ensureHost, renderCardShell } from "./host";
import { extractQuestions, formatAnswersAsMessage, renderQuestionUI } from "./question-ui";
import { clearActivePermissionCardIfCurrent, setActivePermissionCard } from "./question-state";
import { resolveCwdForSession, storePendingPrompt } from "./gating";
import { isAskQuestionTool } from "../../../shared/chat/tool-meta";
import type { PermissionRequestedPayload, QuestionDraft } from "./types";

// Deliberately not "User skipped the question." - that exact string once
// reached claude even after a real submit (2026-08-18 incident).
const FALLBACK_DISMISS_MESSAGE = "User dismissed the question without answering.";

export function showPermissionCard(payload: PermissionRequestedPayload, restoredDraft?: QuestionDraft): void {
  // Park the prompt while it's on screen so a chat switch-and-back re-surfaces
  // it instead of leaving the daemon turn hung (see showQuestionCard). Cleared
  // when the prompt resolves via the `prompt-resolved` poll.
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "permission", payload });
  }
  // Question-shaped fallback (pre-trust keeps our own MCP tool off this path).
  // Only `{behavior, message}` can settle this oneshot - never respond_question.
  const questions = extractQuestions(payload.input);
  if (questions) {
    renderQuestionUI({
      id: payload.id,
      sessionId: payload.session_id,
      questions,
      initialDraft: restoredDraft,
      cwd: resolveCwdForSession(payload.session_id),
      titleIcon: "ph-chat-circle-dots",
      // Fallback-path tell for every OTHER tool; hidden for our own.
      rightChipHtml: isAskQuestionTool(payload.tool_name)
        ? undefined
        : `<span class="prompt-card__tool"><code>${escapeHtml(payload.tool_name)}</code></span>`,
      submitLabel: "Answer",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: async (answers, extras) => {
        let message = formatAnswersAsMessage(questions, answers);
        if (extras.additionalMessage) message += `\n\n${extras.additionalMessage}`;
        try {
          await invoke("respond_permission", { id: payload.id, behavior: "deny", updatedInput: null, message });
        } catch (e) { console.warn("respond_permission failed:", e); }
      },
      onCancel: async () => {
        try {
          await invoke("respond_permission", {
            id: payload.id,
            behavior: "deny",
            updatedInput: null,
            message: FALLBACK_DISMISS_MESSAGE,
          });
        } catch (e) { console.warn("respond_permission failed:", e); }
      },
    });
    return;
  }

  // Generic permission gate (Bash/Edit/Write/etc.)
  const { host } = ensureHost();
  const cwd = resolveCwdForSession(payload.session_id);
  const rule = buildRule(payload.tool_name, payload.input);
  const canRemember = cwd !== null && !isDestructive(payload.tool_name, payload.input);

  const respond = async (behavior: "allow" | "deny") => {
    clearHost();
    teardownEsc();
    try {
      await invoke("respond_permission", {
        id: payload.id,
        behavior,
        updatedInput: behavior === "allow" ? (payload.input ?? {}) : null,
        message: behavior === "deny" ? "Denied by user." : null,
      });
    } catch (e) {
      console.warn("respond_permission failed:", e);
    }
  };

  const alwaysAllow = async () => {
    if (!cwd) { void respond("allow"); return; }
    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      const updated = withAddedRule(settings, cwd, rule);
      await invoke("save_settings", { updated });
    } catch (e) {
      console.warn("[perm-rules] save rule failed:", e);
    }
    void respond("allow");
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") void respond("deny");
  };
  document.addEventListener("keydown", escHandler);
  // Registered for teardown (todo 731) so a swap via ensureHost() - not only
  // this card's own respond() - removes the listener: unremoved, a later
  // Escape ran a dead card's respond('deny'), which deleted whatever card
  // was mounted next via clearHost()'s (now-fixed) by-ID lookup.
  const teardownEsc = () => {
    document.removeEventListener("keydown", escHandler);
    clearActivePermissionCardIfCurrent(teardownEsc);
  };
  setActivePermissionCard(teardownEsc);

  const inputJson = JSON.stringify(payload.input ?? {}, null, 2);

  const title = `
    <span class="prompt-card__title">
      <i class="ph ph-shield-warning"></i>
      Permission requested
    </span>
    <span class="prompt-card__tool"><code>${escapeHtml(payload.tool_name)}</code></span>
  `;
  const body = `
    <details class="prompt-card__details">
      <summary>Tool input</summary>
      <pre class="prompt-card__pre"></pre>
    </details>
  `;
  const alwaysBtnHtml = canRemember
    ? `<button type="button" class="btn btn-tertiary" data-act="always" title="${escapeHtml(describeRule(rule))}">
        <i class="ph ph-shield-check"></i> Always Allow
      </button>`
    : "";
  const footer = `
    <button type="button" class="btn btn-secondary" data-act="deny">Deny</button>
    ${alwaysBtnHtml}
    <button type="button" class="btn btn-primary" data-act="allow">
      <i class="ph ph-check"></i> Allow
    </button>
  `;

  host.innerHTML = renderCardShell(title, body, footer);
  host.querySelector<HTMLElement>(".prompt-card__pre")!.textContent = inputJson;

  host.querySelector<HTMLButtonElement>('[data-act="allow"]')!
    .addEventListener("click", () => void respond("allow"));
  host.querySelector<HTMLButtonElement>('[data-act="deny"]')!
    .addEventListener("click", () => void respond("deny"));
  host.querySelector<HTMLButtonElement>('[data-act="always"]')
    ?.addEventListener("click", () => void alwaysAllow());
}
