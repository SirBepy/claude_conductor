// The Answers card's pure helpers: merging a fresh daemon load into what the card
// already holds, and decorating the History palette's rows. No DOM state of the
// card's own, so they live apart from the class.

import { escapeHtml } from "../../../shared/escape-html";
import { plural } from "../../../shared/plural";
import type { AskThread } from "../../../types/ipc.generated";
import { ownText, threadFollowUps, type AnswerItem, type AnswerStore } from "../../../shared/chat/dashboard/answers-model";
import type { PaletteCommand } from "../../command-palette/types";

const esc = escapeHtml;

/** How long a thread the daemon's list lacks is kept: long enough for a load
 *  that started before its reply was saved, short enough that a thread gone
 *  from the daemon's store leaves the card. */
const LOCAL_THREAD_GRACE_MS = 60_000;

/** The newer copy of each thread wins (a reply only ever adds messages). */
export function mergeThreads(server: readonly AskThread[], local: readonly AskThread[]): AskThread[] {
  const out = [...server];
  const now = Date.now();
  for (const t of local) {
    const i = out.findIndex((x) => x.id === t.id);
    if (i < 0) {
      if (now - Number(t.updated_at) < LOCAL_THREAD_GRACE_MS) out.push(t);
    } else if (t.messages.length > out[i]!.messages.length) out[i] = t;
  }
  return out;
}

/** Read marks only ever move forward, so a reply's state never undoes a Got it still in flight. */
export function mergeStore(server: AnswerStore, local: AnswerStore): AnswerStore {
  const read = { ...server.read };
  for (const [k, v] of Object.entries(local.read)) if ((read[k] ?? -1) < v) read[k] = v;
  return {
    read,
    threads: { ...local.threads, ...server.threads },
    questions: server.questions.length >= local.questions.length ? server.questions : local.questions,
    rewrites: { ...local.rewrites, ...server.rewrites },
  };
}

export function decorateHistory(
  list: HTMLElement,
  shown: readonly PaletteCommand[],
  query: string,
  byId: ReadonlyMap<string, AnswerItem>,
  groupOf: ReadonlyMap<string, string>,
  headings: boolean,
): void {
  const q = query.trim().toLowerCase();
  let prev = "";
  list.querySelectorAll<HTMLElement>(".cp-row").forEach((row) => {
    const c = shown[Number(row.dataset.index)];
    const it = c ? byId.get(c.id) : undefined;
    if (!c || !it) return;
    // A row whose answer has a thread says so: a small chat icon and its count.
    if (it.replies > 0) {
      row.querySelector(".cp-spacer")?.insertAdjacentHTML("beforebegin",
        `<span class="ax-cp-th" title="Has a thread: ${plural(it.replies, "back-and-forth")}"><i class="ph ph-chats-circle"></i>${it.replies}</span>`);
    }
    // A row found only through its thread says so, with the words that matched.
    if (q && !ownText(it).toLowerCase().includes(q)) {
      const hit = threadFollowUps(it).map((m) => m.text).find((t) => t.toLowerCase().includes(q));
      if (hit) {
        const at = hit.toLowerCase().indexOf(q);
        const from = Math.max(0, at - 24);
        const end = at + q.length + 30;
        const snip = (from ? "..." : "") + hit.slice(from, end).replace(/\n/g, " ") + (end < hit.length ? "..." : "");
        row.querySelector(".cp-title")?.insertAdjacentHTML("afterend",
          `<span class="cp-detail"><span class="ax-cp-tag"><i class="ph ph-chats-circle"></i>in thread</span><span class="ax-cp-snip">${esc(snip)}</span></span>`);
      }
    }
    // A heading opens each group, only while the list is in its own order and holds two groups or more.
    const g = groupOf.get(c.id) ?? "";
    if (headings && !q && g !== prev) row.insertAdjacentHTML("beforebegin", `<div class="cp-section ax-sec">${esc(g)}</div>`);
    prev = g;
  });
}
