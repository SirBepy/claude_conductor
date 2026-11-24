// "Who does what" on Settings > Accounts & models (pc-1833 phase 2a): the routing
// rules per payment group, and the role sheet that edits one. Rules live in
// `Settings.routing.groups` (daemon side: src/routing/, docs/architecture/providers.md);
// this tab only reads and writes that one field through updateSettings. The page
// (accounts/accounts.ts) draws the markup (who-does-what.ts) and mounts this the
// first time the tab opens.

import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import type { RouteRule, RoutingConfig } from "../../../../types/ipc.generated";
import { escapeHtml } from "../../../../shared/escape-html";
import { readModels } from "../../../../shared/effort-presets";
import { updateSettings } from "../../../../shared/settings-update";
import { showToast } from "../../../../shared/toast";
import { routingKind } from "../../../../shared/routing-kinds";
import { PAYMENT_GROUPS, projectGroup, readRule, writeRule } from "../../../../shared/routing-rules";
import { cardsHtml } from "./role-cards";
import type { SheetCtx } from "./role-sheet";
import { mountSheetController, type SheetController } from "./sheet-controller";
import type { WhoHandle } from "./who-does-what";
import "../../../../shared/account-chip.css";
import "../../../../shared/kebab-menu.css";
import "../accounts/accounts.css";
import "./models-providers.css";

/** The two fields of a project this page reads; `api.listProjects` types the rest loosely. */
interface ProjectLite {
  name: string;
  payment_group?: string | null;
}

interface SheetState {
  group: string;
  kind: string;
  /** Owns the working rule (an empty object until something is set) and the sheet body's controls. */
  ctl: SheetController;
}

export interface WhoOptions {
  /** A payment group to open on (a link from a project's rail), or null for the first. */
  initialGroup: string | null;
}

/** Wires the markup of `whoTemplate()` and `sheetTemplate()` that the page already put under `root`. */
export async function mountWhoDoesWhat(root: HTMLElement, opts: WhoOptions): Promise<WhoHandle> {
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;

  let accounts: Account[] = [];
  let projects: ProjectLite[] = [];
  let routing: RoutingConfig = { groups: {} };
  let claudeModels: string[] = [];
  let tab = PAYMENT_GROUPS[0]!.id;
  let sheet: SheetState | null = null;
  let saveChain: Promise<unknown> = Promise.resolve();
  const sheetCtx = (): SheetCtx => ({ accounts, claudeModels });

  // The Accounts tab owns the list; it tells this tab when it changed, so a role's
  // account picker and the cards never name an account that was just removed.
  const onAccounts = (e: Event): void => {
    accounts = (e as CustomEvent<Account[]>).detail;
    paintCards();
  };
  root.addEventListener("accounts-changed", onAccounts);

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
    const t = root.querySelector<HTMLElement>("#mp-tabs .mp-tab.on");
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
    root.querySelectorAll<HTMLElement>("#mp-tabs .mp-tab").forEach((t) => {
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

  function openSheet(group: string, kind: string): void {
    const meta = routingKind(kind);
    if (!meta) return;
    const ctl = mountSheetController(q("#mp-sh-body"), {
      kind,
      rule: { ...(readRule(routing, group, kind) ?? {}) },
      ctx: sheetCtx,
      onRule: (rule) => persist(group, kind, rule),
    });
    sheet = { group, kind, ctl };
    const g = PAYMENT_GROUPS.find((x) => x.id === group);
    q("#mp-sh-rb").innerHTML = `<i class="${escapeHtml(meta.icon)}"></i>`;
    q("#mp-sh-title").textContent = meta.label;
    q("#mp-sh-sub").textContent = meta.blurb;
    q("#mp-sh-scope").innerHTML = `<i class="ph ${g?.icon ?? "ph-user"}"></i> ${escapeHtml(g?.label ?? group)} profile`;
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
    const { group, kind, ctl } = sheet;
    ctl.dispose();
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
    sheet.ctl.setRule({});
    persist(sheet.group, sheet.kind, null);
    showToast("Reset to default");
  };

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
  paintCards();
  if (opts.initialGroup && PAYMENT_GROUPS.some((g) => g.id === opts.initialGroup)) tab = opts.initialGroup;
  selectTab(tab);
  requestAnimationFrame(() => requestAnimationFrame(() => { moveInd(); fitPanels(); }));

  return {
    fit: () => { moveInd(); fitPanels(); },
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      root.removeEventListener("accounts-changed", onAccounts);
      resizeObs.disconnect();
    },
  };
}
