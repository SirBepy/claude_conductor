// The Chats card: a Current tab (live chats under the sidebar's own three
// segment names) and a Recent tab (ended chats). Both page in fours.
import { html, nothing, type TemplateResult } from "lit-html";
import { CHAT_GROUPS, chatGroupOf, shortAgo, type ChatGroupId } from "./format";
import { card, dot, hidden, icon, inRepo, quiet, repoTag, row, sub, type ChatsTab, type DashCtx, type DotKind } from "./dash-parts";
import { pageSlice } from "./paging";
import type { DashChatRow } from "./types";

const CHAT_DOT: Record<DashChatRow["status"], DotKind> = {
  question: "q", your_turn: "idle", working: "w", waiting: "idle", ended: "idle",
};

const TABS: Array<{ id: ChatsTab, label: string }> = [
  { id: "current", label: "Current" },
  { id: "recent", label: "Recent" },
];

function liveRow(c: DashCtx, r: DashChatRow): TemplateResult {
  return row(dot(CHAT_DOT[r.status]), r.title, {
    tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, c.nowMs), onClick: () => c.act.openChat(r.session_id),
  });
}

function current(c: DashCtx): { body: TemplateResult[], pager: TemplateResult | typeof nothing } {
  const live = c.snap.chats_running.filter((r) => inRepo(c, r.repo_cwd));
  const order = (r: DashChatRow): number => CHAT_GROUPS.findIndex((g) => g.id === chatGroupOf(r.status));
  const sorted = live.filter((r) => chatGroupOf(r.status)).sort((a, b) => order(a) - order(b));
  const { slice, pager } = pageSlice(c, "chats", sorted);
  const body: TemplateResult[] = [];
  let group: ChatGroupId | null = null;
  for (const r of slice) {
    const g = chatGroupOf(r.status)!;
    if (g !== group) body.push(sub(CHAT_GROUPS.find((x) => x.id === g)!.label));
    group = g;
    body.push(liveRow(c, r));
  }
  return { body: body.length ? body : [quiet("No live chats")], pager };
}

function recent(c: DashCtx): { body: TemplateResult[], pager: TemplateResult | typeof nothing } {
  const past = c.snap.chats_recent.filter((r) => inRepo(c, r.repo_cwd));
  const { slice, pager } = pageSlice(c, "chats-recent", past);
  const body = slice.map((r) => row(icon("chat-circle"), r.title, {
    tag: repoTag(c, r.repo_cwd), meta: shortAgo(r.at_ms, c.nowMs), onClick: () => c.act.openHistory(r.session_id),
  }));
  return { body: body.length ? body : [quiet("No ended chats yet")], pager };
}

export function chats(c: DashCtx): TemplateResult | typeof nothing {
  if (hidden(c, "chats")) return nothing;
  const { body, pager } = c.chatsTab === "current" ? current(c) : recent(c);
  const tabs = html`<div class="pd-rtabs">${TABS.map((t) => html`
    <button type="button" class="pd-rtab ${c.chatsTab === t.id ? "on" : ""}" data-pd-chats-tab=${t.id}
      @click=${() => c.act.setChatsTab(t.id)}>${t.label}</button>`)}</div>`;
  const trailing = html`${tabs}${pager}<button type="button" class="pd-ib sm" title="History" @click=${() => c.act.openAllHistory()}><i class="ph ph-clock-counter-clockwise"></i></button>`;
  return card("Chats", body, { id: "chats", trailing });
}
