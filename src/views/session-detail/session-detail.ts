import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { TemplateResult } from "lit-html";
import { showToast } from "../../shared/toast";
import { backFromSubview } from "../../shared/navigation";
import { getCurrentSessionRecord } from "../../shared/state";
import { api } from "../../shared/api";
import { invoke } from "../../shared/ipc";
import type { ChatEvent, HistoryEntry } from "../../types/ipc.generated";
import { renderAvatar } from "../../shared/projects";
import { projectSubviewHeaderData, hydrateSubviewHeader } from "../project-detail/subview-header";
import type { Avatar } from "../project-detail/subview-header";
import {
  type SessionRecord,
  type CardCtx,
  isLive,
  renderCards,
} from "./session-detail-cards";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";
import "../../shared/kebab-menu.css";
import "./session-detail.css";

function sessionIdOf(r: SessionRecord): string {
  return r.session_id || r.sessionId || "";
}

// ── Live chips + automated actions ──────────────────────────────────────────

function renderChrome(r: SessionRecord): void {
  const chips = document.getElementById("session-detail-chips");
  const actions = document.getElementById("session-detail-actions");
  const live = isLive(r);
  if (!live) {
    if (chips) { chips.style.display = "none"; chips.innerHTML = ""; }
    if (actions) { actions.style.display = "none"; actions.innerHTML = ""; }
    return;
  }
  if (chips) {
    const parts = [`<span class="chip active">● Active</span>`];
    if (r.kind === "automated") parts.push(`<span class="chip automated">⚙ Automated</span>`);
    if (r.is_remote) parts.push(`<span class="chip remote">📱 Remote</span>`);
    chips.innerHTML = parts.join("");
    chips.style.display = "flex";
  }
  if (actions) {
    const isAutomated = r.kind === "automated";
    const projectId = r.project_id;
    const buttons: string[] = [];
    if (isAutomated) buttons.push(`<button class="act-btn" data-act="term">term</button>`);
    if (r.bridge_session_id) buttons.push(`<button class="act-btn" data-act="phone">phone</button>`);
    if (isAutomated) {
      buttons.push(`<button class="act-btn" data-act="restart">restart</button>`);
      buttons.push(`<button class="act-btn" data-act="stop">stop</button>`);
    }
    if (!buttons.length) {
      actions.style.display = "none";
      actions.innerHTML = "";
    } else {
      actions.innerHTML = buttons.join("");
      actions.style.display = "flex";
      actions.querySelectorAll<HTMLButtonElement>(".act-btn").forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          try {
            if (act === "term" && projectId) await api.showTerminal(projectId);
            else if (act === "restart" && projectId) { await api.restartChannel(projectId); showToast("Restarting…"); }
            else if (act === "stop" && projectId) { await api.stopChannel(projectId); showToast("Stopped."); }
            else if (act === "phone" && r.session_id) {
              const url = await api.phoneLink(r.session_id);
              if (!url) return showToast("Phone link not available yet.");
              await navigator.clipboard.writeText(url);
              showToast(`Copied: ${url}`);
            }
          } catch (e) { showToast(`${act} failed: ${e}`); }
        };
      });
    }
  }
}

// ── More-options menu + CTA ───────────────────────────────────────────────────

function wireMenu(root: HTMLElement, r: SessionRecord): void {
  const menuBtn = root.querySelector<HTMLButtonElement>("#sessionDetailMenuBtn");
  const menu = root.querySelector<HTMLElement>("#sessionDetailMenu");
  if (!menuBtn || !menu) return;
  const sid = sessionIdOf(r);
  const dispose = wireKebabMenu(menuBtn, menu);
  menu.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((btn) => {
    btn.onclick = async () => {
      closeKebabMenu(menu);
      const act = btn.dataset.act;
      try {
        if (act === "copy-pid" && (r.pid ?? 0) > 0) {
          await navigator.clipboard.writeText(String(r.pid));
          showToast(`Copied PID ${r.pid}`);
        } else if (act === "copy-sid" && sid) {
          await navigator.clipboard.writeText(sid);
          showToast("Copied session id");
        }
      } catch (err) { showToast(`Copy failed: ${err}`); }
    };
  });
  (menu as unknown as { _cleanup?: () => void })._cleanup = dispose;
}

function wireCta(root: HTMLElement, r: SessionRecord): void {
  const btn = root.querySelector<HTMLButtonElement>("#sessionOpenInChatsBtn");
  if (!btn) return;
  const sid = sessionIdOf(r);
  btn.onclick = () => {
    if (!sid) return;
    void api.openChatsForSession(sid, isLive(r) ? "live" : "history");
  };
}

// ── Async enrichment for historical records ──────────────────────────────────

async function enrichHistorical(r: SessionRecord, sid: string, ctx: CardCtx): Promise<void> {
  try {
    const entries = await invoke<HistoryEntry[]>("list_history", { projectId: null, search: null, limit: 500, offset: 0 });
    const entry = (entries || []).find((e) => e.session_id === sid);
    if (entry) {
      if (entry.title) {
        ctx.title = entry.title;
        const h2 = document.getElementById("sessionDetailTitle");
        if (h2) h2.textContent = entry.title;
      }
      if (!ctx.startedAtMs && entry.started_at) {
        ctx.startedAtMs = Number(entry.started_at) * 1000;
      }
    }
  } catch { /* best-effort */ }

  let transcriptModel = "";
  try {
    const events = await invoke<ChatEvent[]>("load_history", { sessionId: sid, cwd: null });
    ctx.messages = (events || []).filter((e) => e.type === "user_message").length;
    let startModel = "";
    for (const e of events || []) {
      if (e.type === "turn_usage" && e.model) transcriptModel = e.model;
      else if (e.type === "session_started" && e.model) startModel = e.model;
    }
    if (!transcriptModel) transcriptModel = startModel;
  } catch {
    ctx.messages = 0;
  }
  try {
    const cfg = await api.getSessionConfig(sid);
    ctx.model = cfg?.model || transcriptModel || undefined;
    ctx.effort = cfg?.effort || undefined;
  } catch {
    ctx.model = transcriptModel || undefined;
  }
  if (sessionIdOf((getCurrentSessionRecord() as SessionRecord | null) || {}) === sid) {
    renderCards(r, ctx);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function renderSessionDetailView(
  root: HTMLElement,
): Promise<() => void> {
  const r = getCurrentSessionRecord() as SessionRecord | null;
  const { avatar, cwd } = projectSubviewHeaderData();
  const live = isLive(r);
  const sid = r ? sessionIdOf(r) : "";

  const fallbackTitle = r
    ? live
      ? ((r.name && r.name.trim()) || `Live session ${sid.slice(0, 8) || "?"}`)
      : `Chat ${sid.slice(0, 8) || ""}`.trim() || r.date || "Session"
    : "Session";

  render(template(avatar, fallbackTitle, r, cwd), root);
  void hydrateSubviewHeader(root);

  if (!r) return () => { /* nothing */ };

  wireMenu(root, r);
  wireCta(root, r);
  renderChrome(r);

  const ctx: CardCtx = {
    title: fallbackTitle,
    startedAtMs: live
      ? (r.started_at ? new Date(r.started_at).getTime() : null)
      : (r.startedAt ? new Date(r.startedAt).getTime() : null),
    liveStats: undefined,
    messages: live ? 0 : null,
    model: live ? (r.model || undefined) : undefined,
    effort: live ? (r.effort || undefined) : undefined,
  };
  renderCards(r, ctx);

  if (!live && sid) {
    void enrichHistorical(r, sid, ctx);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (live && r.session_id) {
    const liveSid = r.session_id;
    const tick = async () => {
      try {
        const stats = (await api.instanceTokenStats(liveSid)) as unknown as { tokens?: number; turns?: number; prompts?: number };
        if ((getCurrentSessionRecord() as SessionRecord | null)?.session_id !== liveSid) return;
        ctx.liveStats = stats;
        renderCards(r, ctx);
      } catch { /* ignore transient */ }
    };
    void tick();
    timer = setInterval(tick, 2500);
  }

  return () => {
    if (timer) { clearInterval(timer); timer = null; }
    const menu = root.querySelector<HTMLElement>("#sessionDetailMenu") as unknown as { _cleanup?: () => void } | null;
    try { menu?._cleanup?.(); } catch { /* ignore */ }
  };
}

function menuTemplate(r: SessionRecord | null): TemplateResult {
  const hasPid = !!r && (r.pid ?? 0) > 0;
  return html`
    <div class="menu-anchor">
      <button class="icon-btn" id="sessionDetailMenuBtn" title="More options">
        <i class="ph ph-dots-three-vertical"></i>
      </button>
      <div id="sessionDetailMenu" class="menu-popover hidden" role="menu">
        ${hasPid ? html`<button class="menu-item" data-act="copy-pid" role="menuitem">Copy PID</button>` : ""}
        <button class="menu-item" data-act="copy-sid" role="menuitem">Copy Session id</button>
      </div>
    </div>
  `;
}

function template(avatar: Avatar, title: string, r: SessionRecord | null, projectPath?: string) {
  return html`
    <div class="view view-session-detail">
      <div class="view-header subview-header">
        <button class="icon-btn" title="Back" @click=${() => backFromSubview()}><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini">${unsafeHTML(renderAvatar(avatar, projectPath))}</div>
          <div class="project-detail-titles">
            <h2 id="sessionDetailTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=${title}>${title}</h2>
          </div>
        </div>
        ${menuTemplate(r)}
      </div>
      <div class="view-body">
        <div id="session-detail-chips" class="chip-bar" style="display:none"></div>
        <div id="session-detail-actions" class="actions session-detail-actions" style="display:none"></div>
        <div id="session-detail-body" style="margin-top:12px"></div>
        <button class="sd-cta" id="sessionOpenInChatsBtn">
          <i class="ph ph-chats"></i> Open in chats
        </button>
      </div>
    </div>
  `;
}
