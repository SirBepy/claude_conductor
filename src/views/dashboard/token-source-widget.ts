// Global dashboard widget: token spend by source (todo 146) - Interactive
// (CLI) vs Automated/External (app-hosted). Legacy rows with no kind land in
// "unknown", never guessed; see `token_stats_by_source` (ipc/projects.rs).

import { html, render } from "lit-html";
import { api } from "../../shared/api";
import type { TokenSourceBucket } from "../../shared/api";
import { formatTokens } from "../../shared/formatters";
import type { Widget } from "./widgets/types";

const LABELS: Record<TokenSourceBucket["kind"], string> = {
  interactive: "Interactive (CLI)",
  automated: "Automated (app chat)",
  external: "External (app chat)",
  unknown: "Unknown (legacy)",
};

function draw(root: HTMLElement, buckets: TokenSourceBucket[] | null): void {
  if (!buckets) {
    render(html`<div class="loading">Loading token source stats&hellip;</div>`, root);
    return;
  }
  const rows = buckets.filter((b) => b.sessions > 0);
  if (!rows.length) {
    render(html`<div class="no-data">No token history recorded yet.</div>`, root);
    return;
  }
  render(html`
    <table class="stats-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Sessions</th>
          <th>Tokens</th>
          <th>Turns</th>
          <th>Avg/turn</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((b) => html`
          <tr>
            <td>${LABELS[b.kind]}</td>
            <td class="mono">${b.sessions}</td>
            <td class="mono">${formatTokens(b.tokens)}</td>
            <td class="mono">${b.turns}</td>
            <td class="mono">${formatTokens(Math.round(b.avgTokensPerTurn))}</td>
          </tr>
        `)}
      </tbody>
    </table>
  `, root);
}

export const tokenSourceWidget: Widget = {
  id: "token-source",
  title: "Tokens by source",
  icon: "ph-scales",
  scope: "global",
  dataDeps: ["tokenHistory"],
  render(root) {
    draw(root, null);
    api.tokenStatsBySource().then((buckets) => draw(root, buckets));
    return () => { /* no subscriptions to tear down */ };
  },
};
