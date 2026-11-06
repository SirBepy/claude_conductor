// Always-visible header chip for an armed sleep/shutdown-when-done run, with a
// postpone popover. The overflow menu buried this two clicks deep; a nightly arm
// at 02:00 fires while Joe may still be at the PC, so it has to show where he
// is already looking. Desktop only: the phone has no when-done RPCs.

import { isRemote } from "../../shared/transport";
import { createMoreMenu } from "./more-menu-base";
import {
  cancelWhenDone,
  snoozeWhenDone,
  subscribeWhenDone,
  whenDoneChipModel,
  type WhenDoneChipModel,
} from "./when-done";
import { state } from "./state";

/** Postpone lengths offered in the popover (minutes). */
const SNOOZE_PRESETS: { mins: number; label: string }[] = [
  { mins: 30, label: "30 minutes" },
  { mins: 60, label: "1 hour" },
  { mins: 180, label: "3 hours" },
];

/** What the inline button during the countdown postpones by: one click, no menu. */
const QUICK_SNOOZE_MINS = 30;

const popover = createMoreMenu<[]>({
  className: "session-more-menu when-done-popover",
  build: (menu, close) => {
    const label = document.createElement("span");
    label.className = "smore-section-label";
    label.textContent = "Postpone";
    menu.appendChild(label);
    for (const p of SNOOZE_PRESETS) {
      const b = document.createElement("button");
      b.className = "smore-item";
      b.innerHTML = `<i class="ph ph-clock-countdown"></i>${p.label}`;
      b.addEventListener("click", () => {
        void snoozeWhenDone(p.mins);
        close();
      });
      menu.appendChild(b);
    }
    const sep = document.createElement("div");
    sep.className = "smore-sep";
    menu.appendChild(sep);
    const cancel = document.createElement("button");
    cancel.className = "smore-item when-done-popover-cancel";
    cancel.innerHTML = `<i class="ph ph-x"></i>Cancel`;
    cancel.addEventListener("click", () => {
      void cancelWhenDone();
      close();
    });
    menu.appendChild(cancel);
  },
});

function chipHtml(m: WhenDoneChipModel): string {
  const icon = state.whenDone?.action === "sleep" ? "ph-moon-stars" : "ph-power";
  const quick =
    m.kind === "count"
      ? `<button class="when-done-hchip-quick" data-when-done-quick>Postpone ${QUICK_SNOOZE_MINS} min</button>`
      : "";
  // Firing is past the point of postponing, so it gets no click target.
  const main =
    m.kind === "firing"
      ? `<span class="when-done-hchip-main"><i class="ph ${icon}"></i><span class="when-done-hchip-text"></span></span>`
      : `<button class="when-done-hchip-main" data-when-done-chip><i class="ph ${icon}"></i><span class="when-done-hchip-text"></span></button>`;
  return main + quick;
}

/** Keep `host` showing the chip for the current state. The DOM is rebuilt only
 *  when the chip's kind or action changes (the icon is baked into the markup),
 *  so the popover's anchor survives the 1s countdown ticks. */
function render(host: HTMLElement): void {
  const m = whenDoneChipModel(state.whenDone);
  if (!m) {
    host.hidden = true;
    host.innerHTML = "";
    delete host.dataset.kind;
    delete host.dataset.key;
    popover.close();
    return;
  }
  const key = `${m.kind}:${state.whenDone?.action}`;
  if (host.dataset.key !== key) {
    host.innerHTML = chipHtml(m);
    host.dataset.key = key;
    host.dataset.kind = m.kind;
  }
  host.hidden = false;
  const text = host.querySelector<HTMLElement>(".when-done-hchip-text");
  if (text) text.textContent = m.text;
}

/** Mount the chip into `#when-done-chip-host` under `root`. Returns a dispose fn. */
export function mountWhenDoneChip(root: HTMLElement): () => void {
  const host = root.querySelector<HTMLElement>("#when-done-chip-host");
  if (!host || isRemote()) return () => {};

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-when-done-quick]")) {
      e.stopPropagation();
      void snoozeWhenDone(QUICK_SNOOZE_MINS);
      return;
    }
    const main = t.closest<HTMLElement>("[data-when-done-chip]");
    if (main) {
      e.stopPropagation();
      popover.toggle(main);
    }
  };
  host.addEventListener("click", onClick);
  const unsub = subscribeWhenDone(() => render(host));
  render(host);

  return () => {
    host.removeEventListener("click", onClick);
    unsub();
    popover.close();
  };
}
