import { registerOverlayBack } from "../../../shared/back-button";
import { clearHost, ensureHost } from "./host";
import { createAuqAttachments } from "./attachments";
import { createAuqSlashPopup } from "./slash-popup";
import { LIGHTBOX_OVERLAY_CLASS } from "../../../shared/chat/lightbox";
import { createQuestionCardRenderer } from "./question-ui-render";
import type { QuestionRenderState } from "./question-ui-render";
import type { Answers, Question, QuestionDraft, QuestionUIOpts, Selection } from "./types";
import {
  isQuestionAnswered,
  computeAnswer,
  setActiveCard,
  clearActiveCardIfCurrent,
} from "./question-state";
import { flushAuqPush, cancelAuqPush, fetchRemoteAuqDraft } from "./auq-draft-sync";

// Payload normalization, the active-card draft registry, the pure
// answer-completeness check, and the pure question-text helpers now live in
// ./question-state.ts; re-exported here so existing importers of this file
// keep working unchanged.
export { isQuestionAnswered, computeAnswer, formatAnswersAsMessage, extractQuestions, dismissQuestionCard, snapshotActiveCardDraft, splitAsk, questionTextHtml } from "./question-state";

// Synthetic option appended to every multiSelect question so "nothing
// applies" is an explicit, selectable answer instead of an implicit
// zero-selections state - lets isQuestionAnswered require a real choice
// (checkbox or free text) instead of treating an untouched question as done.
const NONE_LABEL = "None of the above";

export function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const questions: Question[] = opts.questions.map((q) => {
    if (!q.multiSelect || !q.options?.length) return q;
    if (q.options.some((o) => o.label === NONE_LABEL)) return q;
    return { ...q, options: [...q.options, { label: NONE_LABEL }] };
  });

  // The recap/review step is only worth a panel when there's something to
  // review across multiple questions, or extras (message/attachments) to add -
  // a single bare question goes straight from its own panel to Submit.
  const hasSummary = Boolean(opts.supportsExtras) || questions.length > 1;
  const totalPanels = questions.length + (hasSummary ? 1 : 0);

  const selections = new Map<number, Selection>();
  const freeText = new Map<number, string>();
  if (opts.initialDraft) {
    opts.initialDraft.freeText.forEach((v, k) => freeText.set(k, v));
    opts.initialDraft.selections.forEach((v, k) => {
      selections.set(k, v instanceof Set ? new Set(v) : v);
    });
  }
  questions.forEach((q, i) => {
    if (q.multiSelect && !selections.has(i)) selections.set(i, new Set<string>());
  });

  // Fields the renderer mutates per-render but that setup/teardown/
  // triggerPrimaryShortcut below also need - one shared box instead of
  // three loose closure variables now that render lives in another module.
  const state: QuestionRenderState = {
    activeTab: Math.min(Math.max(opts.initialDraft?.activeTab ?? 0, 0), totalPanels - 1),
    additionalMessage: opts.initialDraft?.additionalMessage ?? "",
    resizeObs: null,
  };

  // Review-step extra message + pasted-image attachments. Only ever populated
  // when opts.supportsExtras (the async MCP flow) - see QuestionUIOpts doc.
  const auqAttachments = createAuqAttachments({
    sessionId: opts.sessionId,
    supportsExtras: opts.supportsExtras,
    initial: opts.initialDraft?.attachments,
    onChange: () => renderer.render(),
  });

  // "/" skill-suggestion popup + highlight backdrop - the same shared core
  // the composer uses (ai_todo 439), not a reimplementation.
  const slashPopup = createAuqSlashPopup(opts.cwd);

  const messagesEl = document.querySelector<HTMLElement>(".session-messages");
  const savedScrollTop = messagesEl?.scrollTop ?? 0;
  const savedPaddingBottom = messagesEl?.style.paddingBottom ?? "";

  // Phone back button skips the question (same as Escape / the Skip button) so
  // the card never traps the user, and the prompt resolves rather than silently
  // hiding. Registered below once `cancel` exists; disposed on teardown.
  let backDisposer: (() => void) | null = null;

  // Declared and wired BEFORE `teardown` (which closes over it) so there is no
  // forward reference in either direction - teardown used to be handed to
  // setActiveCard while keydownHandler was still ~70 lines below it in the
  // temporal dead zone, safe today only because nothing calls teardown
  // synchronously during setup.
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      dismissUnlessOverlayAbove();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerPrimaryShortcut();
    }
  };
  document.addEventListener("keydown", keydownHandler);

  // Flush the debounced daemon push on hidden (last reliable save point - see
  // debounce.ts's doc); reconcile on regaining visibility, but NEVER clobber a
  // field the user is actively focused in (the one load-bearing rule here).
  const visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      flushAuqPush();
      return;
    }
    if (document.visibilityState !== "visible" || !opts.sessionId || !opts.id) return;
    void fetchRemoteAuqDraft(opts.sessionId, opts.id).then((remote) => {
      if (!remote || host.contains(document.activeElement)) return;
      freeText.clear();
      remote.freeText.forEach((v, k) => freeText.set(k, v));
      selections.clear();
      remote.selections.forEach((v, k) => selections.set(k, v instanceof Set ? new Set(v) : v));
      questions.forEach((q, i) => { if (q.multiSelect && !selections.has(i)) selections.set(i, new Set<string>()); });
      state.additionalMessage = remote.additionalMessage;
      renderer.render();
    });
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  const teardown = () => {
    backDisposer?.();
    backDisposer = null;
    slashPopup.destroyAll();
    slashPopup.stop();
    clearHost();
    document.removeEventListener("keydown", keydownHandler);
    document.removeEventListener("visibilitychange", visibilityHandler);
    cancelAuqPush();
    if (state.resizeObs) { try { state.resizeObs.disconnect(); } catch { /* ignore */ } state.resizeObs = null; }
    if (messagesEl) {
      messagesEl.style.paddingBottom = savedPaddingBottom;
      messagesEl.scrollTop = savedScrollTop;
    }
    clearActiveCardIfCurrent(teardown);
  };
  const currentDraft = (): QuestionDraft => ({
    freeText: new Map(freeText),
    selections: new Map(
      Array.from(selections.entries()).map(([k, v]) => [k, v instanceof Set ? new Set(v) : v])
    ),
    activeTab: state.activeTab,
    additionalMessage: state.additionalMessage,
    attachments: [...auqAttachments.attachments],
  });
  if (opts.id) {
    setActiveCard({
      id: opts.id,
      sessionId: opts.sessionId,
      teardown,
      getDraft: currentDraft,
    });
  }

  // Per-question answer, normalized: multiSelect -> string[] (possibly empty,
  // always present), single-select/free-text -> string, string[] (pick +
  // typed combined), or null if unanswered. See computeAnswer for the rule.
  const answerFor = (qi: number): string | string[] | null =>
    computeAnswer(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const submit = () => {
    const answers: Answers = {};
    questions.forEach((q, i) => {
      const a = answerFor(i);
      if (q.multiSelect) {
        answers[q.question] = a as string[];
      } else if (a != null) {
        answers[q.question] = a;
      }
    });
    teardown();
    void opts.onSubmit(answers, { additionalMessage: state.additionalMessage.trim(), attachments: [...auqAttachments.attachments] });
  };

  const cancel = () => {
    teardown();
    void opts.onCancel();
  };

  // A lightbox on top of this card has no overlay registration of its own,
  // so without this check Escape/back would also cancel the card - sending
  // NO answer at all (onCancel), unrecoverable for a keypress meant for the
  // image. One guarded path here so both dismiss triggers stay in sync.
  const dismissUnlessOverlayAbove = () => {
    if (document.querySelector(`.${LIGHTBOX_OVERLAY_CLASS}`)) return;
    cancel();
  };

  backDisposer = registerOverlayBack(() => {
    // Always consumes the press (returns true) even when it no-ops - with the
    // lightbox unregistered, falling through (false) would step the
    // view-navigation stack instead, an even bigger surprise than a no-op.
    dismissUnlessOverlayAbove();
    return true;
  });

  const answeredAt = (qi: number): boolean =>
    isQuestionAnswered(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const answerPreview = (qi: number): string => {
    const a = answerFor(qi);
    if (Array.isArray(a)) return a.length ? a.join(", ") : "Not answered";
    return typeof a === "string" && a ? a : "Not answered";
  };

  const renderer = createQuestionCardRenderer({
    host,
    opts,
    questions,
    hasSummary,
    totalPanels,
    noneLabel: NONE_LABEL,
    selections,
    freeText,
    state,
    auqAttachments,
    slashPopup,
    messagesEl,
    answeredAt,
    answerPreview,
    submit,
    cancel,
    notifyDraftChange: () => opts.onDraftChange?.(currentDraft()),
  });

  // Ctrl/Cmd+Enter never skips review: it submits only from the review panel,
  // or when there is no review panel at all (single bare question).
  const triggerPrimaryShortcut = () => {
    if (!hasSummary) {
      if (answeredAt(0)) submit();
      return;
    }
    if (state.activeTab === questions.length) { submit(); return; }
    if (!answeredAt(state.activeTab)) return;
    const next = questions.findIndex((_, i) => !answeredAt(i));
    renderer.goToTab(next >= 0 ? next : questions.length);
  };

  renderer.render();
}
