import { html, render } from "lit-html";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import type { Account } from "../../shared/api";
import { modalCardSlot, presentHostCard, closeHostCard, setBackdropCancel } from "../../shared/modal";
import { resolveInitialAccountId } from "./account-picker-logic";
import {
  accountPickIncomplete,
  renderAccountFieldHtml,
  attachAccountFieldHandlers,
  type AccountFieldState,
} from "./account-field";
import { createCharacterPane, cancelCharacterPaneSound, type CharacterPane } from "./character-pane";
import {
  EFFORTS,
  DEFAULT_PRESETS,
  type Preset as EffortPreset,
  type SessionConfig,
  readPresets,
  readLastChoice,
  readModels,
  readDefaultFlags,
  modelDisplayLabel,
  latestIdForFamily,
} from "../../shared/effort-presets";

export type { SessionConfig };
export type { EffortPreset };

export async function openModelEffortModal(
  projectPath: string,
  projectName: string,
): Promise<SessionConfig | null> {
  let settings: Record<string, unknown> = {};
  try {
    // The remote (phone) transport resolves get_settings to null rather than
    // throwing, so `?? {}` is load-bearing: without it readPresets(null) throws
    // on `.effortPresets` and the whole new-chat flow dead-ends back to the list.
    settings = (await invoke<Record<string, unknown> | null>("get_settings")) ?? {};
  } catch {
    // ignore — fall back to defaults
  }

  const presets = readPresets(settings);
  const models = readModels(settings);
  const defaultFlags = readDefaultFlags(settings);
  const normalPreset: EffortPreset =
    presets.find((p) => p.name === "Normal") ?? presets[1] ?? DEFAULT_PRESETS[1]!;
  const initial = readLastChoice(settings, projectPath) ?? { model: normalPreset.model, effort: normalPreset.effort };

  // Resolve projectId for whitelist + live-taken dedup, and the project's
  // bound account (if any) for the account picker below.
  let projectId: string | null = null;
  let preferredAccountId: string | null = null;
  try {
    const projects = await api.listProjects();
    const proj = projects.find((p) => String(p.path) === projectPath) as
      | { id: string; preferred_account_id?: string | null }
      | undefined;
    projectId = proj?.id ?? null;
    preferredAccountId = proj?.preferred_account_id ?? null;
  } catch {
    // stay null
  }

  // Account picker (multi-account milestone 04): resolve project binding ->
  // default -> sole-account fallback -> null (ambiguous/empty registry).
  let accounts: Account[] = [];
  try {
    accounts = await api.listAccounts();
  } catch {
    accounts = [];
  }
  const defaultAccountId = (settings["default_account_id"] as string | null | undefined) ?? null;
  const resolvedAccountId = resolveInitialAccountId(preferredAccountId, defaultAccountId, accounts);

  return new Promise<SessionConfig | null>((resolve) => {
    // Assigned once the shared host's morph transition (presentHostCard,
    // below) has mounted our card - every function here is only ever
    // CALLED after that (renderBody etc. are all deferred closures), so the
    // definite-assignment gap is safe.
    let card: HTMLElement;
    let charPane: CharacterPane;

    let model = initial.model;
    let effort = initial.effort;
    // Default flags come from settings (defaultAutoAllow / defaultRemoteControl),
    // NOT lastChoice, which doesn't store them. Both default on.
    let autoAccept = defaultFlags.autoAccept;
    let remote = defaultFlags.remote;
    let activePresetIndex = -1;
    // Per-model availability from the count_tokens probe. Empty until the probe
    // resolves; absent/true => model is selectable. A disabled model (e.g. Fable
    // 5 when Anthropic has it off) stays clickable but blocks "Start session".
    const availability: Record<string, boolean> = {};
    // Set when the backend's CLI-driven token-refresh retry still 401'd - the
    // account is genuinely logged out, not just "this model is disabled".
    // Distinct from per-model `availability` so the dialog shows a reconnect
    // prompt instead of a per-model "disabled" warning, and blocks Start
    // regardless of which model is selected (none of the probe data is
    // trustworthy while auth is expired).
    let authExpired = false;

    // ── Account picker state (multi-account milestone 04) ──────────────────────
    // Rendering/wiring live in account-field.ts; this modal just owns the
    // state and passes it in/out (see account-field.ts's AccountFieldState).
    const accountField: AccountFieldState = {
      accountId: resolvedAccountId,
      editingAccount: accounts.length > 0 && resolvedAccountId === null,
      remember: false,
    };

    function syncActivePreset() {
      activePresetIndex = presets.findIndex((p) => p.model === model && p.effort === effort);
    }
    syncActivePreset();

    function modelIdx(): number { return Math.max(0, models.indexOf(model)); }
    function effortIdx(): number { return Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number])); }
    function modelDisabled(): boolean { return availability[model] === false; }
    function sessionBlocked(): boolean { return authExpired || modelDisabled(); }

    function renderBody() {
      const presetButtons = presets.map((p, i) => `
        <button type="button" class="preset-btn${i === activePresetIndex ? " active" : ""}" data-idx="${i}">
          ${escapeHtml(p.name)}
        </button>
      `).join("");

      const modelLabels = models.map((m, i) => `
        <span class="slider-stop-label${i === modelIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(modelDisplayLabel(m))}</span>
      `).join("");
      const effortLabels = EFFORTS.map((e, i) => `
        <span class="slider-stop-label${i === effortIdx() ? " active" : ""}" data-stop="${i}">${escapeHtml(e)}</span>
      `).join("");

      card.innerHTML = `
        <div class="me-columns">
          <div class="me-columns">
            <div class="me-left-col">
              <h3 class="me-title">New session in ${escapeHtml(projectName)}</h3>
              ${renderAccountFieldHtml(accountField, { accounts, preferredAccountId, resolvedAccountId, projectName })}
              <div class="me-presets">${presetButtons}</div>

              <div class="me-field">
                <label class="me-label">Model</label>
                <input type="range" class="me-slider me-model-slider" min="0" max="${models.length - 1}" step="1" value="${modelIdx()}">
                <div class="me-stop-labels">${modelLabels}</div>
              </div>

              <div class="me-field">
                <label class="me-label">Effort</label>
                <input type="range" class="me-slider me-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx()}">
                <div class="me-stop-labels">${effortLabels}</div>
              </div>

              <details class="me-more">
                <summary class="me-more-summary"><i class="ph ph-caret-right"></i>More options</summary>
                <label class="me-check">
                  <input type="checkbox" class="me-auto-accept-input"${autoAccept ? " checked" : ""}>
                  Auto allow permissions
                </label>
                <label class="me-check">
                  <input type="checkbox" class="me-remote-input"${remote ? " checked" : ""}>
                  Remote chat
                </label>
              </details>

              ${authExpired
                ? `<div class="me-model-warning" role="alert">Claude login session expired - reconnect (run <code>claude</code> in a terminal to log back in), then reopen this dialog</div>`
                : modelDisabled()
                  ? `<div class="me-model-warning" role="alert">${escapeHtml(modelDisplayLabel(model))} is disabled, please choose another model</div>`
                  : ""}

              <div class="me-actions">
                <button type="button" class="me-cancel">Cancel</button>
                <button type="button" class="me-confirm"${(sessionBlocked() || accountPickIncomplete(accountField, accounts)) ? " disabled" : ""}>Start session</button>
              </div>
            </div>
            <div class="me-char-pane"></div>
          </div>
      `;
      attachHandlers();
      charPane.render();
    }

    function attachHandlers() {
      card.querySelectorAll<HTMLButtonElement>(".preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.idx);
          const p = presets[idx];
          if (!p) return;
          model = p.model;
          effort = p.effort;
          activePresetIndex = idx;
          renderBody();
        });
      });

      const modelSlider = card.querySelector<HTMLInputElement>(".me-model-slider");
      modelSlider?.addEventListener("input", () => {
        const i = Number(modelSlider.value);
        model = models[i] ?? model;
        syncActivePreset();
        renderBody();
      });

      const effortSlider = card.querySelector<HTMLInputElement>(".me-effort-slider");
      effortSlider?.addEventListener("input", () => {
        const i = Number(effortSlider.value);
        effort = EFFORTS[i] ?? effort;
        syncActivePreset();
        renderBody();
      });

      card.querySelector<HTMLInputElement>(".me-auto-accept-input")?.addEventListener("change", (e) => {
        autoAccept = (e.target as HTMLInputElement).checked;
      });

      card.querySelector<HTMLInputElement>(".me-remote-input")?.addEventListener("change", (e) => {
        remote = (e.target as HTMLInputElement).checked;
      });

      // ── Account picker (multi-account milestone 04) ──────────────────────────
      attachAccountFieldHandlers(card, accountField, renderBody, () => {
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

    /** Writes the "remember this account for the project" binding, if the
     * checkbox is ticked. Registers the project first if it isn't tracked
     * yet (mirrors the automation "Automate channel" CTA's ensureProject
     * call). Best-effort: a failure here never blocks starting the chat. */
    async function persistAccountBindingIfRequested(): Promise<void> {
      if (!accountField.remember || accountField.accountId === null) return;
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
      await persistAccountBindingIfRequested();
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
      } else if (e.key === "Enter") {
        e.preventDefault();
        void startWithCurrentConfig();
      }
    }

    setBackdropCancel(() => close(null));
    document.addEventListener("keydown", onKey);

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
      charPane = createCharacterPane(card, projectId);
      renderBody();

      // ── Load character pool in background (see character-pane.ts) ────────
      charPane.loadPool();

      // ── Probe model availability in background ───────────────────────────
      // Map family -> latest id (count_tokens rejects bare aliases), probe
      // those, key results back by family. Fails open on a transport error;
      // `authExpired: true` never does - see api.ts's ModelAvailability doc.
      const idByFamily = new Map<string, string>();
      for (const fam of models) {
        const id = latestIdForFamily(fam);
        if (id) idByFamily.set(fam, id);
      }
      if (idByFamily.size > 0) {
        void api.probeModelsAvailability([...idByFamily.values()])
          .then((results) => {
            authExpired = results.some((r) => r.authExpired);
            const byId = new Map(results.map((r) => [r.id, r.available]));
            for (const [fam, id] of idByFamily) availability[fam] = byId.get(id) ?? true;
            renderBody();
          })
          .catch(() => { /* fail open — leave all models enabled */ });
      }
    });
  });
}
