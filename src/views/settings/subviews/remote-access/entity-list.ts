// Shared list-render + wire-action-button pattern for a `.ra-device-row`
// list. remote-access.ts's paired-devices list and machines-section.ts's
// paired-machines list were two near-identical copies of this (map items to
// row HTML, `querySelectorAll` the action button, wire onclick with
// disable-on-click + try/catch + re-render on success + re-enable on
// failure) differing only in the data source and the action. A neutral file
// (not a member of either) since remote-access.ts already imports from
// machines-section.ts - either of those importing this helper from the other
// would be circular.

export interface RenderEntityListOptions {
  /** Painted into the list when `items` is empty, in place of the mapped
   *  rows. Defaults to "" (remote-access.ts's device list clears silently -
   *  its own section is hidden entirely at 0 devices). */
  emptyHtml?: string;
  /** Included in the action-failure console.error so each caller's log line
   *  still names its own action (e.g. "revoke" vs "unpair_machine"). */
  errorLabel: string;
}

export function renderEntityList<T>(
  root: HTMLElement,
  listSelector: string,
  items: T[],
  rowHtml: (item: T) => string,
  actionSelector: string,
  action: (id: string) => Promise<void>,
  opts: RenderEntityListOptions,
): void {
  const list = root.querySelector<HTMLElement>(listSelector);
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = opts.emptyHtml ?? "";
    return;
  }
  list.innerHTML = items.map(rowHtml).join("");
  list.querySelectorAll<HTMLButtonElement>(actionSelector).forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id ?? "";
      void (async () => {
        btn.disabled = true;
        try {
          await action(id);
        } catch (e) {
          console.error(`[remote-access] ${opts.errorLabel} failed`, e);
          btn.disabled = false;
        }
      })();
    };
  });
}

/** A row's name as an inline-rename field: reads as plain text until hovered
 *  or focused. `escape` is the caller's own HTML escaper. */
export function renameFieldHtml(id: string, name: string, escape: (s: string) => string): string {
  return `<input type="text" class="ra-device-name ra-name-input" data-id="${escape(id)}" value="${escape(name)}" maxlength="40" aria-label="Rename" title="Click to rename" spellcheck="false">`;
}

/** Commits each rename field on blur/Enter; Escape or an empty name puts the
 *  old name back. A failed save also puts it back, since the old name is
 *  still what is stored. */
export function wireRenameFields(
  root: HTMLElement,
  listSelector: string,
  rename: (id: string, name: string) => Promise<unknown>,
  errorLabel: string,
): void {
  root.querySelectorAll<HTMLInputElement>(`${listSelector} .ra-name-input`).forEach((input) => {
    let saved = input.value;
    input.onkeydown = (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = saved; input.blur(); }
    };
    input.onblur = () => {
      const name = input.value.trim();
      if (!name || name === saved) { input.value = saved; return; }
      input.value = name;
      void rename(input.dataset.id ?? "", name)
        .then(() => { saved = name; })
        .catch((e) => {
          console.error(`[remote-access] ${errorLabel} failed`, e);
          input.value = saved;
        });
    };
  });
}
