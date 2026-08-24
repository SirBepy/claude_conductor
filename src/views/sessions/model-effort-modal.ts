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
import { attachChipKeyboardActivation } from "../../shared/account-chip";
import { createCharacterPane, cancelCharacterPaneSound, type CharacterPane } from "./character-pane";
import {
  EFFORTS,
  type SessionConfig,
  readLastChoice,
  readModels,
  readDefaultFlags,
  modelDisplayLabel,
  latestIdForFamily,
} from "../../shared/effort-presets";

export type { SessionConfig };

type SliderKind = "model" | "effort";

export async function openModelEffortModal(
  projectPath: string,
  projectName: string,
): Promise<SessionConfig | null> {
  let settings: Record<string, unknown> = {};
  try {
    // The remote (phone) transport resolves get_settings to null rather than
    // throwing, so `?? {}` is load-bearing: without it readModels(null) throws
    // and the whole new-chat flow dead-ends back to the list.
    settings = (await invoke<Record<string, unknown> | null>("get_settings")) ?? {};
  } catch {
    // ignore — fall back to defaults
  }

  const models = readModels(settings);
  const defaultFlags = readDefaultFlags(settings);
  // No presets anymore - first-ever session in a project defaults to Opus/high.
  const initial = readLastChoice(settings, projectPath) ?? { model: "opus", effort: "high" };

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
  // Backend-normalized override: resolves worktree/casing cases the raw
  // find() above misses. On throw (e.g. remote transport, no mirror yet)
  // keep the raw-match result from above as a best-effort fallback.
  try {
    preferredAccountId = await api.resolveProjectAccount(projectPath);
  } catch {
    // keep raw-match fallback
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
    // True while the availability probe below is in flight - the only one of
    // the modal's two background loads with no prior loading affordance.
    let modelProbeLoading = false;
    // Replaces native <details>'s own open state now that the trigger lives
    // in the footer row instead of directly above the content it reveals.
    let moreOpen = false;

    // ── Account picker state (multi-account milestone 04) ──────────────────────
    // Rendering/wiring live in account-field.ts; this modal just owns the
    // state and passes it in/out (see account-field.ts's AccountFieldState).
    const accountField: AccountFieldState = {
      accountId: resolvedAccountId,
      editingAccount: accounts.length > 0 && resolvedAccountId === null,
      remember: false,
    };

    function modelIdx(): number { return Math.max(0, models.indexOf(model)); }
    function effortIdx(): number { return Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number])); }
    function modelDisabled(): boolean { return availability[model] === false; }
    function sessionBlocked(): boolean { return authExpired || modelDisabled(); }

    // ── Custom animated slider ──────────────────────────────────────────────
    // Native <input type=range> can't animate its thumb on a programmatic
    // value change (WebKit/Blink snap instantly - thumb position isn't a
    // transitionable CSS property), so track+fill+thumb are plain divs here.

    function sliderHtml(kind: SliderKind, label: string, idx: number, stops: string[], keyHints: boolean): string {
      const max = stops.length - 1;
      const stopsHtml = stops.map((s, i) => `
        <button type="button" class="slider-stop-label${i === idx ? " active" : ""}" data-kind="${kind}" data-idx="${i}">${escapeHtml(s)}${keyHints && i < 9 ? `<span class="me-key-hint">${i + 1}</span>` : ""}</button>
      `).join("");
      return `
        <div class="me-field">
          <label class="me-label">${escapeHtml(label)}${kind === "model" && modelProbeLoading ? ` <i class="ph ph-circle-notch me-label-spinner" aria-hidden="true" title="Checking availability..."></i>` : ""}</label>
          <div class="me-slider-wrap" data-kind="${kind}" data-min="0" data-max="${max}" role="slider" tabindex="0"
            aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${idx}" aria-valuetext="${escapeHtml(stops[idx] ?? "")}">
            <div class="me-slider-track"><div class="me-slider-fill"></div><div class="me-slider-thumb"></div></div>
          </div>
          <div class="me-stop-labels">${stopsHtml}</div>
        </div>
      `;
    }

    /** Snaps one slider's fill/thumb to `idx`, transition disabled - the
     * correct-position baseline every render needs before FLIP can animate
     * away from it, and the live-tracking update while dragging. */
    function positionSliderInstant(wrap: HTMLElement, idx: number): void {
      const max = Number(wrap.dataset.max);
      const pct = max > 0 ? (idx / max) * 100 : 0;
      const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
      const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
      if (!fill || !thumb) return;
      fill.style.transition = "none";
      thumb.style.transition = "none";
      fill.style.transform = `scaleX(${pct / 100})`;
      thumb.style.left = `${pct}%`;
      fill.getBoundingClientRect(); // force reflow before re-enabling transition
      fill.style.transition = "";
      thumb.style.transition = "";
    }

    function setActiveLabel(kind: SliderKind, idx: number): void {
      card.querySelectorAll<HTMLElement>(`.slider-stop-label[data-kind="${kind}"]`).forEach((el) => {
        el.classList.toggle("active", Number(el.dataset.idx) === idx);
      });
    }

    /** FLIP "first" step - captures each slider's on-screen position right
     * before renderBody() tears the DOM down and rebuilds it. */
    function captureSliderFlipState(): Map<SliderKind, { fill: string; thumbLeft: string }> {
      const out = new Map<SliderKind, { fill: string; thumbLeft: string }>();
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
        const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
        if (fill && thumb) out.set(kind, { fill: fill.style.transform, thumbLeft: thumb.style.left });
      });
      return out;
    }

    /** FLIP "last/invert/play" - snaps each still-present slider back to its
     * pre-render position, forces reflow, then lets the CSS transition carry
     * it to the position renderBody() already set. A slider with no prior
     * entry (e.g. Effort on first "More options" open) just appears. */
    function playSliderFlip(from: Map<SliderKind, { fill: string; thumbLeft: string }>): void {
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const prev = from.get(kind);
        if (!prev) return;
        const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
        const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
        if (!fill || !thumb) return;
        const finalFill = fill.style.transform;
        const finalLeft = thumb.style.left;
        if (prev.fill === finalFill) return; // value didn't change - nothing to animate
        fill.style.transition = "none";
        thumb.style.transition = "none";
        fill.style.transform = prev.fill;
        thumb.style.left = prev.thumbLeft;
        fill.getBoundingClientRect(); // force reflow
        fill.style.transition = "";
        thumb.style.transition = "";
        fill.style.transform = finalFill;
        thumb.style.left = finalLeft;
      });
    }

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

    function wireSliders(): void {
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const min = Number(wrap.dataset.min);
        const max = Number(wrap.dataset.max);
        const track = wrap.querySelector<HTMLElement>(".me-slider-track")!;

        function idxFromClientX(clientX: number): number {
          const rect = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
          return Math.round(min + ratio * (max - min));
        }

        // Live 1:1 tracking while dragging (no transition - matches a native
        // slider's feel); the value only commits (and animates, via the FLIP
        // pass in renderBody) on release.
        let dragging = false;
        wrap.addEventListener("pointerdown", (e) => {
          dragging = true;
          wrap.setPointerCapture(e.pointerId);
          const idx = idxFromClientX(e.clientX);
          positionSliderInstant(wrap, idx);
          setActiveLabel(kind, idx);
        });
        wrap.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          const idx = idxFromClientX(e.clientX);
          positionSliderInstant(wrap, idx);
          setActiveLabel(kind, idx);
        });
        wrap.addEventListener("pointerup", (e) => {
          if (!dragging) return;
          dragging = false;
          commitSliderValue(kind, idxFromClientX(e.clientX));
        });

        wrap.addEventListener("keydown", (e) => {
          const cur = kind === "model" ? modelIdx() : effortIdx();
          let next = cur;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(max, cur + 1);
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(min, cur - 1);
          else if (e.key === "Home") next = min;
          else if (e.key === "End") next = max;
          else return;
          e.preventDefault();
          commitSliderValue(kind, next);
        });
      });

      card.querySelectorAll<HTMLButtonElement>(".slider-stop-label").forEach((btn) => {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.kind as SliderKind;
          const idx = Number(btn.dataset.idx);
          commitSliderValue(kind, idx);
        });
      });
    }

    function renderBody() {
      const flipFrom = card.hasChildNodes() ? captureSliderFlipState() : new Map<SliderKind, { fill: string; thumbLeft: string }>();

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
              ${renderAccountFieldHtml(accountField, { accounts, preferredAccountId, resolvedAccountId, projectName })}

              ${sliderHtml("model", "Model", modelIdx(), models.map(modelDisplayLabel), true)}

              ${moreOpen ? `<div class="me-more-body">${sliderHtml("effort", "Effort", effortIdx(), [...EFFORTS], false)}${checkboxesHtml}</div>` : ""}

              ${authExpired
                ? `<div class="me-model-warning" role="alert">Claude login session expired - reconnect (run <code>claude</code> in a terminal to log back in), then reopen this dialog</div>`
                : modelDisabled()
                  ? `<div class="me-model-warning" role="alert">${escapeHtml(modelDisplayLabel(model))} is disabled, please choose another model</div>`
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

      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        positionSliderInstant(wrap, kind === "model" ? modelIdx() : effortIdx());
      });
      playSliderFlip(flipFrom);
    }

    function attachHandlers() {
      wireSliders();

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
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+Enter submits; plain Enter is free for the 1-9 shortcuts below.
        e.preventDefault();
        void startWithCurrentConfig();
      } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = Number(e.key) - 1;
        if (!models[idx]) return;
        e.preventDefault();
        commitSliderValue("model", idx);
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
      // Attached once here (not in attachHandlers(), which reruns every
      // renderBody) so it doesn't stack a duplicate listener per re-render.
      attachChipKeyboardActivation(card);
      charPane = createCharacterPane(card, projectId);

      // Map family -> latest id (count_tokens rejects bare aliases), probe
      // those, key results back by family. Fails open on a transport error;
      // `authExpired: true` never does - see api.ts's ModelAvailability doc.
      const idByFamily = new Map<string, string>();
      for (const fam of models) {
        const id = latestIdForFamily(fam);
        if (id) idByFamily.set(fam, id);
      }
      modelProbeLoading = idByFamily.size > 0;
      renderBody();

      // ── Load character pool in background (see character-pane.ts) ────────
      charPane.loadPool();

      // ── Probe model availability in background ───────────────────────────
      if (idByFamily.size > 0) {
        void api.probeModelsAvailability([...idByFamily.values()])
          .then((results) => {
            authExpired = results.some((r) => r.authExpired);
            const byId = new Map(results.map((r) => [r.id, r.available]));
            for (const [fam, id] of idByFamily) availability[fam] = byId.get(id) ?? true;
          })
          .catch(() => { /* fail open - leave all models enabled */ })
          .finally(() => {
            modelProbeLoading = false;
            renderBody();
          });
      }
    });
  });
}
