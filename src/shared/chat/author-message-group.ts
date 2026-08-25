// Groups consecutive authored (session-relayed) user messages into one real
// .tool-chip, matching the existing delegated click handler's expected DOM
// shape (createHandleToolChipClick) so no second click listener is needed.
// Second-pass mutation, same idempotent shape as turn-collapse.ts's clampUserMessages.
import type { RenderedMessage } from "./chat-transforms";
import { renderBlocks } from "./chat-transforms";
import { escapeHtml } from "../escape-html";
import { authorTagFor } from "./author-tag-source";
import { basename } from "../path-utils";
import { hydrateCharacterAvatars } from "../projects";
import { ensureMainStrip } from "./tool-strip";

const PALETTE = ["#7cb6ff", "#c794f5", "#7ee0b0", "#f5a97c", "#f57ca3", "#a3c97c"];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(sessionId: string): string {
  return PALETTE[hashStr(sessionId) % PALETTE.length]!;
}

function nameFor(sessionId: string): string {
  const { cwd } = authorTagFor(sessionId);
  return cwd ? basename(cwd) : "peer session";
}

function avatarHtml(sessionId: string, color: string): string {
  const { charId } = authorTagFor(sessionId);
  const inner = charId
    ? `<img class="char-avatar" data-character-id="${escapeHtml(charId)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated">`
    : `<i class="ph ph-robot"></i>`;
  return `<span class="author-avatar" style="box-shadow:0 0 0 2px ${color};">${inner}</span>`;
}

let groupSeq = 0;

function buildGroupHost(host: HTMLElement, run: RenderedMessage[]): void {
  host.className = "author-group-host";
  host.removeAttribute("style");
  host.innerHTML = "";
  const groupKey = `peer-${groupSeq++}`;

  const seen: string[] = [];
  for (const m of run) {
    const id = m.authorSessionId!;
    if (!seen.includes(id)) seen.push(id);
  }
  const names = seen.map(nameFor);
  const label = names.length <= 2 ? names.join(" & ") : `${names[0]} +${names.length - 1}`;
  const count = run.length > 1 ? `<span class="tool-chip-count">×${run.length}</span>` : "";

  const { strip, panel } = ensureMainStrip(host);
  strip.classList.add("author-group-strip");
  const chip = document.createElement("span");
  chip.className = "tool-chip";
  chip.dataset.tool = groupKey;
  chip.innerHTML =
    `<span class="author-group-avatars">${seen.slice(0, 3).map((id) => avatarHtml(id, colorFor(id))).join("")}</span>` +
    `<span class="tool-chip-label">${escapeHtml(label)}</span>${count}`;
  strip.appendChild(chip);

  const group = document.createElement("div");
  group.className = "tool-strip-group author-group-panel";
  group.dataset.tool = groupKey;
  group.hidden = true;
  for (const m of run) {
    const id = m.authorSessionId!;
    const color = colorFor(id);
    const row = document.createElement("div");
    row.className = "author-group-row";
    row.innerHTML =
      avatarHtml(id, color) +
      `<div class="author-group-row-body"><div class="author-group-row-name" style="color:${color}">${escapeHtml(nameFor(id))}</div>` +
      `<div class="author-group-row-text">${renderBlocks(m.content ?? [], true, true)}</div></div>`;
    group.appendChild(row);
  }
  panel.appendChild(group);

  void hydrateCharacterAvatars(host);
}

export function groupAuthoredMessages(messages: RenderedMessage[], messageEls: HTMLElement[]): void {
  for (let i = 0; i < messageEls.length; i++) {
    const m = messages[i];
    if (m?.kind !== "user" || !m.authorSessionId) continue;
    const el = messageEls[i];
    if (!el || el.dataset.groupChecked) continue;

    let j = i + 1;
    while (j < messageEls.length) {
      const mj = messages[j];
      if (mj?.kind !== "user" || !mj.authorSessionId || !messageEls[j]) break;
      j++;
    }
    for (let k = i; k < j; k++) messageEls[k]!.dataset.groupChecked = "1";
    buildGroupHost(el, messages.slice(i, j));
  }
}
