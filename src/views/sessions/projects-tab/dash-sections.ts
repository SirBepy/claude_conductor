// The built-in dashboard cards: Needs you, Your todos, Chats, Next up, Ship
// state, Running. Each returns nothing when its builtin id is hidden.
import { html, nothing, type TemplateResult } from "lit-html";
import { shortAgo, whenLabel } from "./format";
import {
  card, dot, hidden, icon, inRepo, isGroup, kv, quiet, repoTag, row, sub,
  type DashCtx, type DotKind,
} from "./dash-parts";
import type { DashChatRow, NeedsYouItem, RepoShip } from "./types";

// A client repo can hold a dozen unsent drafts at once; one row each buries
// the open questions under them, so past this many a repo's drafts share a row.
const DRAFT_ROWS_PER_REPO = 2;

function draftRollups(items: NeedsYouItem[]): { keep: NeedsYouItem[], rollups: NeedsYouItem[][] } {
  const byRepo = new Map<string, NeedsYouItem[]>();
  for (const i of items) if (i.kind === "draft") byRepo.set(i.repo_cwd, [...(byRepo.get(i.repo_cwd) ?? []), i]);
  const rolled = new Set([...byRepo.values()].filter((d) => d.length > DRAFT_ROWS_PER_REPO).flat());
  return {
    keep: items.filter((i) => !rolled.has(i)),
    rollups: [...byRepo.values()].filter((d) => d.length > DRAFT_ROWS_PER_REPO),
  };
}

export function needsYou(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "needs_you")) return nothing;
  const { keep: items, rollups } = draftRollups(c.snap.needs_you.filter((i) => inRepo(c, i.repo_cwd)));
  const rolled = rollups.map((drafts) => {
    const newest = drafts.reduce((a, b) => (b.at_ms > a.at_ms ? b : a));
    return row(icon("note-pencil"), `${drafts.length} drafts not sent yet`, {
      meta: shortAgo(newest.at_ms, c.nowMs), tag: repoTag(c, newest.repo_cwd),
      title: drafts.map((d) => d.title).join("\n"),
      onClick: newest.draft_id ? () => c.act.openDraft(newest.draft_id!, newest.session_id) : undefined,
    });
  });
  const rows = items.map((i) => {
    const tag = repoTag(c, i.repo_cwd);
    const meta = shortAgo(i.at_ms, c.nowMs);
    if (i.kind === "question") {
      return row(dot("q"), html`<b>${i.title}</b> ${i.detail || "is waiting on your answer"}`, {
        meta, tag, onClick: i.session_id ? () => c.act.openChat(i.session_id!) : undefined,
      });
    }
    return row(icon("note-pencil"), `Draft not sent yet: ${i.title}`, {
      meta, tag, title: i.detail || undefined,
      onClick: i.draft_id ? () => c.act.openDraft(i.draft_id!, i.session_id) : undefined,
    });
  });
  const all = [...rows, ...rolled];
  return card("Needs you", all.length ? all : quiet("Nothing waiting"), { id: "needs_you", full: true });
}

export function yourTodos(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "your_todos")) return nothing;
  const todos = c.snap.your_todos.filter((t) => inRepo(c, t.repo_cwd));
  if (todos.length === 0) return nothing;
  const rows = todos.map((t) => {
    const done = c.doneTodos.has(t.id);
    return html`<label class="pd-row pd-todo ${done ? "is-done" : ""}">
      <input type="checkbox" .checked=${done} @change=${() => c.act.toggleTodo(t)}>
      <span class="pd-t">${t.text}</span>${repoTag(c, t.repo_cwd)}
      ${t.by_ai ? html`<span class="pd-m">from a chat</span>` : nothing}
    </label>`;
  });
  return card("Your todos", rows, { id: "your_todos", full: true });
}

const CHAT_DOT: Record<DashChatRow["status"], DotKind> = {
  question: "q", your_turn: "idle", working: "w", waiting: "idle", ended: "idle",
};

const CHAT_META: Record<DashChatRow["status"], string> = {
  question: "waiting on you", your_turn: "your turn", working: "working", waiting: "waiting", ended: "",
};

export function chats(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "chats")) return nothing;
  const running = c.snap.chats_running.filter((r) => inRepo(c, r.repo_cwd));
  const recent = c.snap.chats_recent.filter((r) => inRepo(c, r.repo_cwd));
  const live = running.map((r) => row(dot(CHAT_DOT[r.status]), r.title, {
    tag: repoTag(c, r.repo_cwd),
    meta: r.status === "working" ? `working ${shortAgo(r.at_ms, c.nowMs)}` : CHAT_META[r.status],
    onClick: () => c.act.openChat(r.session_id),
  }));
  const past = recent.map((r) => row(icon("chat-circle"), r.title, {
    tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, c.nowMs),
    onClick: () => c.act.openHistory(r.session_id),
  }));
  const body: TemplateResult[] = [...live];
  if (past.length) body.push(sub("Recent"), ...past);
  if (!body.length) body.push(quiet("No chats yet"));
  const trailing = html`<a class="pd-link" @click=${() => c.act.openAllHistory()}>History</a>`;
  return card("Chats", body, { id: "chats", trailing });
}

export function nextUp(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "next_up")) return nothing;
  const plan = c.snap.plan.filter((p) => inRepo(c, p.repo_cwd));
  const scheduled = c.snap.scheduled.filter((s) => inRepo(c, s.repo_cwd));
  // Sections become subheadings rather than a per-row meta column: the meta
  // repeated the same phrase on every row and squeezed the item text.
  const body: TemplateResult[] = [];
  let section: string | null = null;
  for (const p of plan) {
    if (!p.priority && p.section !== section) body.push(sub(p.section));
    section = p.priority ? null : p.section;
    body.push(row(icon(p.priority ? "star" : "circle"), p.id ? `#${p.id} ${p.text}` : p.text,
      { tag: repoTag(c, p.repo_cwd) }));
  }
  if (scheduled.length) {
    body.push(sub("Scheduled"), ...scheduled.map((s) => row(icon("alarm"), s.label,
      { tag: repoTag(c, s.repo_cwd), meta: whenLabel(s.fire_at_ms, c.nowMs) })));
  }
  if (!body.length) body.push(quiet("Nothing queued"));
  const single = !isGroup(c) ? c.snap.target.repos[0]?.cwd : null;
  const trailing = single
    ? html`<a class="pd-link" @click=${() => c.act.openFile(`${single}/.claude/todos/PLAN.md`)}>PLAN.md</a>`
    : nothing;
  return card("Next up", body, { id: "next_up", trailing });
}

function shipDetail(r: RepoShip, c: DashCtx): TemplateResult[] {
  const unpushed = !r.has_upstream ? kv("Unpushed", "no upstream", "warn")
    : r.ahead > 0 ? kv("Unpushed", `${r.ahead} commit${r.ahead === 1 ? "" : "s"}`, "warn")
    : kv("Unpushed", "none", "good");
  const out: TemplateResult[] = [
    unpushed,
    kv("Working tree", r.dirty_count > 0 ? `${r.dirty_count} changed` : "clean", r.dirty_count > 0 ? "warn" : "good"),
  ];
  if (r.behind > 0) out.push(kv("Behind", `${r.behind} commit${r.behind === 1 ? "" : "s"}`, "warn"));
  if (r.recent_commits.length) {
    out.push(sub("Recent commits"), ...r.recent_commits.map((m) => row(
      html`<code class="pd-sha ${m.pushed ? "" : "unpushed"}">${m.short_sha}</code>`, m.message,
      { meta: shortAgo(m.timestamp_ms, c.nowMs), title: m.pushed ? undefined : "Not pushed yet" },
    )));
  }
  return out;
}

function shipTable(ship: RepoShip[]): TemplateResult {
  return html`<table class="pd-tbl"><tr><th></th><th>Branch</th><th>Unpushed</th><th>Tree</th></tr>
    ${ship.map((r) => html`<tr>
      <td>${r.name}</td><td><code>${r.branch}</code></td>
      <td class=${r.ahead > 0 || !r.has_upstream ? "warn" : ""}>${r.has_upstream ? r.ahead : "-"}</td>
      <td class=${r.dirty_count > 0 ? "warn" : ""}>${r.dirty_count > 0 ? `${r.dirty_count} dirty` : "clean"}</td>
    </tr>`)}</table>`;
}

export function shipState(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "ship")) return nothing;
  const ship = c.snap.ship.filter((r) => inRepo(c, r.cwd));
  let body: TemplateResult | TemplateResult[];
  if (ship.length === 0) body = quiet("No git state");
  else if (ship.length === 1) body = shipDetail(ship[0]!, c);
  else body = shipTable(ship);
  return card("Ship state", body, { id: "ship" });
}

export function running(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "running")) return nothing;
  const servers = c.snap.servers.filter((s) => inRepo(c, s.repo_cwd));
  const body: TemplateResult[] = servers.map((s) => row(dot("ok"),
    html`${s.name} <span class="pd-muted">:${s.port}</span>`, {
      tag: repoTag(c, s.repo_cwd),
      onClick: () => c.act.openUrl(`http://localhost:${s.port}`),
      title: `Open http://localhost:${s.port}`,
    }));
  const note = c.snap.last_channel_message;
  if (c.snap.peers_active > 0 || note) {
    body.push(sub("Other sessions here"));
    if (c.snap.peers_active > 0) {
      const n = c.snap.peers_active;
      body.push(row(icon("users-three"), `${n} chat${n === 1 ? "" : "s"} active in this repo`));
    }
    if (note) body.push(row(icon("chat-text"), `“${note.text}”`, {
      meta: shortAgo(note.at_ms, c.nowMs), title: note.author,
    }));
  }
  if (!body.length) body.push(quiet("Nothing running"));
  return card("Running", body, { id: "running" });
}
