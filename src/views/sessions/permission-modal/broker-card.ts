/**
 * The API broker's three cards (import, add/replace, policy edit). The daemon raises
 * each as a `question-requested` prompt with a `broker_card` body (`broker/cards.rs`);
 * this renders the exact rows it will change and answers through `respond_broker_card`,
 * the one call no chat can make (desktop pipe only).
 *
 * A pasted token follows secret-card.ts's discipline: it lives in the input element
 * and in one local read at save time, goes only into the `respond_broker_card`
 * invoke, is cleared the instant that settles, and is never stored, logged or put in
 * a message. Everything else on the card comes from the daemon and is escaped.
 */

import { invoke } from "../../../shared/ipc";
import { escapeHtml } from "../../../shared/escape-html";
import { isRemote } from "../../../shared/transport";
import { isSettingsPopupOpen } from "../../../shared/settings-popup";
import { clearHost, ensureHost, renderCardShell } from "./host";
import { clearActiveCardIfCurrent, setActiveCard } from "./question-state";
import { askerFaceOf } from "./asker-face";
import { fromChipHtml } from "./question-ui-templates";
import type { BrokerCardData, BrokerCardResult, BrokerImportRow, QuestionDraft, QuestionRequestedPayload } from "./types";

/** `card_kind` values the daemon stamps on a broker card (`broker/cards.rs`). */
const BROKER_KINDS = ["broker_import", "broker_replace", "broker_policy"];

export function isBrokerCard(payload: QuestionRequestedPayload): boolean {
  return !!payload.broker_card && typeof payload.card_kind === "string" && BROKER_KINDS.includes(payload.card_kind);
}

/** How long the result stays on screen before the card leaves, and the card's own
 *  leave animation (`prompt-card--leaving`, 0.28s in permission-modal-shell.css). */
const RESULT_HOLD_MS = 2200;
const LEAVE_MS = 280;

type Phase = "ready" | "busy" | "done";

const HEADERS: Record<BrokerCardData["kind"], { icon: string; title: string }> = {
  import: { icon: "ph-download-simple", title: "Import tokens" },
  replace: { icon: "ph-key", title: "Token" },
  policy: { icon: "ph-shield-check", title: "Allow this call" },
};

const STATUS: Record<BrokerImportRow["status"], { icon: string; text: string }> = {
  copy: { icon: "ph-arrow-circle-right", text: "Will be copied" },
  kept: { icon: "ph-check-circle", text: "Already stored, kept" },
  missing: { icon: "ph-warning-circle", text: "Not in .env" },
  pc_only: { icon: "ph-desktop", text: "PC only" },
};

export interface BrokerCardHooks {
  /** The card is gone for good (answered, declined or dismissed by the daemon). */
  onSettled: () => void;
}

export function showBrokerCard(payload: QuestionRequestedPayload, hooks: BrokerCardHooks): void {
  const data = payload.broker_card;
  // The phone never gets these cards (the daemon filters them); a stray one is inert.
  if (!data || isRemote()) return;

  const { host } = ensureHost();
  let phase: Phase = "ready";
  let error: string | null = null;
  let result: string | null = null;
  let leaveTimer: number | undefined;

  const escHandler = (e: KeyboardEvent): void => {
    // Esc only folds the card to its bar: declining a token is a deliberate click.
    if (e.key === "Escape" && !isSettingsPopupOpen() && phase === "ready") minimize();
  };

  function teardown(): void {
    if (phase !== "ready") return; // busy or showing its result: its own timer leaves
    finish();
  }

  function finish(): void {
    window.clearTimeout(leaveTimer);
    clearHost();
    document.removeEventListener("keydown", escHandler);
    clearActiveCardIfCurrent(teardown);
  }

  /** The card's own exit: it sinks the way a minimized card does, and the node stays
   *  until that finishes. */
  function leave(): void {
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!card) { finish(); hooks.onSettled(); return; }
    card.classList.add("prompt-card--leaving");
    leaveTimer = window.setTimeout(() => { finish(); hooks.onSettled(); }, LEAVE_MS);
  }

  document.addEventListener("keydown", escHandler);
  const emptyDraft = (): QuestionDraft => ({ freeText: new Map(), selections: new Map(), activeTab: 0, additionalMessage: "", attachments: [] });
  setActiveCard({
    id: payload.id,
    sessionId: payload.session_id,
    displayId: payload.display_session_id,
    teardown,
    getDraft: emptyDraft,
    expand: () => {
      const bar = host.querySelector<HTMLElement>(".prompt-collapsed");
      if (!bar) return false;
      bar.click();
      return true;
    },
    isMinimized: () => !!host.querySelector(".prompt-collapsed"),
  });

  const face = askerFaceOf(payload);
  const head = HEADERS[data.kind];
  const title = `
    <span class="prompt-card__title">
      <i class="ph ${head.icon}"></i>
      ${escapeHtml(titleText())}
    </span>
    ${face ? `<span class="secret-card__from">${fromChipHtml(face)}</span>` : `<span class="secret-card__from"></span>`}
    <button type="button" class="icon-btn-sq prompt-icon-btn" data-act="minimize" title="Minimize to read the chat"><i class="ph ph-minus"></i></button>
  `;

  function titleText(): string {
    if (data!.kind === "replace") return `${data!.stored ? "Replace" : "Add"} token`;
    return head.title;
  }

  function importBody(d: Extract<BrokerCardData, { kind: "import" }>): string {
    const rows = d.rows
      .map((r, i) => {
        const s = STATUS[r.status];
        const from = r.status === "copy" && r.from ? ` <span class="broker-card__from">from ${escapeHtml(r.from)}</span>` : "";
        return `
          <li class="broker-card__row broker-card__row--${r.status}" style="--i:${i}">
            <i class="ph ${s.icon} broker-card__ico"></i>
            <span class="broker-card__what"><b>${escapeHtml(r.label)}</b><code>${escapeHtml(r.name)}</code>${from}</span>
            <span class="broker-card__state">${s.text}</span>
          </li>`;
      })
      .join("");
    const n = d.rows.filter((r) => r.status === "copy").length;
    return `
      <p class="broker-card__lede">Copies ${n} token${n === 1 ? "" : "s"} from <code>~/.claude/.env</code> into ${escapeHtml(d.machine)}'s protected store (${escapeHtml(d.store)}). The file is left as it is, and no value is shown.</p>
      <ul class="broker-card__rows">${rows}</ul>`;
  }

  function replaceBody(d: Extract<BrokerCardData, { kind: "replace" }>): string {
    const link = d.create_url
      ? `<a class="broker-card__link" href="${escapeHtml(d.create_url)}" target="_blank" rel="noopener">Create one <i class="ph ph-arrow-square-out"></i></a>`
      : "";
    return `
      <dl class="secret-card__ledger broker-card__ledger">
        <dt>Token</dt><dd><span class="secret-card__key">${escapeHtml(d.name)}</span></dd>
        <dt>For</dt><dd>${escapeHtml(d.label)}</dd>
        <dt>Store</dt><dd>${escapeHtml(d.machine)}: ${escapeHtml(d.store)}</dd>
      </dl>
      ${d.purpose ? `<p class="broker-card__lede">${escapeHtml(d.purpose)} ${link}</p>` : link}
      <div class="secret-card__input-wrap">
        <input type="password" class="secret-card__input" autocomplete="off" spellcheck="false"
          placeholder="${d.stored ? "Paste the new token" : "Paste the token"}" aria-label="Token value">
        <button type="button" class="secret-card__eye" data-act="peek" aria-label="Show value" title="Show value"><i class="ph ph-eye"></i></button>
      </div>`;
  }

  function policyBody(d: Extract<BrokerCardData, { kind: "policy" }>): string {
    const call = `${d.method ?? ""} ${d.path}`.trim();
    return `
      <dl class="secret-card__ledger broker-card__ledger">
        <dt>Service</dt><dd>${escapeHtml(d.service)}</dd>
        <dt>Call</dt><dd><span class="secret-card__key">${escapeHtml(call)}</span></dd>
        ${d.op ? `<dt>Operation</dt><dd><span class="secret-card__key">${escapeHtml(d.op)}</span></dd>` : ""}
        ${d.require_owner ? `<dt>Owner</dt><dd>Only your own items</dd>` : ""}
      </dl>
      <p class="broker-card__lede">Adds this line to <code>${escapeHtml(d.file)}</code>:</p>
      <pre class="broker-card__line">${escapeHtml(d.line)}</pre>`;
  }

  function resultHtml(): string {
    return `<div class="broker-card__result" role="status" tabindex="-1"><i class="ph ph-check-circle"></i><span>${escapeHtml(result ?? "Done")}</span></div>`;
  }

  function approveLabel(): string {
    if (data!.kind === "import") {
      const n = data!.rows.filter((r) => r.status === "copy").length;
      return `Import ${n}`;
    }
    return data!.kind === "replace" ? "Save" : "Allow";
  }

  function bodyHtml(): string {
    if (phase === "done") return resultHtml();
    const d = data!;
    const inner = d.kind === "import" ? importBody(d) : d.kind === "replace" ? replaceBody(d) : policyBody(d);
    // The error block is always in the DOM so it can ease open instead of popping in.
    const err = `<div class="broker-card__error${error ? " is-open" : ""}" role="alert"><div><i class="ph ph-warning-circle"></i> ${error ? escapeHtml(error) : ""}</div></div>`;
    return inner + err;
  }

  function footerHtml(): string {
    if (phase === "done") return "";
    return `
      <button type="button" class="btn btn-secondary" data-act="decline">Decline</button>
      <button type="button" class="btn btn-primary" data-act="approve"${data!.kind === "replace" ? " disabled" : ""}>${escapeHtml(approveLabel())}</button>
    `;
  }

  let rendered = false;
  function render(): void {
    host.innerHTML = renderCardShell(title, bodyHtml(), footerHtml());
    // A re-render (error, result) keeps the same card on screen, so it must not replay
    // the card's entrance.
    if (rendered) host.querySelector(".prompt-card")?.classList.add("prompt-card--no-anim");
    rendered = true;
    attach();
    // The buttons are gone in the result view: keep keyboard focus on the card, not the page.
    if (phase === "done") host.querySelector<HTMLElement>(".broker-card__result")?.focus({ preventScroll: true });
  }

  function input(): HTMLInputElement | null {
    return host.querySelector<HTMLInputElement>(".secret-card__input");
  }

  function setBusy(busy: boolean): void {
    const approve = host.querySelector<HTMLButtonElement>('[data-act="approve"]');
    const decline = host.querySelector<HTMLButtonElement>('[data-act="decline"]');
    const field = input();
    if (field) field.disabled = busy;
    if (decline) decline.disabled = busy;
    if (approve) {
      // Pin the width first: "Working..." is wider than "Allow" and the button would jump.
      if (busy) approve.style.minWidth = `${approve.offsetWidth}px`;
      approve.disabled = busy || (data!.kind === "replace" && !field?.value);
      approve.classList.toggle("is-busy", busy);
      approve.innerHTML = busy ? `<i class="ph ph-spinner secret-card__spin"></i> Working&hellip;` : escapeHtml(approveLabel());
    }
  }

  function showError(message: string): void {
    error = message;
    const box = host.querySelector<HTMLElement>(".broker-card__error");
    if (box) {
      box.firstElementChild!.innerHTML = `<i class="ph ph-warning-circle"></i> ${escapeHtml(message)}`;
      box.classList.add("is-open");
    }
  }

  function summarize(r: BrokerCardResult, action: "approve" | "decline"): string {
    if (action === "decline" || r.declined) return "Declined. Nothing was changed.";
    if (data!.kind === "import") {
      const stored = r.stored?.length ?? 0;
      const failed = r.failed?.length ?? 0;
      return failed ? `Imported ${stored}, ${failed} could not be stored.` : `Imported ${stored} token${stored === 1 ? "" : "s"}.`;
    }
    if (data!.kind === "replace") return "Token saved.";
    return r.added === false ? "That line was already in the policy." : "Policy line added.";
  }

  async function answer(action: "approve" | "decline"): Promise<void> {
    if (phase !== "ready") return;
    const field = input();
    // The ONLY place the typed token is read: straight into the call below.
    const value = action === "approve" && data!.kind === "replace" ? field?.value ?? "" : undefined;
    if (action === "approve" && data!.kind === "replace" && !value) return;
    phase = "busy";
    error = null;
    setBusy(true);
    try {
      const r = await invoke<BrokerCardResult | { ok: false; error: string }>("respond_broker_card", {
        requestId: payload.id,
        action,
        value: value ?? null,
      });
      if (field) field.value = "";
      if (!r || (r as { ok?: boolean }).ok === false) {
        throw new Error((r as { error?: string } | undefined)?.error ?? "The daemon refused the answer.");
      }
      phase = "done";
      result = summarize(r as BrokerCardResult, action);
      render();
      leaveTimer = window.setTimeout(leave, RESULT_HOLD_MS);
    } catch (e) {
      if (field) field.value = "";
      phase = "ready";
      const message = e instanceof Error ? e.message : String(e);
      render();
      showError(message);
      input()?.focus();
    }
  }

  // The card floats over the chat, and the message above it often says where the
  // token comes from. Hiding keeps the typed value in the input while the bar stands in.
  function minimize(): void {
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!card || host.querySelector(".prompt-collapsed")) return;
    const bar = document.createElement("div");
    bar.className = "prompt-collapsed prompt-collapsed--in";
    bar.style.setProperty("--dom", "var(--color-text-muted)");
    bar.innerHTML = `
      <span class="prompt-collapsed__dot"></span>
      <span class="prompt-collapsed__q">${escapeHtml(titleText())}</span>
      <button type="button" class="icon-btn-sq prompt-icon-btn" data-act="restore" title="Restore"><i class="ph ph-caret-up"></i></button>
    `;
    bar.addEventListener("click", () => {
      bar.remove();
      card.style.display = "";
      card.classList.add("prompt-card--expanding");
      input()?.focus();
    });
    card.classList.remove("prompt-card--expanding");
    card.style.display = "none"; // .prompt-card sets display:flex, which beats [hidden]
    host.appendChild(bar);
    announce();
  }

  function announce(): void {
    // Re-register so the dashboard's "waiting on you" list sees the collapsed state.
    window.dispatchEvent(new CustomEvent("cc-active-question-changed"));
  }

  function attach(): void {
    host.querySelector('[data-act="minimize"]')?.addEventListener("click", minimize);
    host.querySelector('[data-act="decline"]')?.addEventListener("click", () => void answer("decline"));
    const approve = host.querySelector<HTMLButtonElement>('[data-act="approve"]');
    approve?.addEventListener("click", () => void answer("approve"));
    const field = input();
    if (field && approve) {
      field.addEventListener("input", () => { approve.disabled = phase !== "ready" || !field.value; });
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !approve.disabled) { e.preventDefault(); void answer("approve"); }
      });
      const peek = host.querySelector<HTMLButtonElement>('[data-act="peek"]');
      peek?.addEventListener("click", () => {
        const show = field.type === "password";
        field.type = show ? "text" : "password";
        peek.setAttribute("aria-label", show ? "Hide value" : "Show value");
        peek.title = show ? "Hide value" : "Show value";
        peek.innerHTML = `<i class="ph ph-${show ? "eye-slash" : "eye"}"></i>`;
        field.focus();
      });
      field.focus();
    } else {
      approve?.focus();
    }
  }

  render();
}
