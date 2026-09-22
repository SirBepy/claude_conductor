// Global dashboard widget: skill usage (last 7 days), pie + sortable table.
// Moved verbatim from the deleted Statistics view (multi-account milestone
// 05) - this widget was unconditionally visible there, so it rides onto the
// dashboard enabled by default (see dashboard-widget-logic.ts). Global scope:
// ignores the selected account entirely.

import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../../shared/api";
import type { SkillUsageEntry, SkillUsageWeek } from "../../../types/ipc.generated";
import { showView } from "../../../shared/navigation";
import { tokensAllIn, formatTokens } from "../../../shared/tokens";
import { buildPieSvg } from "../../../shared/pie";
import "./skill-usage-widget.css";

const PIE_COLORS = ["#5b8def", "#8c5bef", "#ef5b8c", "#efbf5b", "#5befbf", "#888"];
const TOP_N = 5;

interface SortState { col: "tokens" | "inv" | "chats" | "perUse" | "skill"; dir: 1 | -1; }
let sort: SortState = { col: "tokens", dir: -1 };

function sortValue(e: SkillUsageEntry, col: SortState["col"]): number | string {
  switch (col) {
    case "tokens": return tokensAllIn(e.tokens);
    case "inv": return e.invocations.total;
    case "chats": return e.chats;
    case "perUse": return e.invocations.total === 0 ? 0 : tokensAllIn(e.tokens) / e.invocations.total;
    case "skill": return e.skill;
  }
}

export function renderSkillUsageWidget(container: HTMLElement): () => void {
  let state: SkillUsageWeek | null = null;
  let loading = true;

  const draw = () => {
    if (loading) {
      render(html`<div class="skill-usage-widget loading">Loading skill usage&hellip;</div>`, container);
      return;
    }
    if (!state || state.entries.length === 0) {
      render(html`
        <div class="v-empty">
          <i class="ph ph-chart-pie-slice v-empty-icon"></i>
          <div class="v-empty-title">No skill usage yet</div>
          <div class="v-empty-hint">The Stop hook installs automatically on the next Claude Code session.</div>
        </div>
      `, container);
      return;
    }

    const sorted = [...state.entries].sort((a, b) => {
      const av = sortValue(a, sort.col);
      const bv = sortValue(b, sort.col);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });

    const pieEntries = [...state.entries].sort((a, b) => tokensAllIn(b.tokens) - tokensAllIn(a.tokens));
    const top = pieEntries.slice(0, TOP_N);
    const rest = pieEntries.slice(TOP_N);
    const restTotal = rest.reduce((sum, e) => sum + tokensAllIn(e.tokens), 0);
    const pieRows: { label: string; tokens: number; color: string }[] = top.map((e, i) => ({
      label: e.skill,
      tokens: tokensAllIn(e.tokens),
      color: PIE_COLORS[i] ?? PIE_COLORS[PIE_COLORS.length - 1]!,
    }));
    if (restTotal > 0) {
      pieRows.push({ label: "Other", tokens: restTotal, color: PIE_COLORS[PIE_COLORS.length - 1]! });
    }

    render(html`
      <div class="skill-usage-widget">
        <div class="skill-usage-body">
          ${renderPie(pieRows)}
          ${renderTable(sorted, state.total_sessions)}
        </div>
      </div>
    `, container);
  };

  function renderTable(entries: SkillUsageEntry[], totalSessions: number): TemplateResult {
    const headerCell = (col: SortState["col"], label: string) => {
      const active = sort.col === col;
      const arrow = active ? (sort.dir === -1 ? " ▼" : " ▲") : "";
      const onClick = () => {
        if (sort.col === col) sort = { col, dir: sort.dir === -1 ? 1 : -1 };
        else sort = { col, dir: -1 };
        draw();
      };
      return html`<th class=${active ? "sort-active" : ""} @click=${onClick}>${label}${arrow}</th>`;
    };
    return html`
      <table class="skill-usage-table">
        <thead>
          <tr>
            ${headerCell("skill", "Skill")}
            ${headerCell("inv", "Inv")}
            ${headerCell("chats", "Chats")}
            <th>% Chats</th>
            ${headerCell("tokens", "Tokens")}
            ${headerCell("perUse", "Per use")}
          </tr>
        </thead>
        <tbody>
          ${entries.map((e) => html`
            <tr
              class="v-focusable"
              role="button"
              tabindex="0"
              @click=${() => onRowClick(e.skill)}
              @keydown=${(ev: KeyboardEvent) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onRowClick(e.skill);
                }
              }}
            >
              <td>${e.skill}</td>
              <td>${e.invocations.total}</td>
              <td>${e.chats}</td>
              <td>${totalSessions === 0 ? "-" : Math.round((e.chats / totalSessions) * 100) + "%"}</td>
              <td>${formatTokens(tokensAllIn(e.tokens))}</td>
              <td>${e.invocations.total === 0 ? "-" : formatTokens(Math.round(tokensAllIn(e.tokens) / e.invocations.total))}</td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }

  function renderPie(rows: { label: string; tokens: number; color: string }[]): TemplateResult {
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    if (total === 0) return html`<div class="pie-empty">No token data</div>`;
    const slices = rows.map((r) => ({ value: r.tokens, color: r.color }));
    const wrap = document.createElement("div");
    wrap.innerHTML = buildPieSvg(slices, total, { r: 80, cx: 100, cy: 100, size: 200 });
    return html`
      <div class="pie-wrap">
        ${wrap}
        <ul class="pie-legend">
          ${rows.map((row) => html`
            <li><span class="swatch" style="background:${row.color}"></span>${row.label} &mdash; ${formatTokens(row.tokens)}</li>
          `)}
        </ul>
      </div>
    `;
  }

  function onRowClick(skill: string) {
    (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
    showView("skill-detail");
  }

  function load() {
    api.getSkillUsageWeek().then((w) => {
      state = w;
      loading = false;
      draw();
    }).catch((err) => {
      console.error("getSkillUsageWeek failed", err);
      loading = false;
      draw();
    });
  }

  draw();
  load();
  const unlisten = api.onSkillUsageChanged(() => load());

  return () => {
    try { unlisten(); } catch { /* ignore */ }
  };
}
