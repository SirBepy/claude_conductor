import { html, render } from "lit-html";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import type { Account } from "../../shared/api";
import { modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel, registerHostOptions } from "../../shared/modal";
import { settingsData, projectsListData, accountsListData, projectAccountData } from "./new-session-cache";
import { resolveModelEffortData } from "./model-effort-data";
import {
  accountPickIncomplete,
  renderAccountFieldHtml,
  attachAccountFieldHandlers,
  type AccountFieldState,
} from "./account-field";
import { attachChipKeyboardActivation } from "../../shared/account-chip";
import { createCharacterPane, cancelCharacterPaneSound, type CharacterPane } from "./character-pane";
import { createSliderController, type SliderController, type SliderKind } from "./slider-controller";
import { createModelProbeController, type ModelProbeController } from "./model-effort-probe";
import {
  EFFORTS,
  type SessionConfig,
  modelDisplayLabel,
} from "../../shared/effort-presets";

export type { SessionConfig };

export async function openModelEffortModal(
  projectPath: string,
  projectName: string,
): Promise<SessionConfig | null> {
  // Reads (each triggers/reuses a background revalidation - see
  // new-session-cache.ts) fire immediately so all four are in flight
  // concurrently regardless of how loadAndBuild() below awaits them.
  const settingsRead = settingsData();
  const projectsRead = projectsListData();
  const accountsRead = accountsListData();
  const projectAccountRead = projectAccountData(projectPath);
  // Cold: at least one of the four has no cached value yet, so the modal
  // opens on a loading shell instead of the real form (issue: this popup
  // used to show nothing at all while these awaits ran).
  const cold = settingsRead.cached === undefined || projectsRead.cached === undefined
    || accountsRead.cached === undefined || projectAccountRead.cached === undefined;

  return new Promise<SessionConfig | null>((resolve) => {
    // Assigned once loadAndBuild() (below) resolves the four reads above and
    // mounts the real card - every function here is only ever CALLED after
    // that (renderBody etc. are all deferred closures), so the
    // definite-assignment gap is safe.
    let card: HTMLElement;
    let charPane: CharacterPane;
    let slider: SliderController;
    let models: string[] = [];
    let projectId: string | null = null;
    let preferredAccountId: string | null = null;
    let accounts: Account[] = [];

    let model = "";
    let effort = "";
    // Default flags come from settings (defaultAutoAllow / defaultRemoteControl),
    // NOT lastChoice, which doesn't store them. Both default on.
    let autoAccept = true;
    let remote = true;
    // Replaces native <details>'s own open state now that the trigger lives
    // in the footer row instead of directly above the content it reveals.
    let moreOpen = false;

    // ── Account picker state (multi-account milestone 04) ──────────────────────
    // Rendering/wiring live in account-field.ts; this modal just owns the
    // state and passes it in/out (see account-field.ts's AccountFieldState).
    const accountField: AccountFieldState = {
      accountId: null,
    };

    function modelIdx(): number { return Math.max(0, models.indexOf(model)); }
    function effortIdx(): number { return Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number])); }
    function modelDisabled(): boolean { return probe.state.availability[model] === false; }
    function sessionBlocked(): boolean { return probe.state.authExpired || modelDisabled(); }

    // Model-availability probe + account cycling: see model-effort-probe.ts.
    const probe: ModelProbeController = createModelProbeController({
      accountField,
      getAccounts: () => accounts,
      renderBody,
    });

    function commitSliderValue(kind: SliderKind, idx: number): void {
      if (kind === "model") {
        const next = models[idx];
        if (!next) return;
        model = next;
      } else {
        const next = EFFORTS[idx];
        if (!next) return;
        effort = next;
      }
      renderBody();
    }

    function renderBody() {
      const flipFrom = card.hasChildNodes() ? slider.captureFlipState() : new Map<SliderKind, { fill: string; thumbLeft: string }>();

      const checkboxesHtml = `
        <label class="me-check">
          <input type="checkbox" class="me-auto-accept-input"${autoAccept ? " checked" : ""}>
          <span class="me-check-text">Auto allow permissions<span class="me-check-hint">Skips confirmation prompts when Claude wants to run a tool</span></span>
        </label>
        <label class="me-check">
          <input type="checkbox" class="me-remote-input"${remote ? " checked" : ""}>
          <span class="me-check-text">Remote chat<span class="me-check-hint">Reachable from the mobile app while this session runs</span></span>
        </label>
      `;

      card.innerHTML = `
        <div class="me-columns">
            <div class="me-left-col">
              <div class="me-header">
                <h3 class="title">New session</h3>
                <div class="me-project"><i class="ph ph-folder"></i> ${escapeHtml(projectName)}</div>
              </div>
              ${renderAccountFieldHtml(accountField, { accounts })}

              ${slider.html("model", "Model", modelIdx(), models.map(modelDisplayLabel), true, probe.state.modelProbeLoading ? ` <i class="ph ph-circle-notch me-label-spinner" aria-hidden="true" title="Checking availability..."></i>` : "")}

              ${moreOpen ? `<div class="me-more-body">${slider.html("effort", "Effort", effortIdx(), [...EFFORTS], false)}${checkboxesHtml}</div>` : ""}

              ${probe.state.authExpired
                ? `<div class="me-model-warning" role="alert">Claude login session expired - reconnect (run <code>claude</code> in a terminal to log back in), then reopen this dialog</div>`
                : modelDisabled()
                  ? `<div class="me-model-warning" role="alert">${escapeHtml(modelDisplayLabel(model))} is disabled, please choose another model</div>`
                  : accountPickIncomplete(accountField, accounts)
                    ? `<div class="me-model-warning" role="alert">Pick an account to start this session</div>`
                    : ""}

              <div class="me-actions">
                <button type="button" class="me-more-btn${moreOpen ? " open" : ""}"><i class="ph ph-caret-right"></i>More options</button>
                <div class="me-actions-right">
                  <button type="button" class="me-cancel">Cancel</button>
                  <button type="button" class="me-confirm"${(sessionBlocked() || accountPickIncomplete(accountField, accounts)) ? " disabled" : ""}>Start session</button>
                </div>
              </div>
            </div>
            <div class="me-char-pane"></div>
        </div>
      `;
      attachHandlers();
      charPane.render();

      slider.positionAll(modelIdx(), effortIdx());
      slider.playFlip(flipFrom);

      // Model stops are the only flat, number-selectable list here (todo
      // 835) - they already carry the .me-key-hint badge. Effort/checkboxes
      // aren't an ordered pick list, so they opt out.
      registerHostOptions(() =>
        Array.from(card.querySelectorAll<HTMLElement>('.slider-stop-label[data-kind="model"]')),
      );
    }

    function attachHandlers() {
      slider.wire();

      card.querySelector<HTMLInputElement>(".me-auto-accept-input")?.addEventListener("change", (e) => {
        autoAccept = (e.target as HTMLInputElement).checked;
      });

      card.querySelector<HTMLInputElement>(".me-remote-input")?.addEventListener("change", (e) => {
        remote = (e.target as HTMLInputElement).checked;
      });

      card.querySelector<HTMLButtonElement>(".me-more-btn")?.addEventListener("click", () => {
        moreOpen = !moreOpen;
        renderBody();
      });

      // ── Account picker (multi-account milestone 04) ──────────────────────────
      attachAccountFieldHandlers(card, accountField, probe.onAccountPicked, () => {
        close(null);
        // Route through the dashboard window rather than this window's own
        // router - navigating this (chats) window to settings-accounts left
        // no way back to the chat view (regression in 0.2.6/0.2.7).
        void invoke("open_dashboard_settings_accounts");
      });

      card.querySelector<HTMLButtonElement>(".me-cancel")?.addEventListener("click", () => close(null));
      card.querySelector<HTMLButtonElement>(".me-confirm")?.addEventListener("click", () => {
        void startWithCurrentConfig();
      });
    }

    async function persistChoice(): Promise<void> {
      try {
        const cur = (await invoke<Record<string, unknown> | null>("get_settings")) ?? {};
        const lc = (cur["projectLastChoice"] && typeof cur["projectLastChoice"] === "object")
          ? { ...(cur["projectLastChoice"] as Record<string, unknown>) }
          : {};
        lc[projectPath] = { model, effort };
        await invoke("save_settings", { updated: { ...cur, projectLastChoice: lc } });
      } catch (e) {
        console.error("[model-effort-modal] save_settings failed", e);
      }
    }

    /** Binds the picked account to the project so the next new session here
     * preselects it. Registers the project first if it isn't tracked yet
     * (mirrors the automation "Automate channel" CTA's ensureProject call).
     * Best-effort: a failure here never blocks starting the chat. */
    async function persistAccountBinding(): Promise<void> {
      if (accountField.accountId === null || accountField.accountId === preferredAccountId) return;
      try {
        let id = projectId;
        if (!id) {
          const ensured = await api.ensureProject(projectPath);
          id = ensured.id;
        }
        await api.updateProject(id, { preferred_account_id: accountField.accountId });
      } catch (e) {
        console.error("[model-effort-modal] persisting account binding failed", e);
      }
    }

    async function startWithCurrentConfig(): Promise<void> {
      if (sessionBlocked() || accountPickIncomplete(accountField, accounts)) return;
      await persistChoice();
      await persistAccountBinding();
      close({ model, effort, autoAccept, remote, characterId: charPane.currentCharacterId(), accountId: accountField.accountId });
    }

    function close(result: SessionConfig | null) {
      cancelCharacterPaneSound();
      closeHostCard();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void startWithCurrentConfig();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // The model/effort sliders own arrow keys while focused (see
        // slider-controller.ts's own keydown wiring) - don't double-handle.
        if ((document.activeElement as HTMLElement | null)?.closest(".me-slider-wrap")) return;
        e.preventDefault();
        probe.cycleAccount(e.key === "ArrowRight" ? 1 : -1);
      }
    }

    setBackdropCancel(() => close(null));
    document.addEventListener("keydown", onKey);

    // Cold cache: paint a loading shell now so the popup never sits blank
    // while the four reads above settle - loadAndBuild()'s own
    // presentHostCard() call morphs it into the real form once they land.
    // Warm cache: skip straight to loadAndBuild(), which resolves ~instantly.
    if (cold) {
      void presentHostCard(() => {
        render(
          html`<div
            class="modal-card modal-card-loading"
            role="dialog"
            aria-modal="true"
            aria-label="New session in ${projectName}"
          ><i class="ph ph-circle-notch" aria-hidden="true"></i> Loading&hellip;</div>`,
          modalCardSlot(),
        );
      });
    }

    async function loadAndBuild(): Promise<void> {
      const data = await resolveModelEffortData(
        projectPath,
        settingsRead,
        projectsRead,
        accountsRead,
        projectAccountRead,
      );
      models = data.models;
      model = data.model;
      effort = data.effort;
      autoAccept = data.autoAccept;
      remote = data.remote;
      projectId = data.projectId;
      preferredAccountId = data.preferredAccountId;
      accounts = data.accounts;
      accountField.accountId = data.accountId;
      probe.seedIdByFamily(data.idByFamily);

      void presentHostCard(() => {
        render(
          html`<div
            class="modal-card model-effort-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="New session in ${projectName}"
          ></div>`,
          modalCardSlot(),
        );
        card = modalCardSlot().querySelector<HTMLElement>(".model-effort-modal-card")!;
        // Attached once here (not in attachHandlers(), which reruns every
        // renderBody) so it doesn't stack a duplicate listener per re-render.
        attachChipKeyboardActivation(card);
        charPane = createCharacterPane(card, projectId);
        slider = createSliderController(card, { modelIdx, effortIdx, onCommit: commitSliderValue });

        probe.primeLoadingFlag();
        renderBody();

        // ── Load character pool in background (see character-pane.ts) ────────
        charPane.loadPool();

        probe.runProbe();
      });
    }

    void loadAndBuild();
  });
}
