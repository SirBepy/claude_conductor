// The built-in dashboard cards: Your todos, Next up, Ship state, Running
// (Chats and Reports have their own files). Each returns nothing when its builtin id is hidden.
import { html, nothing, type TemplateResult } from "lit-html";
import { shortAgo, summarize, whenLabel } from "./format";
import { pageSlice } from "./paging";
import {
  card, dot, hidden, icon, isGroup, kv, quiet, repoTag, row, type DashCtx,
} from "./dash-parts";
import type { RepoShip } from "./types";

export function yourTodos(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "your_todos")) return nothing;
  if (c.snap.your_todos.length === 0) return nothing;
  const { slice, pager } = pageSlice(c, "your_todos", c.snap.your_todos);
  const rows = slice.map((t) => {
    const done = c.doneTodos.has(t.id);
    return html`<label class="pd-row pd-todo ${done ? "is-done" : ""}">
      <input type="checkbox" .checked=${done} @change=${() => c.act.toggleTodo(t)}>
      <span class="pd-t">${t.text}</span>${repoTag(c, t.repo_cwd)}
      ${t.by_ai ? html`<span class="pd-m">from a chat</span>` : nothing}
    </label>`;
  });
  return card("Your todos", rows, { id: "your_todos", trailing: pager });
}

// The plan is long and mostly prose, so the card shows only what is next: a few
// items cut to their headline, paged. The full text stays in each row's tooltip.
const PLAN_ROWS = 3;
const SCHEDULED_ROWS = 2;

export function nextUp(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "next_up")) return nothing;
  const scheduled = c.snap.scheduled.slice(0, SCHEDULED_ROWS);
  const { slice, pager } = pageSlice(c, "next_up", c.snap.plan, PLAN_ROWS);
  const body: TemplateResult[] = slice.map((p) => row(icon(p.priority ? "star" : "circle"),
    p.id ? `#${p.id} ${summarize(p.text)}` : summarize(p.text),
    { tag: repoTag(c, p.repo_cwd), title: p.text }));
  body.push(...scheduled.map((s, i) => row(icon("alarm"), s.label,
    { tag: repoTag(c, s.repo_cwd), meta: whenLabel(s.fire_at_ms, c.nowMs), gap: i === 0 && body.length > 0 })));
  if (!body.length) body.push(quiet("Nothing queued"));
  const single = !isGroup(c) ? c.snap.target.repos[0]?.cwd : null;
  const link = single
    ? html`<a class="pd-link" @click=${() => c.act.openFile(`${single}/.claude/todos/PLAN.md`)}>PLAN.md</a>`
    : nothing;
  return card("Next up", body, { id: "next_up", trailing: html`${pager}${link}` });
}

const COMMIT_ROWS = 3;

function shipDetail(r: RepoShip, c: DashCtx): TemplateResult[] {
  const unpushed = !r.has_upstream ? kv("Unpushed", "no upstream", "warn")
    : r.ahead > 0 ? kv("Unpushed", `${r.ahead} commit${r.ahead === 1 ? "" : "s"}`, "warn")
    : kv("Unpushed", "none", "good");
  const out: TemplateResult[] = [
    unpushed,
    kv("Working tree", r.dirty_count > 0 ? `${r.dirty_count} changed` : "clean", r.dirty_count > 0 ? "warn" : "good"),
  ];
  if (r.behind > 0) out.push(kv("Behind", `${r.behind} commit${r.behind === 1 ? "" : "s"}`, "warn"));
  out.push(...r.recent_commits.slice(0, COMMIT_ROWS).map((m, i) => row(
    html`<code class="pd-sha ${m.pushed ? "" : "unpushed"}">${m.short_sha}</code>`, m.message,
    { meta: shortAgo(m.timestamp_ms, c.nowMs), title: m.pushed ? undefined : "Not pushed yet", gap: i === 0 },
  )));
  return out;
}

/** A group's repos, one row each: name, branch, and what is not shipped yet. */
function shipRows(ship: RepoShip[]): TemplateResult[] {
  return ship.map((r) => {
    const pending = [
      !r.has_upstream ? "no upstream" : r.ahead > 0 ? `${r.ahead} unpushed` : "",
      r.dirty_count > 0 ? `${r.dirty_count} changed` : "",
    ].filter(Boolean).join(", ");
    return row(icon("git-branch"), html`${r.name} <code class="pd-branch">${r.branch}</code>`, {
      trailing: html`<span class="pd-m ${pending ? "warn" : ""}">${pending || "clean"}</span>`,
    });
  });
}

export function shipState(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "ship")) return nothing;
  const ship = c.snap.ship;
  let body: TemplateResult | TemplateResult[];
  if (ship.length === 0) body = quiet("No git state");
  else if (ship.length === 1) body = shipDetail(ship[0]!, c);
  else body = shipRows(ship);
  return card("Ship state", body, { id: "ship" });
}

export function running(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "running")) return nothing;
  const all = c.snap.servers;
  const { slice: servers, pager } = pageSlice(c, "running", all);
  const body: TemplateResult[] = servers.map((s) => row(dot("ok"),
    html`${s.name} <span class="pd-muted">:${s.port}</span>`, {
      tag: repoTag(c, s.repo_cwd),
      onClick: () => c.act.openUrl(`http://localhost:${s.port}`),
      title: `Open http://localhost:${s.port}`,
    }));
  if (!body.length) body.push(quiet("Nothing running"));
  return card("Running", body, { id: "running", trailing: pager, count: all.length });
}
