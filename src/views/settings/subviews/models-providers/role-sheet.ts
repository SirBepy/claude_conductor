// The role sheet: markup for one rule's editor and the pure reducer that turns
// a control change into the next rule. The view owns saving and the DOM events.

import type { Account, RouteRange, RouteRule } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { modelDisplayLabel } from "../../../../shared/effort-presets";
import { isJobKind } from "../../../../shared/routing-kinds";
import {
  effortChoices, fallbackValue, fullRange, isEndpoint, isRoutableAccount, isValidEndpointModelId, modelChoices,
  modelIsListed, normalizeRule, parseFallback, rangeEfforts, rangeModels, withAccount,
} from "../../../../shared/routing-rules";
import { selectHtml, type SelectOption } from "../../ui";
import { MODEL_RANK_COUNT, modelRank } from "../../../sessions/sidebar-row-visuals";
import { defaultFor, mainHtml, ruleView, type DefaultSpec } from "./role-cards";

/** The select value that reveals the free-text model field of an Endpoint account. */
export const OTHER_MODEL = "__other__";

export interface SheetCtx {
  accounts: readonly Account[];
  claudeModels: readonly string[];
  /** What a Default row runs today; absent where the sheet is not about the app-wide default. */
  defaults?: DefaultSpec;
}

const accountOf = (rule: RouteRule, ctx: SheetCtx): Account | undefined =>
  rule.account_id ? ctx.accounts.find((a) => a.id === rule.account_id) : undefined;

/** A Claude model's name with its place on the Haiku-Sonnet-Opus-Fable ladder, so a pick says how capable it is. */
const modelLabel = (account: Account | undefined, id: string): string => {
  if (isEndpoint(account)) return id;
  const rank = modelRank(id);
  return rank ? `${modelDisplayLabel(id)} (level ${rank} of ${MODEL_RANK_COUNT})` : modelDisplayLabel(id);
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function modelOptions(account: Account | undefined, ctx: SheetCtx): SelectOption[] {
  const opts: SelectOption[] = [{ value: "", label: "Default model" }];
  for (const m of modelChoices(account, ctx.claudeModels)) opts.push({ value: m, label: modelLabel(account, m) });
  if (isEndpoint(account)) opts.push({ value: OTHER_MODEL, label: "Other model id..." });
  return opts;
}

const effortOptions = (account: Account | undefined, withDefault: boolean): SelectOption[] =>
  [...(withDefault ? [{ value: "", label: "Default effort" }] : []), ...effortChoices(account).map((e) => ({ value: e, label: cap(e) }))];

function row(label: string, control: string): string {
  return `<div class="kit-row"><span class="kit-row-label">${escapeHtml(label)}</span>${control}</div>`;
}

/** Whether the model select shows "Other": the rule's id is not one the account lists. */
export function usesOtherModel(rule: RouteRule, ctx: SheetCtx): boolean {
  const account = accountOf(rule, ctx);
  return isEndpoint(account) && !!rule.model && !modelIsListed(account, rule.model, ctx.claudeModels);
}

export function summaryHtml(rule: RouteRule | undefined, ctx: SheetCtx, kindId = ""): string {
  // An empty working rule is the same as no rule: the summary says Default.
  return mainHtml(ruleView(rule ? normalizeRule(rule) ?? undefined : undefined, ctx.accounts, defaultFor(ctx.defaults, kindId)));
}

/** `otherOpen`: the free-text field is shown even though the rule has no custom id yet (the user just picked "Other"). */
export function sheetBodyHtml(kindId: string, rule: RouteRule, ctx: SheetCtx, otherOpen: boolean): string {
  const account = accountOf(rule, ctx);
  const routable = ctx.accounts.filter(isRoutableAccount);
  const accountOpts: SelectOption[] = [{ value: "", label: "Default account" }, ...routable.map((a) => ({ value: a.id, label: a.label }))];
  const modelSelected = usesOtherModel(rule, ctx) || otherOpen ? OTHER_MODEL : rule.model ?? "";
  const thenOpts: SelectOption[] = [
    { value: "", label: "Not set" },
    { value: "wait", label: "Wait for the limit to reset" },
    ...routable.filter((a) => a.id !== rule.account_id).map((a) => ({ value: `account:${a.id}`, label: `Use ${a.label}` })),
  ];
  const showOther = isEndpoint(account) && (usesOtherModel(rule, ctx) || otherOpen);
  const otherValue = usesOtherModel(rule, ctx) ? rule.model ?? "" : "";

  let flex = "";
  if (isJobKind(kindId)) {
    const models = rangeModels(account, ctx.claudeModels);
    const efforts = rangeEfforts(account);
    const r = rule.range ?? {};
    const sel = (id: string, opts: SelectOption[], v: string | undefined): string =>
      selectHtml({ id, className: "kit-select mp-kit-sel", options: opts, selected: v ?? opts[0]?.value });
    const mOpts = models.map((m) => ({ value: m, label: modelLabel(account, m) }));
    const eOpts = efforts.map((e) => ({ value: e, label: cap(e) }));
    flex = `
      <div class="kit-section"><div class="kit-section-title">Flexibility</div>
        <div class="kit-row"><span class="kit-row-label">Main chat may raise or lower this</span><label class="kit-toggle"><input type="checkbox" id="sh-flex" aria-label="Main chat may raise or lower this"${rule.range ? " checked" : ""}><span class="kit-toggle-track"></span></label></div>
        <p class="hint">The main chat can bump this up for a hard task or down for an easy one, but only inside the range below.</p>
        <div class="mp-fold${rule.range ? " on" : ""}" id="sh-fold"><div>
          ${models.length ? row("Lowest model", sel("sh-mnM", mOpts, r.min_model)) + row("Highest model", sel("sh-mxM", mOpts, r.max_model)) : ""}
          ${row("Lowest effort", sel("sh-mnE", eOpts, r.min_effort))}
          ${row("Highest effort", sel("sh-mxE", eOpts, r.max_effort))}
        </div></div>
      </div>`;
  }

  return `
    <div class="mp-summary" id="sh-sum">${summaryHtml(rule, ctx, kindId)}</div>
    <div class="kit-section"><div class="kit-section-title">Runs on</div>
      ${row("Account", selectHtml({ id: "sh-acc", className: "kit-select mp-kit-sel", options: accountOpts, selected: rule.account_id && account ? rule.account_id : "" }))}
      ${row("Model", selectHtml({ id: "sh-model", className: "kit-select mp-kit-sel", options: modelOptions(account, ctx), selected: modelSelected }))}
      <div class="mp-fold${showOther ? " on" : ""}" id="sh-other-fold"><div>
        ${row("Model id", `<input type="text" id="sh-model-other" class="kit-select mp-kit-sel" autocomplete="off" spellcheck="false" placeholder="the provider's model id" value="${escapeHtml(otherValue)}">`)}
        <p class="hint mp-field-error" id="sh-model-error" hidden></p>
      </div></div>
      ${row("Effort", selectHtml({ id: "sh-eff", className: "kit-select mp-kit-sel", options: effortOptions(account, true), selected: rule.effort ?? "" }))}
    </div>
    <div class="kit-section"><div class="kit-section-title">When the account hits its limit</div>
      ${row("Then", selectHtml({ id: "sh-then", className: "kit-select mp-kit-sel", options: thenOpts, selected: fallbackValue(rule.fallback) }))}
      <p class="hint">Checked when a chat starts: if the account is at its 5h or weekly limit, the chat moves to the fallback account, or starts blocked until the reset on Wait. A figure Conductor does not have never counts as a limit.</p>
    </div>
    ${flex}`;
}

export interface SheetChange {
  rule: RouteRule;
  /** The body must be redrawn (the account changed, so every list under it did). */
  redraw?: boolean;
  /** The model field reads this id but it is not a usable one: nothing was saved. */
  modelError?: string;
  /** The model select moved to or from "Other model id...": only the free-text fold needs to follow. */
  otherOpen?: boolean;
}

const RANGE_KEYS: Record<string, keyof RouteRange> = {
  "sh-mnM": "min_model", "sh-mxM": "max_model", "sh-mnE": "min_effort", "sh-mxE": "max_effort",
};

/** The next rule after the control `id` changed to `value` (`checked` for the switch). Pure: never mutates `rule`. */
export function applySheetChange(rule: RouteRule, id: string, value: string, checked: boolean, ctx: SheetCtx): SheetChange {
  const account = accountOf(rule, ctx);
  const next: RouteRule = { ...rule };
  switch (id) {
    case "sh-acc": {
      const to = value ? ctx.accounts.find((a) => a.id === value) : undefined;
      return { rule: withAccount(rule, value || undefined, to, ctx.claudeModels), redraw: true };
    }
    case "sh-model":
      if (value === OTHER_MODEL) return { rule, otherOpen: true };
      if (value) next.model = value; else delete next.model;
      return { rule: next, otherOpen: false };
    case "sh-model-other": {
      const id2 = value.trim();
      if (!id2) { delete next.model; return { rule: next, otherOpen: true }; }
      if (!isValidEndpointModelId(id2)) return { rule, modelError: "Use letters, digits and . _ : / ~ [ ] - (up to 128, not starting with -).", otherOpen: true };
      next.model = id2;
      return { rule: next, otherOpen: true };
    }
    case "sh-eff":
      if (value) next.effort = value; else delete next.effort;
      return { rule: next };
    case "sh-then": {
      const f = parseFallback(value);
      if (f) next.fallback = f; else delete next.fallback;
      return { rule: next };
    }
    case "sh-flex":
      if (checked) next.range = rule.range ?? fullRange(account, ctx.claudeModels); else delete next.range;
      return { rule: next };
    default: {
      const key = RANGE_KEYS[id];
      if (!key) return { rule };
      next.range = { ...(rule.range ?? fullRange(account, ctx.claudeModels)), [key]: value };
      return { rule: next };
    }
  }
}
