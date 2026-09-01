// Model-availability probe sub-component for the new-chat modal, split out
// of model-effort-modal.ts (ai_todo 810), mirroring the folder's other
// createXController() extractions (slider-controller.ts, account-field.ts).
// model-effort-modal.ts is the only caller.

import { api } from "../../shared/api";
import type { Account } from "../../shared/api";
import type { AccountFieldState } from "./account-field";

/** Mutable probe results the modal reads on every render. A plain mutated
 * object (not reassigned fields) so the modal can hold one reference across
 * probe runs instead of re-fetching getters. */
export interface ModelProbeState {
  /** Per-model availability from the count_tokens probe. Empty until the
   * probe resolves; absent/true => model is selectable. */
  availability: Record<string, boolean>;
  /** Set when the backend's CLI-driven token-refresh retry still 401'd - the
   * account is genuinely logged out, not just "this model is disabled". */
  authExpired: boolean;
  /** True while the availability probe is in flight. */
  modelProbeLoading: boolean;
}

export interface ModelProbeController {
  readonly state: ModelProbeState;
  /** Map family -> latest id (count_tokens rejects bare aliases) to probe,
   * keyed back by family in `state.availability`. Called once loadAndBuild()
   * resolves the modal's model list. */
  seedIdByFamily(entries: Map<string, string>): void;
  /** Sets `state.modelProbeLoading` from the seeded id count, so the first
   * renderBody() after seeding paints the spinner before runProbe()'s own
   * (later) assignment would. */
  primeLoadingFlag(): void;
  /** Probes the picked account, since availability and auth are per-account:
   * one expired account must not disable "Start session" for the others
   * (todo 758). Fails open on a transport error; `authExpired: true` never
   * does - see api.ts's ModelAvailability doc. */
  runProbe(): void;
  onAccountPicked(): void;
  cycleAccount(delta: number): void;
}

/** Owns the model-availability probe and account-cycling state for a new-chat
 * modal. `accountField`/`getAccounts` are the modal's own mutable refs;
 * `renderBody` is called once a probe settles or the account changes. */
export function createModelProbeController(opts: {
  accountField: AccountFieldState;
  getAccounts: () => Account[];
  renderBody: () => void;
}): ModelProbeController {
  const { accountField, getAccounts, renderBody } = opts;

  const state: ModelProbeState = {
    availability: {},
    authExpired: false,
    modelProbeLoading: false,
  };

  const idByFamily = new Map<string, string>();
  // Which account the in-flight/last probe ran under, so a chip click that
  // lands back on the already-probed account doesn't re-fire it.
  let probedAccountId: string | null | undefined;
  // Stops a slow reply from a previously-picked account overwriting a
  // newer one's results.
  let probeSeq = 0;

  function runProbe(): void {
    if (idByFamily.size === 0) return;
    const acct = accountField.accountId;
    probedAccountId = acct;
    const seq = ++probeSeq;
    state.modelProbeLoading = true;
    void api.probeModelsAvailability([...idByFamily.values()], acct)
      .then((results) => {
        if (seq !== probeSeq) return;
        state.authExpired = results.some((r) => r.authExpired);
        const byId = new Map(results.map((r) => [r.id, r.available]));
        for (const [fam, id] of idByFamily) state.availability[fam] = byId.get(id) ?? true;
      })
      .catch(() => { /* fail open - leave all models enabled */ })
      .finally(() => {
        if (seq !== probeSeq) return;
        state.modelProbeLoading = false;
        renderBody();
      });
  }

  function onAccountPicked(): void {
    if (accountField.accountId !== probedAccountId) {
      state.authExpired = false;
      runProbe();
    }
    renderBody();
  }

  function cycleAccount(delta: number): void {
    const accounts = getAccounts();
    if (accounts.length === 0) return;
    const cur = Math.max(0, accounts.findIndex((a) => a.id === accountField.accountId));
    const next = accounts[(cur + delta + accounts.length) % accounts.length];
    if (!next) return;
    accountField.accountId = next.id;
    onAccountPicked();
  }

  return {
    state,
    seedIdByFamily(entries) {
      for (const [fam, id] of entries) idByFamily.set(fam, id);
    },
    primeLoadingFlag() {
      state.modelProbeLoading = idByFamily.size > 0;
    },
    runProbe,
    onAccountPicked,
    cycleAccount,
  };
}
