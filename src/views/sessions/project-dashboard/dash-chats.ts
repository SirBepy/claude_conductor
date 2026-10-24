// The Chats section: one list. Live chats first (the sidebar's own segment
// order, paged in fours), then the three most recently ended ones in muted
// text. The heading's History button opens every past chat.
import { html, nothing, type TemplateResult } from "lit-html";
import { CHAT_GROUPS, chatGroupOf, shortAgo } from "./format";
import { card, dot, hidden, icon, quiet, repoTag, row, type DashCtx, type DotKind } from "./dash-parts";
import { pageSlice } from "./paging";
import type { DashChatRow } from "./types";

const RECENT_ROWS = 3;
const PAST_LABEL = "Recently closed";

const CHAT_DOT: Record<DashChatRow["status"], DotKind> = {
  question: "q", your_turn: "idle", working: "w", waiting: "idle", ended: "idle",
};

function liveRow(c: DashCtx, r: DashChatRow): TemplateResult {
  // A chat waiting on your answer reads red, not only its dot.
  const title = r.status === "question" ? html`<span class="pd-ask">${r.title}</span>` : r.title;
  return row(dot(CHAT_DOT[r.status]), title, {
    tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, c.nowMs), onClick: () => c.act.openChat(r.session_id),
    ctx: { kind: "chat", sessionId: r.session_id, live: true },
  });
}

function pastRow(c: DashCtx, r: DashChatRow): TemplateResult {
  return row(icon("chat-circle"), html`<span class="pd-muted">${r.title}</span>`, {
    tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, c.nowMs), onClick: () => c.act.openHistory(r.session_id),
    ctx: { kind: "chat", sessionId: r.session_id, live: false },
  });
}

export function chats(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "chats")) return nothing;
  const order = (r: DashChatRow): number => CHAT_GROUPS.findIndex((g) => g.id === chatGroupOf(r.status));
  const sorted = c.snap.chats_running.filter((r) => chatGroupOf(r.status)).sort((a, b) => order(a) - order(b));
  const { slice, pager } = pageSlice(c, "chats", sorted);
  const past = c.snap.chats_recent.slice(0, RECENT_ROWS);
  // The groups keep the sidebar's order as one unbroken list; the dot says which one a row is in.
  const divider = slice.length && past.length ? [html`<div class="pd-sub" data-pd-past-label>${PAST_LABEL}</div>`] : [];
  const body = [...slice.map((r) => liveRow(c, r)), ...divider, ...past.map((r) => pastRow(c, r))];
  const trailing = html`${pager}<button type="button" class="pd-ib sm" title="History" data-pd-all-history
    @click=${() => c.act.openAllHistory()}><i class="ph ph-clock-counter-clockwise"></i></button>`;
  return card("Chats", body.length ? body : [quiet("No chats yet")], { id: "chats", trailing });
}
