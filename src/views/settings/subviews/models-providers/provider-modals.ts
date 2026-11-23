// The account modals of Settings > Models & providers: Add account (a provider
// select, then the fields that provider needs), Edit endpoint account and
// Replace key. All three sit on the shared modal host like the API-credit
// modals, and wipe the typed key from the DOM the moment they close.

import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import type { EndpointAuth, EndpointPreset } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../../shared/modal";
import { ENDPOINT_PRESETS, PROVIDER_META, type ProviderId } from "../../../../shared/provider-meta";
import { isValidEndpointModelId } from "../../../../shared/routing-rules";
import { openAddAccountWizard } from "../accounts/add-account-wizard";
import "../../../../shared/modal.css";
import "../../../../shared/api-key-modal.css";
import "./models-providers.css";

interface FormSpec<T> {
  ariaLabel: string;
  icon: string;
  title: string;
  bodyHtml: string;
  saveClass: string;
  idleLabel: string;
  busyLabel: string;
  focusSelector: string;
  cancelled: T;
  /** Wires the fields; call `sync` after any change that can flip the save button. */
  wire?: (card: HTMLElement, sync: () => void) => void;
  filled: (card: HTMLElement) => boolean;
  /** Runs the request. `release` closes the card first, for a save that hands off to another overlay. A throw shows as the error line. */
  save: (card: HTMLElement, release: () => void) => Promise<T>;
}

const field = <T extends HTMLElement>(card: HTMLElement, id: string): T => card.querySelector<T>(`#${id}`)!;
const val = (card: HTMLElement, id: string): string => field<HTMLInputElement>(card, id).value.trim();

/** Open, close, busy and error lifecycle for the three modals. While a save is in flight Escape, the backdrop and Cancel are ignored, so a request that still lands is never reported as cancelled. */
function openFormModal<T>(spec: FormSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let saving = false;
    let released = false;
    let card: HTMLElement | null = null;

    function close(result: T): void {
      document.removeEventListener("keydown", onKey);
      card?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((i) => { i.value = ""; });
      if (!released) closeHostCard();
      resolve(result);
    }
    const cancel = (): void => { if (!saving) close(spec.cancelled); };
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    document.addEventListener("keydown", onKey);
    setBackdropCancel(cancel);

    const saveBtn = (): HTMLButtonElement => card!.querySelector<HTMLButtonElement>(`.${spec.saveClass}`)!;
    const sync = (): void => { if (card) saveBtn().disabled = saving || !spec.filled(card); };

    async function doSave(): Promise<void> {
      if (!card || saving || !spec.filled(card)) return;
      saving = true;
      const err = card.querySelector<HTMLElement>(".aikm-error")!;
      err.hidden = true;
      saveBtn().disabled = true;
      saveBtn().innerHTML = `<i class="ph ph-spinner aikm-spin"></i> ${spec.busyLabel}&hellip;`;
      try {
        const release = (): void => {
          released = true;
          document.removeEventListener("keydown", onKey);
          closeHostCard();
        };
        close(await spec.save(card, release));
        return;
      } catch (e) {
        err.innerHTML = `<i class="ph ph-warning-circle"></i> ${escapeHtml(e instanceof Error ? e.message : String(e))}`;
        err.hidden = false;
      }
      saving = false;
      saveBtn().textContent = spec.idleLabel;
      sync();
    }

    void presentHostCard(() => {
      const el = document.createElement("div");
      el.className = "modal modal-card aikm-modal-card mp-modal";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", spec.ariaLabel);
      el.innerHTML = `
        <div class="modal-header"><i class="ph ${spec.icon}"></i><h3>${escapeHtml(spec.title)}</h3></div>
        <div class="modal-body">${spec.bodyHtml}<div class="aikm-error" hidden></div></div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary mp-modal-cancel">Cancel</button>
          <button type="button" class="btn-primary ${spec.saveClass}" disabled>${escapeHtml(spec.idleLabel)}</button>
        </div>`;
      modalCardSlot().replaceChildren(el);
      card = el;
      el.querySelector(".mp-modal-cancel")!.addEventListener("click", cancel);
      saveBtn().addEventListener("click", () => void doSave());
      el.addEventListener("input", sync);
      el.addEventListener("change", sync);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); void doSave(); }
      });
      spec.wire?.(el, sync);
      sync();
      el.querySelector<HTMLElement>(spec.focusSelector)?.focus();
    });
  });
}

const KEY_FIELD = `
  <div class="field">
    <label for="mpm-key">API key</label>
    <input type="password" id="mpm-key" class="aikm-field" autocomplete="off" spellcheck="false" placeholder="Paste the key value">
    <div class="mp-modal-hint"><i class="ph ph-lock-key"></i> Stored by Conductor, chats never see it.</div>
  </div>`;

const AUTH_OPTIONS = (selected: EndpointAuth): string =>
  `<option value="bearer"${selected === "bearer" ? " selected" : ""}>Bearer token (Authorization header)</option>`
  + `<option value="x_api_key"${selected === "x_api_key" ? " selected" : ""}>x-api-key header</option>`;

/** Comma or newline separated ids to a trimmed, de-duplicated list. */
export function parseModelIds(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The first id that cannot reach `claude --model`, or null when every one can. */
export function firstBadModelId(ids: readonly string[]): string | null {
  return ids.find((id) => !isValidEndpointModelId(id)) ?? null;
}

function checkedModels(card: HTMLElement): string[] {
  const ids = parseModelIds(val(card, "mpm-models"));
  const bad = firstBadModelId(ids);
  if (bad) throw new Error(`"${bad}" is not a usable model id. Use letters, digits and . _ : / ~ [ ] -.`);
  return ids;
}

function presetLine(provider: ProviderId): string {
  if (provider === "claude" || provider === "custom" || provider === "api_credit") return "";
  const p = ENDPOINT_PRESETS[provider];
  const models = p.models.length ? ` Models: ${p.models.join(", ")}.` : " Any model id works.";
  return `Talks to ${p.baseUrl} with ${p.authStyle === "bearer" ? "a bearer token" : "an x-api-key header"}.${models} The preset comes from the vendor's docs and stays unconfirmed until a key is tried. Edit it afterwards if it is off.`;
}

const PROVIDER_OPTIONS: ReadonlyArray<{ id: ProviderId; text: string }> = [
  { id: "claude", text: "Claude subscription (signs in with a browser)" },
  { id: "kimi_code", text: PROVIDER_META.kimi_code.label },
  { id: "deepseek", text: PROVIDER_META.deepseek.label },
  { id: "openrouter", text: PROVIDER_META.openrouter.label },
  { id: "custom", text: "Custom Anthropic-compatible endpoint" },
];

/** Resolves with the new account, or `null` when the modal closes without one. */
export function openAddProviderModal(existing: Account[]): Promise<Account | null> {
  let nameTouched = false;
  return openFormModal<Account | null>({
    ariaLabel: "Add account",
    icon: "ph-plus-circle",
    title: "Add account",
    saveClass: "mpm-save",
    idleLabel: "Sign in and add",
    busyLabel: "Adding",
    focusSelector: "#mpm-provider",
    cancelled: null,
    bodyHtml: `
      <div class="field">
        <label for="mpm-provider">Provider</label>
        <select id="mpm-provider" class="kit-select">${PROVIDER_OPTIONS.map((o) => `<option value="${o.id}">${escapeHtml(o.text)}</option>`).join("")}</select>
      </div>
      <div class="mp-fold on" id="mpm-claude"><div><p class="mp-modal-hint"><i class="ph ph-browser"></i> A browser opens for the sign-in; usage tracking works like your other Claude accounts.</p></div></div>
      <div class="mp-fold" id="mpm-endpoint"><div>
        <div class="field"><label for="mpm-label">Name</label><input type="text" id="mpm-label" class="aikm-field" autocomplete="off" spellcheck="false"></div>
        <div class="mp-fold" id="mpm-custom"><div>
          <div class="field"><label for="mpm-url">Base URL</label><input type="text" id="mpm-url" class="aikm-field" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/anthropic"></div>
          <div class="field"><label for="mpm-auth">How the key is sent</label><select id="mpm-auth" class="kit-select">${AUTH_OPTIONS("bearer")}</select></div>
          <div class="field"><label for="mpm-models">Model ids</label><input type="text" id="mpm-models" class="aikm-field" autocomplete="off" spellcheck="false" placeholder="comma separated, e.g. my-model-large, my-model-small"><div class="mp-modal-hint">Leave empty to type any id when you pick a model.</div></div>
        </div></div>
        <p class="mp-modal-hint mp-preset-line" id="mpm-preset"></p>
        ${KEY_FIELD}
      </div></div>`,
    wire: (card, sync) => {
      const provider = (): ProviderId => field<HTMLSelectElement>(card, "mpm-provider").value as ProviderId;
      const apply = (): void => {
        const p = provider();
        const claude = p === "claude";
        card.querySelector(".mpm-save")!.textContent = claude ? "Sign in and add" : "Add account";
        field(card, "mpm-claude").classList.toggle("on", claude);
        field(card, "mpm-endpoint").classList.toggle("on", !claude);
        field(card, "mpm-custom").classList.toggle("on", p === "custom");
        field(card, "mpm-preset").textContent = presetLine(p);
        if (!claude && !nameTouched) field<HTMLInputElement>(card, "mpm-label").value = PROVIDER_META[p].label;
        sync();
      };
      field(card, "mpm-provider").addEventListener("change", apply);
      field(card, "mpm-label").addEventListener("input", () => { nameTouched = true; });
      apply();
    },
    filled: (card) => {
      const p = field<HTMLSelectElement>(card, "mpm-provider").value as ProviderId;
      if (p === "claude") return true;
      if (!val(card, "mpm-label") || !val(card, "mpm-key")) return false;
      return p !== "custom" || val(card, "mpm-url").length > 0;
    },
    save: async (card, release) => {
      const p = field<HTMLSelectElement>(card, "mpm-provider").value as ProviderId;
      if (p === "claude") {
        release();
        return openAddAccountWizard(existing);
      }
      const preset = p as EndpointPreset;
      const spec = preset === "custom" ? null : ENDPOINT_PRESETS[preset];
      return api.addEndpointAccount({
        label: val(card, "mpm-label"),
        preset,
        baseUrl: spec ? spec.baseUrl : val(card, "mpm-url"),
        authStyle: spec ? spec.authStyle : (field<HTMLSelectElement>(card, "mpm-auth").value as EndpointAuth),
        models: spec ? [...spec.models] : checkedModels(card),
        apiKey: val(card, "mpm-key"),
      });
    },
  });
}

/** Resolves with the saved account, or `null` when closed without saving. The preset stays as it was. */
export function openEditEndpointModal(account: Account): Promise<Account | null> {
  const cfg = account.endpoint;
  return openFormModal<Account | null>({
    ariaLabel: "Edit account",
    icon: "ph-pencil-simple",
    title: `Edit ${account.label}`,
    saveClass: "mpm-save",
    idleLabel: "Save",
    busyLabel: "Saving",
    focusSelector: "#mpm-label",
    cancelled: null,
    bodyHtml: `
      <div class="field"><label for="mpm-label">Name</label><input type="text" id="mpm-label" class="aikm-field" autocomplete="off" spellcheck="false" value="${escapeHtml(account.label)}"></div>
      <div class="field"><label for="mpm-url">Base URL</label><input type="text" id="mpm-url" class="aikm-field" autocomplete="off" spellcheck="false" value="${escapeHtml(cfg?.base_url ?? "")}"></div>
      <div class="field"><label for="mpm-auth">How the key is sent</label><select id="mpm-auth" class="kit-select">${AUTH_OPTIONS(cfg?.auth_style ?? "bearer")}</select></div>
      <div class="field"><label for="mpm-models">Model ids</label><input type="text" id="mpm-models" class="aikm-field" autocomplete="off" spellcheck="false" value="${escapeHtml((cfg?.models ?? []).join(", "))}"><div class="mp-modal-hint">Leave empty to type any id when you pick a model.</div></div>`,
    filled: (card) => val(card, "mpm-label").length > 0 && val(card, "mpm-url").length > 0,
    save: (card) => api.updateEndpointAccount({
      accountId: account.id,
      label: val(card, "mpm-label"),
      baseUrl: val(card, "mpm-url"),
      authStyle: field<HTMLSelectElement>(card, "mpm-auth").value as EndpointAuth,
      models: checkedModels(card),
    }),
  });
}

/** Resolves `true` once the new key is stored. */
export function openReplaceEndpointKeyModal(account: { id: string; label: string }): Promise<boolean> {
  return openFormModal<boolean>({
    ariaLabel: "Replace API key",
    icon: "ph-key",
    title: "Replace API key",
    saveClass: "mpm-save",
    idleLabel: "Replace key",
    busyLabel: "Saving",
    focusSelector: "#mpm-key",
    cancelled: false,
    bodyHtml: `<p>Paste a new key for ${escapeHtml(account.label)}. It is not checked against the provider: a wrong key shows at the first chat.</p>${KEY_FIELD}`,
    filled: (card) => val(card, "mpm-key").length > 0,
    save: async (card) => {
      await api.replaceEndpointKey(account.id, val(card, "mpm-key"));
      return true;
    },
  });
}
