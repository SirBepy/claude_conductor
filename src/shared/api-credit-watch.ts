// One live view of every API-credit account's Console figures, shared by the
// dashboard meter and the Settings rows: an initial `get_api_credit_status`
// read, then each `api-credit-status-changed` event replaces that account's
// entry. In memory only: the daemon owns the figures and re-serves them on open.

import { api } from "./api";
import type { ApiCreditStatus } from "../types/ipc.generated";

export type ApiCreditStatusMap = Record<string, ApiCreditStatus>;

/** Calls `onChange` with the full map after the first read and after every
 * event, and returns the disposer. An event that lands before the first read
 * resolves wins over that read's copy of the same account, since it is newer. */
export function watchApiCreditStatus(onChange: (map: ApiCreditStatusMap) => void): () => void {
  let disposed = false;
  let fetched: ApiCreditStatusMap = {};
  const fromEvents: ApiCreditStatusMap = {};

  const emit = (): void => {
    if (!disposed) onChange({ ...fetched, ...fromEvents });
  };

  const unlisten = api.onApiCreditStatusChanged((change) => {
    fromEvents[change.account_id] = change.status;
    emit();
  });
  void api.getApiCreditStatus().then((map) => {
    fetched = map;
    emit();
  });

  return () => {
    disposed = true;
    unlisten();
  };
}
