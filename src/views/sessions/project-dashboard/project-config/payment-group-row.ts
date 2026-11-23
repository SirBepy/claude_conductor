import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { escapeHtml } from "../../../../shared/escape-html";
import { readModels } from "../../../../shared/effort-presets";
import { closeKebabMenu, wireKebabMenu } from "../../../../shared/kebab-menu";
import { showView } from "../../../../shared/navigation";
import { ROUTING_KINDS } from "../../../../shared/routing-kinds";
import {
  overriddenKinds, projectGroup, readRule, requestGroupTab, seedOverride, writeOverride, type RouteOverrides,
} from "../../../../shared/routing-rules";
import { showToast } from "../../../../shared/toast";
import type { RoutingConfig } from "../../../../types/ipc.generated";
import { patchKeyedList } from "../../../settings/subviews/models-providers/keyed-list";
import type { SheetCtx } from "../../../settings/subviews/models-providers/role-sheet";
import { freeKinds, GROUP_OPTION_LABELS, groupShortName, menuItemsHtml, overrideRowHtml } from "./override-rows";
import type { ProjectCfg } from "./project-cfg";
import { openOverrideSheet } from "./role-override-sheet";
import "../../../settings/subviews/models-providers/models-providers.css";

// The previous mount's menu wiring holds document listeners; a re-render drops it first.
let disposeMenu: (() => void) | null = null;

/** The rail's Payment group block: which group this project takes its roles from
 *  (`ProjectConfig.payment_group`), the kinds it overrides (`routing_overrides`)
 *  and a way to add one. A project with no config yet is created on first change
 *  via `ensureProject`. Rows patch in place, so a save never replays an entrance. */
export async function renderPaymentGroupRow(cwd: string): Promise<void> {
  const select = document.getElementById("paymentGroupSelect") as HTMLSelectElement | null;
  const list = document.getElementById("paymentGroupRows");
  const fold = document.getElementById("paymentGroupEmpty");
  const addBtn = document.getElementById("paymentGroupAdd") as HTMLButtonElement | null;
  const menu = document.getElementById("paymentGroupMenu");
  const editLink = document.getElementById("paymentGroupEdit");
  if (!cwd || !select || !list || !fold || !addBtn || !menu || !editLink) return;
  disposeMenu?.();

  let accounts: Account[] = [];
  let projects: ProjectCfg[] = [];
  let settings: Record<string, unknown> = {};
  try {
    [accounts, projects, settings] = await Promise.all([
      api.listAccounts(),
      api.listProjects() as unknown as Promise<ProjectCfg[]>,
      api.getSettings().then((s) => (s ?? {}) as Record<string, unknown>),
    ]);
  } catch (e) {
    console.error("[project-settings] payment group load failed", e);
  }
  const proj = projects.find((p) => p.path === cwd);
  let projectId = proj?.id ?? null;
  let group = projectGroup(proj ?? {});
  let overrides: RouteOverrides = { ...(proj?.routing_overrides ?? {}) };
  let routing = settings["routing"] as RoutingConfig | undefined;
  let saved = group;
  let firstPaint = true;
  const claudeModels = readModels(settings);
  const sheetCtx = (): SheetCtx => ({ accounts, claudeModels });
  const projectName = (): string => (proj as { name?: string } | undefined)?.name || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  // Saves run one after another so two quick changes land in order.
  let chain: Promise<unknown> = Promise.resolve();
  const save = (patch: Record<string, unknown>, onFail?: () => void): void => {
    chain = chain.then(async () => {
      try {
        projectId ??= (await api.ensureProject(cwd)).id;
        await api.updateProject(projectId, patch);
      } catch (e) {
        console.error("[project-settings] update payment group failed", e);
        showToast(`Could not update the payment group: ${e}`);
        onFail?.();
      }
    });
  };

  const options = (): string => {
    const ids = Object.keys(GROUP_OPTION_LABELS);
    if (!ids.includes(group)) ids.push(group);
    return ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(GROUP_OPTION_LABELS[id] ?? id)}</option>`).join("");
  };
  select.innerHTML = options();

  const kindOrder = ROUTING_KINDS.map((k) => k.id);
  function paint(): void {
    select!.value = group;
    const kinds = overriddenKinds(overrides, kindOrder);
    patchKeyedList(list!, kinds.map((k) => ({
      key: k,
      html: overrideRowHtml(k, overrides[k]!, readRule(routing, group, k), accounts),
    })), {}, !firstPaint);
    fold!.classList.toggle("on", kinds.length === 0);
    fold!.querySelector(".pg-hint")!.textContent = `Every role uses the ${groupShortName(group)} payment group.`;
    menu!.innerHTML = menuItemsHtml(freeKinds(overrides));
    editLink!.querySelector(".ps-open-text")!.textContent = `Edit the ${groupShortName(group)} roles`;
  }
  paint();
  firstPaint = false;

  async function openSheetFor(kind: string): Promise<void> {
    // The group's rule is read fresh: the Settings page may have changed it since this rail drew.
    try { routing = ((await api.getSettings())?.["routing"] as RoutingConfig | undefined) ?? routing; } catch { /* keep the last read */ }
    const existing = overrides[kind];
    await openOverrideSheet({
      projectName: projectName(),
      groupId: group,
      kind,
      rule: existing ? { ...existing } : seedOverride(routing, group, kind),
      ctx: sheetCtx,
      onRule: (rule) => {
        overrides = writeOverride(overrides, kind, rule);
        paint();
        save({ routing_overrides: overrides });
      },
      onReset: () => {
        overrides = writeOverride(overrides, kind, null);
        paint();
        save({ routing_overrides: overrides });
        showToast(`Back to the ${groupShortName(group)} payment group`);
      },
    });
    const row = list!.querySelector<HTMLElement>(`.mp-diff[data-kind="${kind}"]`);
    (row ?? addBtn!).focus({ preventScroll: true });
  }

  select.onchange = () => {
    const next = select.value;
    if (next === group) return;
    const before = saved;
    group = next;
    saved = next;
    paint();
    save({ payment_group: next }, () => { group = before; saved = before; paint(); });
  };
  list.onclick = (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mp-diff");
    if (row?.dataset["kind"]) void openSheetFor(row.dataset["kind"]);
  };
  menu.onclick = (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".menu-item[data-kind]");
    if (!item) return;
    closeKebabMenu(menu);
    void openSheetFor(item.dataset["kind"]!);
  };
  disposeMenu = wireKebabMenu(addBtn, menu);
  editLink.onclick = () => {
    requestGroupTab(group);
    showView("settings-models-providers");
  };
}
