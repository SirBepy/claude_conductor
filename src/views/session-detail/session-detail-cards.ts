import { formatTokens } from "../../shared/tokens";
import { buildPieSvg } from "../../shared/pie";
import { escapeHtml } from "../../shared/escape-html";
import { modelFamily } from "../../shared/model-name";

const PIE = {
  input: "#9d7dfc",
  output: "#f2b457",
  cacheRead: "#6ad98a",
  cacheCreate: "#8a9eff",
};

export interface SessionRecord {
  session_id?: string;
  sessionId?: string;
  kind?: string;
  pid?: number;
  project_id?: string;
  bridge_session_id?: string | null;
  name?: string | null;
  started_at?: string;
  startedAt?: string;
  date?: string;
  model?: string;
  effort?: string;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LiveStats {
  tokens?: number;
  turns?: number;
  prompts?: number;
}

export interface CardCtx {
  title: string;
  startedAtMs: number | null;
  liveStats?: LiveStats;
  messages: number | null;
  model?: string;
  effort?: string;
}

export function totalTok(r: SessionRecord): number {
  return (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
}

export function cacheEffPct(r: SessionRecord): number {
  const denom = (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
  if (!denom) return 0;
  return Math.round((r.cacheReadTokens || 0) / denom * 100);
}

export function dateTimeParts(r: SessionRecord, startedAtMs: number | null): { date: string; time: string } {
  const ms = startedAtMs
    ?? (r.startedAt ? new Date(r.startedAt).getTime() : null)
    ?? (r.started_at ? new Date(r.started_at).getTime() : null);
  if (ms && !Number.isNaN(ms)) {
    const d = new Date(ms);
    return {
      date: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
      time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    };
  }
  return { date: r.date || "-", time: "-" };
}

function uptimeFrom(iso: string | undefined): string {
  if (!iso) return "-";
  const start = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - start);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function modelEffortRow(model?: string, effort?: string): string {
  const m = (model || "").trim();
  const e = (effort || "").trim();
  if (!m && !e) return "";
  const parts: string[] = [];
  if (m) parts.push(`<span><span class="sd-meta-label">Model</span> ${escapeHtml(modelFamily(m))}</span>`);
  if (e) parts.push(`<span><span class="sd-meta-label">Effort</span> ${escapeHtml(e)}</span>`);
  return `<div class="sd-meta-row">${parts.join('<span class="sd-meta-sep">|</span>')}</div>`;
}

function pieCard(r: SessionRecord): string {
  const input = r.inputTokens || 0;
  const output = r.outputTokens || 0;
  const cacheRead = r.cacheReadTokens || 0;
  const cacheCreate = r.cacheCreationTokens || 0;
  const total = input + output + cacheRead + cacheCreate;
  if (total <= 0) {
    return `<div class="sd-card"><div class="sd-card-title">Token breakdown</div>
      <div class="sd-empty">No token data</div></div>`;
  }
  const slices = [
    { label: "Input", value: input, color: PIE.input },
    { label: "Output", value: output, color: PIE.output },
    { label: "Cache read", value: cacheRead, color: PIE.cacheRead },
    { label: "Cache create", value: cacheCreate, color: PIE.cacheCreate },
  ];
  const svg = buildPieSvg(slices.map((s) => ({ value: s.value, color: s.color })), total, { r: 46, cx: 52, cy: 52, size: 104 });
  const legend = slices.map((s) => `
    <div class="sd-legend-item">
      <span class="sd-swatch" style="background:${s.color}"></span>
      <span class="sd-legend-label">${s.label}</span>
      <span class="sd-legend-val">${formatTokens(s.value)}</span>
    </div>`).join("");
  return `<div class="sd-card"><div class="sd-card-title">Token breakdown</div>
    <div class="sd-pie-wrap">${svg}<div class="sd-legend">${legend}</div></div></div>`;
}

function cacheCard(r: SessionRecord): string {
  return `<div class="sd-card"><div class="sd-card-title">Cache</div>
    <div class="sd-cache">
      <div class="sd-cache-row"><span>Read</span><span>${formatTokens(r.cacheReadTokens || 0)}</span></div>
      <div class="sd-cache-row"><span>Created</span><span>${formatTokens(r.cacheCreationTokens || 0)}</span></div>
      <div class="sd-cache-row"><span>Efficiency</span><span>${cacheEffPct(r)}%</span></div>
    </div></div>`;
}

function countsCard(turns: number, messages: number | null): string {
  const msg = messages === null ? "…" : String(messages);
  return `<div class="sd-card"><div class="sd-counts">
    <div class="sd-count"><div class="sd-count-label">Turns</div><div class="sd-count-value">${turns}</div></div>
    <div class="sd-count"><div class="sd-count-label">Messages</div><div class="sd-count-value">${msg}</div></div>
  </div></div>`;
}

export function isLive(r: SessionRecord | null): boolean {
  return !!(r && r.session_id && r.kind);
}

export function renderCards(r: SessionRecord, ctx: CardCtx): void {
  const body = document.getElementById("session-detail-body");
  if (!body) return;
  const live = isLive(r);
  const { date, time } = dateTimeParts(r, ctx.startedAtMs);

  let overview: string;
  let counts: string;
  let extra = "";

  if (live) {
    const s = ctx.liveStats || {};
    overview = `<div class="sd-card sd-overview">
      <div class="sd-title">${escapeHtml(ctx.title)}</div>
      <div class="sd-meta-row">
        <span><span class="sd-meta-label">Started</span> ${date} · ${time}</span>
        <span class="sd-meta-sep">|</span>
        <span><span class="sd-meta-label">Up</span> ${uptimeFrom(r.started_at)}</span>
      </div>
      ${modelEffortRow(ctx.model, ctx.effort)}
      <div class="sd-total"><span class="sd-meta-label">Total tokens</span> ${formatTokens(s.tokens ?? 0)}</div>
    </div>`;
    counts = countsCard(s.turns ?? 0, s.prompts ?? 0);
  } else {
    overview = `<div class="sd-card sd-overview">
      <div class="sd-title">${escapeHtml(ctx.title)}</div>
      <div class="sd-meta-row">
        <span><span class="sd-meta-label">Date</span> ${date}</span>
        <span class="sd-meta-sep">|</span>
        <span><span class="sd-meta-label">Time</span> ${time}</span>
      </div>
      ${modelEffortRow(ctx.model, ctx.effort)}
      <div class="sd-total"><span class="sd-meta-label">Total tokens</span> ${formatTokens(totalTok(r))}</div>
    </div>`;
    counts = countsCard(r.turns ?? 0, ctx.messages);
    extra = pieCard(r) + cacheCard(r);
  }

  body.innerHTML = `<div class="sd-cards">${overview}${counts}${extra}</div>`;
}
