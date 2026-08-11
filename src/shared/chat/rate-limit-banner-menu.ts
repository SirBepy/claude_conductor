// Mobile (<=768px) kebab holding rate-limit-banner.ts's 3 card actions.
// Reuses the session-more-menu chrome, same createMoreMenu pattern as the
// other kebabs.

import { createMoreMenu } from "../../views/sessions/more-menu-base";

export interface RlbMenuItem {
  icon: string;
  label: string;
  disabledReason?: string;
  onClick: () => void;
}

const rlbMenu = createMoreMenu<[RlbMenuItem[]]>({
  position: { align: "right" },
  build: (menu, close, items) => {
    for (const it of items) {
      const btn = document.createElement("button");
      btn.className = "smore-item" + (it.disabledReason ? " is-disabled" : "");
      if (it.disabledReason) btn.title = it.disabledReason;
      btn.innerHTML = `<i class="ph ph-${it.icon}"></i><span>${it.label}</span>`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (it.disabledReason) return;
        close();
        it.onClick();
      });
      menu.appendChild(btn);
    }
  },
});

export function openRlbMenu(anchor: HTMLElement, items: RlbMenuItem[]): void {
  rlbMenu.open(anchor, items);
}
