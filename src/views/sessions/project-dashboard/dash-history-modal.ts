// The History modal: every ended chat of the dashboard's project (or group),
// newest first under day headings, a page at a time. It replaces the full-screen
// History list as the way to browse past chats; a row opens the chat read-only
// exactly as the "Recently closed" rows do.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../shared/modal";
import { hydrateCharacterAvatars } from "../../../shared/projects";
import { characterForSessionId, characterIconUrl, loadSessionCharacters } from "../session-characters";
import { dayLabel, shortAgo } from "./format";
import type { ActionHost } from "./dash-actions";
import { icon, quiet, repoTag, row, type DashCtx } from "./dash-parts";
import type { DashChatRow } from "./types";

/** Rows per fetch. One more is requested so "Show older" appears only when there is an older row. */
export const HISTORY_PAGE = 30;

/** The row's lead: the character that had the chat, else the plain chat glyph. */
function lead(sessionId: string): TemplateResult {
  const charId = characterForSessionId(sessionId);
  if (!charId) return icon("chat-circle");
  const url = characterIconUrl(charId);
  return html`<img class="char-avatar pd-char" data-character-id=${charId} src=${url ?? nothing} alt=${charId} title=${charId}>`;
}

/** Rows under a heading per calendar day; consecutive rows of one day share it. */
export function dayGroups(rows: DashChatRow[], nowMs: number): Array<{ label: string, rows: DashChatRow[] }> {
  const groups: Array<{ label: string, rows: DashChatRow[] }> = [];
  for (const r of rows) {
    const label = dayLabel(r.at_ms, nowMs);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }
  return groups;
}

export function openHistoryModal(host: ActionHost): void {
  const c: DashCtx = host.ctx();
  const target = c.snap.target;
  let rows: DashChatRow[] = [];
  let more = false;
  let loading = true;
  let failed = false;
  const slot = modalCardSlot();
  const close = (): void => { setBackdropCancel(null); closeHostCard(); };

  const pick = (r: DashChatRow): void => { close(); c.act.openHistory(r.session_id); };

  function body(): TemplateResult {
    if (failed && !rows.length) return quiet("Could not load the history");
    if (!rows.length) return quiet(loading ? "Loading..." : "No closed chats yet");
    const now = Date.now();
    return html`${dayGroups(rows, now).map((g) => html`
      <div class="pd-sub">${g.label}</div>
      ${g.rows.map((r) => row(lead(r.session_id), r.title, {
        tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, now), onClick: () => pick(r),
      }))}`)}
      ${more ? html`<div class="pd-more"><button type="button" class="pd-link" data-pd-older ?disabled=${loading}
        @click=${() => void load()}>${loading ? "Loading..." : "Show older"}</button></div>` : nothing}
      ${failed ? quiet("Could not load more") : nothing}`;
  }

  function draw(): void {
    render(html`
      <div class="modal-card pd-modal" role="dialog" aria-modal="true" aria-label="History">
        <header class="modal-header pd-mhead"><h3>History<span class="pd-modal-sub">${target.name}</span></h3></header>
        <div class="modal-body pd-mbody pd-history">${body()}</div>
        <footer class="modal-footer"><button type="button" class="btn btn-primary" @click=${close}>Done</button></footer>
      </div>`, slot);
    void hydrateCharacterAvatars(slot);
  }

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    draw();
    try {
      const page = await invoke<DashChatRow[]>("dashboard_closed_chats", {
        target: { kind: target.kind, id: target.id }, offset: rows.length, limit: HISTORY_PAGE + 1,
      });
      more = page.length > HISTORY_PAGE;
      const seen = new Set(rows.map((r) => r.session_id));
      rows = [...rows, ...page.slice(0, HISTORY_PAGE).filter((r) => !seen.has(r.session_id))];
    } catch (err) {
      console.warn("[project-dashboard] dashboard_closed_chats failed", err);
      failed = true;
    }
    loading = false;
    draw();
  }

  setBackdropCancel(close);
  void presentHostCard(draw);
  // Portraits first, so the first paint of the rows already has the icons cached.
  void loadSessionCharacters().then(load, load);
}
