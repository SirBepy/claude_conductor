// Settings > Models & providers (pc-1833 phase 2a): every account a chat can run
// on, and "Who does what", the routing rules per payment group. Rules live in
// `Settings.routing.groups` (daemon side: src/routing/, docs/architecture/providers.md);
// this page only reads and writes that one field through updateSettings.

import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import type { RouteRule, RoutingConfig } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { readModels } from "../../../../shared/effort-presets";
import { updateSettings } from "../../../../shared/settings-update";
import { askConfirm } from "../../../../shared/confirm";
import { showToast } from "../../../../shared/toast";
import { closeKebabMenu, wireKebabMenu } from "../../../../shared/kebab-menu";
import { routingKind } from "../../../../shared/routing-kinds";
import { PAYMENT_GROUPS, normalizeRule, projectGroup, readRule, writeRule } from "../../../../shared/routing-rules";
import { settingsHeader } from "../../ui";
import { openEditAccountModal } from "../accounts/edit-account-modal";
import { openReplaceApiKeyModal } from "../accounts/add-api-credit-modal";
import { accountRowHtml, codexRowHtml } from "./account-rows";
import { patchKeyedList } from "./keyed-list";
import { openAddProviderModal, openEditEndpointModal, openReplaceEndpointKeyModal } from "./provider-modals";
import { cardsHtml } from "./role-cards";
import { applySheetChange, sheetBodyHtml, summaryHtml, type SheetCtx } from "./role-sheet";
import "../../../../shared/account-chip.css";
import "../../../../shared/kebab-menu.css";
import "../accounts/accounts.css";
import "./models-providers.css";

const TIP = "A chat's own pick, then the project's routing, then its payment group's roles, then the default.";

/** The two fields of a project this page reads; `api.listProjects` types the rest loosely. */
interface ProjectLite {
  name: string;
  payment_group?: string | null;
}

interface SheetState {
  group: string;
  kind: string;
  /** The working rule; an empty object until something is set. */
  rule: RouteRule;
  otherOpen: boolean;
}

function template() {
  return html`
    <div class="view view-settings-models-providers">
      <div class="mp-page" id="mp-page">
        ${settingsHeader("Models & providers", {
          end: html`<div class="mp-hdr-end"><span class="mp-tipbtn" tabindex="0" role="button" aria-label="Which setting wins"><i class="ph ph-info"></i>
            <span class="mp-tip" role="tooltip"><b>Which setting wins</b>${TIP}</span></span></div>`,
        })}
        <div class="view-body">
          <div class="view-body-inner mp-inner">
            <div class="kit-section">
              <div class="kit-section-title">Accounts</div>
              <p class="acc-explainer">Each account is a place chats can run. Add as many Claude subscriptions as you like; the others use a key Conductor stores for you.</p>
              <div class="acc-list">
                <div id="mp-acc-rows" class="mp-acc-rows"></div>
                ${unsafeHTML(codexRowHtml())}
              </div>
              <div class="acc-add-row"><button class="btn-secondary" id="mp-add-btn"><i class="ph ph-plus"></i> Add account</button></div>
            </div>

            <div class="kit-section">
              <div class="kit-section-title">Who does what</div>
              <div class="mp-tabs" id="mp-tabs" role="tablist">
                ${PAYMENT_GROUPS.map((g, i) => html`<button type="button" class="mp-tab${i === 0 ? " on" : ""}" role="tab" id="mp-tab-${g.id}" aria-selected=${i === 0 ? "true" : "false"} aria-controls="mp-panel-${g.id}" data-group=${g.id}><i class="ph ${g.icon}"></i> ${g.label} <span class="cnt" id="mp-cnt-${g.id}"></span></button>`)}
                <span class="mp-ind" id="mp-ind"></span>
              </div>
              <div class="mp-panels" id="mp-panels">
                ${PAYMENT_GROUPS.map((g, i) => html`<div class="mp-panel${i === 0 ? " on" : ""}" id="mp-panel-${g.id}" role="tabpanel" aria-labelledby="mp-tab-${g.id}" ?inert=${i !== 0}>
                  <div class="mp-projects" id="mp-proj-${g.id}"></div>
                  <div id="mp-cards-${g.id}"></div>
                </div>`)}
              </div>
            </div>
            <div class="mp-foot"><i class="ph ph-info"></i> Helpers a chat starts inside itself use that chat's account.</div>
          </div>
        </div>
      </div>

      <div class="mp-sheet" id="mp-sheet" aria-hidden="true" inert role="dialog" aria-label="Role settings">
        <div class="view-header">
          <button class="icon-btn" id="mp-sh-back" title="Back" aria-label="Back"><i class="ph ph-arrow-left"></i></button>
          <div class="hd"><span class="mp-rb" id="mp-sh-rb"></span><div><h2 id="mp-sh-title"></h2><small id="mp-sh-sub"></small></div></div>
        </div>
        <div class="view-body"><div class="view-body-inner mp-inner mp-inner-narrow">
          <div class="mp-scope" id="mp-sh-scope"></div>
          <div id="mp-sh-body"></div>
        </div></div>
        <div class="mp-sheet-foot">
          <button class="btn-secondary" id="mp-sh-reset"><i class="ph ph-arrow-counter-clockwise"></i> Reset to default</button>
          <button class="btn-primary" id="mp-sh-done">Done</button>
        </div>
      </div>
    </div>`;
}

export async function renderModelsProvidersView(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;

  let accounts: Account[] = [];
  let projects: ProjectLite[] = [];
  let routing: RoutingConfig = { groups: {} };
  let claudeModels: string[] = [];
  let tab = PAYMENT_GROUPS[0]!.id;
  let sheet: SheetState | null = null;
  let firstPaint = true;
  let saveChain: Promise<unknown> = Promise.resolve();
  const disposers = new Map<HTMLElement, () => void>();
  const sheetCtx = (): SheetCtx => ({ accounts, claudeModels });

  // ── Accounts ────────────────────────────────────────────────────────────
  const list = q("#mp-acc-rows");

  function paintAccounts(): void {
    patchKeyedList(list, accounts.map((a) => ({ key: a.id, html: accountRowHtml(a) })), {
      onRow: (row) => {
        const btn = row.querySelector<HTMLButtonElement>(".acc-btn-kebab");
        const menu = row.querySelector<HTMLElement>(".menu-popover");
        if (btn && menu) disposers.set(row, wireKebabMenu(btn, menu));
      },
      onGone: (row) => { disposers.get(row)?.(); disposers.delete(row); },
    }, !firstPaint);
  }

  async function refreshAccounts(): Promise<void> {
    accounts = await api.listAccounts();
    paintAccounts();
    paintCards();
  }

  // One menu open at a time: close the others before this kebab's own handler toggles it.
  list.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".acc-btn-kebab");
    if (!btn) return;
    const mine = btn.nextElementSibling;
    list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((m) => { if (m !== mine) closeKebabMenu(m); });
  }, true);

  list.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".menu-item[data-act]");
    if (!item) return;
    const account = accounts.find((a) => a.id === item.dataset["id"]);
    list.querySelectorAll<HTMLElement>(".menu-popover:not(.hidden)").forEach((m) => closeKebabMenu(m));
    if (account) void runAccountAction(item.dataset["act"]!, account);
  });

  async function runAccountAction(act: string, account: Account): Promise<void> {
    try {
      if (act === "edit") {
        const saved = account.kind === "endpoint" ? await openEditEndpointModal(account) : await openEditAccountModal(account);
        if (saved) await refreshAccounts();
      } else if (act === "key") {
        const done = account.kind === "endpoint" ? await openReplaceEndpointKeyModal(account) : await openReplaceApiKeyModal(account);
        if (done) showToast("API key replaced.");
      } else if (act === "reauth") {
        await api.reauthAccount(account.id);
        showToast("A terminal opened for /login. Reload the list once you finish.");
      } else if (act === "remove") {
        const text = account.kind === "endpoint"
          ? `Remove ${account.label}? Its stored key is deleted. A role that uses it goes back to the default.`
          : `Remove ${account.label}? ${account.kind === "api_credit" ? "Chats can no longer be started on it." : "This deletes its profile folder and its browser login; it never touches ~/.claude."} A role that uses it goes back to the default.`;
        if (!(await askConfirm(text, { confirmLabel: "Remove" }))) return;
        await api.removeAccount(account.id);
        await refreshAccounts();
      }
    } catch (e) {
      console.error("[models-providers] account action failed", act, e);
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  q<HTMLButtonElement>("#mp-add-btn").onclick = () => {
    void (async () => {
      const btn = q<HTMLButtonElement>("#mp-add-btn");
      btn.disabled = true;
      try {
        const created = await openAddProviderModal(accounts);
        if (created) await refreshAccounts();
      } finally {
        btn.disabled = false;
      }
    })();
  };

  // ── Who does what ───────────────────────────────────────────────────────
  function paintCards(): void {
    for (const g of PAYMENT_GROUPS) {
      q(`#mp-cards-${g.id}`).innerHTML = cardsHtml(g.id, routing, accounts);
      const names = projects.filter((p) => projectGroup(p) === g.id);
      q(`#mp-proj-${g.id}`).innerHTML = names.length
        ? `Used by${names.map((p) => `<span class="mp-chip"><i class="ph ${g.chipIcon}"></i>${escapeHtml(p.name)}</span>`).join("")}`
        : "No project uses this group yet";
      q(`#mp-cnt-${g.id}`).textContent = String(names.length);
    }
  }

  const panels = q("#mp-panels");
  const fitPanels = (): void => {
    const p = root.querySelector<HTMLElement>(".mp-panel.on");
    if (p) panels.style.height = `${p.offsetHeight}px`;
  };
  const moveInd = (): void => {
    const t = root.querySelector<HTMLElement>(".mp-tab.on");
    const ind = q("#mp-ind");
    if (!t) return;
    ind.style.width = `${t.offsetWidth}px`;
    ind.style.transform = `translateX(${t.offsetLeft}px)`;
  };
  // The panel's own height follows its content (a card set that grows, a window resize).
  const resizeObs = new ResizeObserver(() => { fitPanels(); moveInd(); });
  root.querySelectorAll(".mp-panel").forEach((p) => resizeObs.observe(p));

  function selectTab(group: string): void {
    tab = group;
    root.querySelectorAll<HTMLElement>(".mp-tab").forEach((t) => {
      const on = t.dataset["group"] === group;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>(".mp-panel").forEach((p) => {
      const on = p.id === `mp-panel-${group}`;
      p.classList.toggle("on", on);
      p.toggleAttribute("inert", !on);
    });
    moveInd();
    fitPanels();
  }
  q("#mp-tabs").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".mp-tab");
    if (t) selectTab(t.dataset["group"]!);
  });
  q("#mp-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const ids = PAYMENT_GROUPS.map((g) => g.id);
    const next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]!;
    selectTab(next);
    q(`#mp-tab-${next}`).focus();
  });

  // ── Role sheet ──────────────────────────────────────────────────────────
  const sheetEl = q("#mp-sheet");
  const pageEl = q("#mp-page");

  /** Persists the rule for (group, kind). Saves are chained so two quick changes land in order. */
  function persist(group: string, kind: string, rule: RouteRule | null): void {
    routing = writeRule(routing, group, kind, rule);
    saveChain = saveChain.then(() => updateSettings((s) => {
      s["routing"] = writeRule(s["routing"] as RoutingConfig | undefined, group, kind, rule);
    })).catch((e) => {
      console.error("[models-providers] saving the rule failed", e);
      showToast("Couldn't save the rule - see the console.");
    });
  }

  function paintSheetBody(): void {
    if (!sheet) return;
    const body = q("#mp-sh-body");
    const scroller = body.closest<HTMLElement>(".view-body")!;
    const top = scroller.scrollTop;
    body.innerHTML = sheetBodyHtml(sheet.kind, sheet.rule, sheetCtx(), sheet.otherOpen);
    scroller.scrollTop = top;
  }

  function openSheet(group: string, kind: string): void {
    const meta = routingKind(kind);
    if (!meta) return;
    sheet = { group, kind, rule: { ...(readRule(routing, group, kind) ?? {}) }, otherOpen: false };
    const g = PAYMENT_GROUPS.find((x) => x.id === group);
    q("#mp-sh-rb").innerHTML = `<i class="${escapeHtml(meta.icon)}"></i>`;
    q("#mp-sh-title").textContent = meta.label;
    q("#mp-sh-sub").textContent = meta.blurb;
    q("#mp-sh-scope").innerHTML = `<i class="ph ${g?.icon ?? "ph-user"}"></i> ${escapeHtml(g?.label ?? group)} profile`;
    paintSheetBody();
    sheetEl.classList.add("open");
    sheetEl.setAttribute("aria-hidden", "false");
    sheetEl.removeAttribute("inert");
    pageEl.setAttribute("inert", "");
    root.classList.add("sheet-open");
    q("#mp-sh-body").closest<HTMLElement>(".view-body")!.scrollTop = 0;
    setTimeout(() => q<HTMLButtonElement>("#mp-sh-back").focus({ preventScroll: true }), 40);
  }

  function closeSheet(): void {
    if (!sheet) return;
    const { group, kind } = sheet;
    sheet = null;
    sheetEl.classList.remove("open");
    sheetEl.setAttribute("aria-hidden", "true");
    sheetEl.setAttribute("inert", "");
    pageEl.removeAttribute("inert");
    root.classList.remove("sheet-open");
    paintCards();
    root.querySelector<HTMLElement>(`.mp-card[data-group="${group}"][data-kind="${kind}"]`)?.focus({ preventScroll: true });
  }

  root.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".mp-card");
    if (card) openSheet(card.dataset["group"]!, card.dataset["kind"]!);
  });
  q("#mp-sh-back").onclick = closeSheet;
  q("#mp-sh-done").onclick = closeSheet;
  q("#mp-sh-reset").onclick = () => {
    if (!sheet) return;
    sheet.rule = {};
    sheet.otherOpen = false;
    persist(sheet.group, sheet.kind, null);
    paintSheetBody();
    showToast("Reset to default");
  };

  const onSheetChange = (e: Event): void => {
    if (!sheet) return;
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (!el.id?.startsWith("sh-")) return;
    const res = applySheetChange(sheet.rule, el.id, el.value, (el as HTMLInputElement).checked === true, sheetCtx());
    const err = root.querySelector<HTMLElement>("#sh-model-error");
    if (err) { err.hidden = !res.modelError; err.textContent = res.modelError ?? ""; }
    if (res.modelError) return;
    sheet.rule = res.rule;
    if (res.otherOpen !== undefined) {
      sheet.otherOpen = res.otherOpen;
      root.querySelector("#sh-other-fold")?.classList.toggle("on", res.otherOpen);
    }
    persist(sheet.group, sheet.kind, normalizeRule(sheet.rule));
    if (res.redraw) paintSheetBody();
    else if (el.id === "sh-flex") root.querySelector("#sh-fold")?.classList.toggle("on", (el as HTMLInputElement).checked);
    root.querySelector("#sh-sum")!.innerHTML = summaryHtml(sheet.rule, sheetCtx());
  };
  q("#mp-sh-body").addEventListener("change", onSheetChange);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !sheet) return;
    // A modal on the shared host owns Escape while it is open.
    if (document.getElementById("modal-host")?.classList.contains("open")) return;
    closeSheet();
  };
  document.addEventListener("keydown", onKey);

  // ── Load ────────────────────────────────────────────────────────────────
  try {
    const [accs, projs, settings] = await Promise.all([api.listAccounts(), api.listProjects(), api.getSettings()]);
    accounts = accs;
    projects = projs as unknown as ProjectLite[];
    routing = ((settings?.["routing"] as RoutingConfig | undefined) ?? { groups: {} });
    claudeModels = readModels(settings ?? {});
  } catch (e) {
    console.error("[models-providers] load failed", e);
    showToast("Couldn't load accounts or rules - see the console.");
  }
  paintAccounts();
  firstPaint = false;
  paintCards();
  selectTab(tab);
  requestAnimationFrame(() => requestAnimationFrame(() => { moveInd(); fitPanels(); }));

  return () => {
    document.removeEventListener("keydown", onKey);
    resizeObs.disconnect();
    disposers.forEach((d) => d());
    disposers.clear();
  };
}
