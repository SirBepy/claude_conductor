// The `write_draft` card: an outbound message draft as its own message row,
// expanded, readable and copyable without leaving the transcript (Joe
// 2026-09-26). The Drafts panel still owns EDITING - this is a read/copy view
// of the same store row, and ⤢ hands the id to the panel.
//
// Live, not a snapshot: a mounted card re-reads `list_message_drafts` whenever
// the store changes, so Joe's own panel edit and any later `revise` show up in
// the row Claude first wrote it in. One module-level subscription sweeps every
// mounted card in the document rather than one listener per row - a row the
// chat renderer replaced is simply no longer found, so nothing leaks.

import { invoke } from "../ipc";
import { getTransport, type Unlisten } from "../transport";
import { escapeHtml } from "../escape-html";
import { asObj, strField } from "../obj-utils";
import { renderMarkdown } from "./chat-transforms";
import type { RenderedMessage } from "./chat-classifiers";
import type { ContentBlock, MessageDraft, DraftVariant } from "../../types/ipc.generated";

/** Fired on `window` when a card's ⤢ is clicked; the sessions view listens and
 *  hands the draft id to the FAB's Drafts panel. `detail: { id }`. */
export const DRAFT_OPEN_EVENT = "cc-draft-open";

/** The exact markdown each mounted card is currently showing, so Copy hands
 *  over the store's own text rather than re-serializing the rendered DOM back
 *  to markdown and losing whatever the round-trip cannot express. Keyed by
 *  element, so a row the renderer replaced drops out on its own. */
const markdownOf = new WeakMap<HTMLElement, string>();

/** Mirrors drafts-editor.ts's own helper. Duplicated rather than imported:
 *  `shared/chat` must not reach into `views/sessions`, and the panel module
 *  pulls in the whole contenteditable editor. */
function currentVersion(variant: DraftVariant) {
  return variant.versions.find((v) => v.n === variant.current) ?? variant.versions[variant.versions.length - 1];
}

function handleOf(variant: DraftVariant): string {
  return `${variant.recipient} #${variant.handle_n}`;
}

/** The `kind:"draft"` row's own fields, read off the tool_use input. Shared by
 *  the live and scrollback paths so the two can never drift.
 *
 *  `revise` carries only id+body, so `draftTopic` is empty there and the
 *  mounted card fills it from the store. */
export function draftFieldsOf(input: unknown): Pick<
  RenderedMessage,
  "draftAction" | "draftTopic" | "draftRecipient" | "draftBody" | "text"
> {
  const o = asObj(input);
  const raw = strField(o, "action");
  const action = raw === "revise" || raw === "variant" || raw === "drop" ? raw : "add";
  const topic = strField(o, "topic").trim();
  return {
    draftAction: action,
    draftTopic: topic,
    draftRecipient: strField(o, "recipient").trim(),
    draftBody: strField(o, "body"),
    text: topic,
  };
}

/** What the tool_result tells us that the input could not: the real draft id,
 *  and the version number this call produced. Returns null for a result that
 *  carries no draft at all (an error, or a body that is not the JSON the
 *  `/drafts/write` route answers with).
 *
 *  `output` is the result's own text block, whose text is the route's whole
 *  JSON response - `mcp::relay` passes `resp.to_string()` straight through for
 *  write_draft, since it declares no `success` string. */
export function draftResultFieldsOf(
  output: ContentBlock | null | undefined,
): Pick<RenderedMessage, "draftId" | "draftTopic" | "draftRecipient" | "draftVersion"> | null {
  if (!output || output.type !== "text") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.text);
  } catch {
    return null;
  }
  const o = asObj(parsed);
  const dropped = strField(o, "dropped");
  if (dropped) return { draftId: dropped };
  const draft = asObj(o.draft);
  const id = strField(draft, "id");
  if (!id) return null;
  const variants = Array.isArray(draft.variants) ? (draft.variants as DraftVariant[]) : [];
  // Last variant, not first: a `variant` call appends, so the one this call
  // produced is at the end. For add/revise there is only ever one candidate.
  const mine = variants[variants.length - 1];
  return {
    draftId: id,
    draftTopic: strField(draft, "topic"),
    draftRecipient: mine?.recipient ?? "",
    draftVersion: mine?.current,
  };
}

/** The action verb shown on the card header. */
function actionLabel(m: RenderedMessage): string {
  switch (m.draftAction) {
    case "revise": return "Revised draft";
    case "variant": return "New wording";
    case "drop": return "Dropped draft";
    default: return "Draft message";
  }
}

/** Card markup. Painted from the tool_use input alone, so it is on screen
 *  before the daemon answers; `mountDraftCard` swaps in the store's copy. */
export function renderDraftCardHtml(m: RenderedMessage): string {
  const isDrop = m.draftAction === "drop";
  const label = actionLabel(m);
  const who = m.draftRecipient ? `<span class="dc-to">${escapeHtml(m.draftRecipient)}</span>` : "";
  const topic = m.draftTopic ? `<span class="dc-topic">${escapeHtml(m.draftTopic)}</span>` : "";
  return `<div class="dc-head">`
    + `<i class="ph ${isDrop ? "ph-trash" : "ph-paper-plane-tilt"} dc-icon"></i>`
    + `<span class="dc-label">${escapeHtml(label)}</span>`
    + who
    + topic
    + `<span class="dc-grow"></span>`
    + `<span class="dc-ver"></span>`
    + (isDrop
      ? ""
      : `<button type="button" class="dc-act" data-draft-copy title="Copy the message"><i class="ph ph-copy"></i><span>Copy</span></button>`
        + `<button type="button" class="dc-act dc-pop" data-draft-pop title="Open in the Drafts panel"><i class="ph ph-arrows-out-simple"></i></button>`)
    + `<i class="ph ph-caret-down dc-chevron" data-draft-toggle title="Fold"></i>`
    + `</div>`
    + `<div class="dc-body">${renderMarkdown(m.draftBody ?? "")}</div>`
    + `<div class="dc-foot"><i class="ph ph-info"></i><span class="dc-foot-text">Not sent anywhere - copy it yourself.</span></div>`;
}

/** Resolves which version a row should be SHOWING. Every write_draft action
 *  gets its own row, so several rows can point at one variant; the newest is
 *  the live one and shows the current text, while an older row shows the exact
 *  version it created and folds itself away. Without this the transcript would
 *  repeat one body verbatim once per revise. */
function versionForRow(el: HTMLElement, variant: DraftVariant | undefined) {
  if (!variant) return { version: undefined, superseded: false };
  const rowN = Number(el.dataset.draftVersion);
  if (!Number.isFinite(rowN) || rowN >= variant.current) {
    return { version: currentVersion(variant), superseded: false };
  }
  const own = variant.versions.find((v) => v.n === rowN);
  // An unknown row version (a pruned history, a store rewrite) falls back to
  // live rather than rendering an empty card.
  return own ? { version: own, superseded: true } : { version: currentVersion(variant), superseded: false };
}

/** Repaints one mounted card from the store. Leaves the pre-daemon paint alone
 *  when the id is not resolved yet; a draft deleted underneath the row keeps
 *  showing what it said, greyed, rather than emptying out. */
async function refreshCard(el: HTMLElement): Promise<void> {
  const id = el.dataset.draftId;
  const sessionId = el.dataset.draftSession;
  if (!id || !sessionId) return;
  let drafts: MessageDraft[];
  try {
    const view = await invoke<{ drafts: MessageDraft[] }>("list_message_drafts", { sessionId });
    drafts = Array.isArray(view?.drafts) ? view.drafts : [];
  } catch (err) {
    console.error("[draft-card] list_message_drafts failed", err);
    return;
  }
  const draft = drafts.find((d) => d.id === id);
  if (!draft) {
    el.classList.add("gone");
    const foot = el.querySelector<HTMLElement>(".dc-foot-text");
    if (foot) foot.textContent = "Deleted from the Drafts panel.";
    return;
  }
  el.classList.remove("gone");
  const wanted = el.dataset.draftRecipient;
  const variant = draft.variants.find((v) => v.recipient === wanted) ?? draft.variants[0];
  const { version, superseded } = versionForRow(el, variant);
  const body = el.querySelector<HTMLElement>(".dc-body");
  if (body && version) {
    body.innerHTML = renderMarkdown(version.body);
    markdownOf.set(el, version.body);
  }
  const topic = el.querySelector<HTMLElement>(".dc-topic");
  if (topic) topic.textContent = draft.topic;
  const to = el.querySelector<HTMLElement>(".dc-to");
  if (to && variant) to.textContent = handleOf(variant);
  const ver = el.querySelector<HTMLElement>(".dc-ver");
  if (ver && version) {
    // Authorship, not just a number: "v3 · your edit" is the one thing that
    // tells Joe the card no longer says what Claude wrote.
    const who = version.author === "user" ? " · your edit" : "";
    ver.textContent = superseded ? `v${version.n} · superseded by v${variant?.current}` : `v${version.n}${who}`;
  }
  // Folded, not hidden: the row stays clickable so the wording Claude tried
  // first is still reachable.
  el.classList.toggle("superseded", superseded);
  if (superseded) el.classList.remove("open");
  el.classList.toggle("copied", draft.state === "copied");
  el.dataset.draftState = draft.state;
}

/** Stamps the row's identity onto the element and paints the store's copy over
 *  the tool_use snapshot. A row whose call never resolved gets neither. */
export function mountDraftCard(el: HTMLElement, m: RenderedMessage, sessionId: string | null): void {
  markdownOf.set(el, m.draftBody ?? "");
  if (!m.draftId || !sessionId) {
    el.classList.add("unresolved");
    const foot = el.querySelector<HTMLElement>(".dc-foot-text");
    if (foot && m.draftFailed) foot.textContent = "This draft was never written - the call failed.";
    return;
  }
  el.dataset.draftId = m.draftId;
  el.dataset.draftSession = sessionId;
  if (m.draftRecipient) el.dataset.draftRecipient = m.draftRecipient;
  if (m.draftVersion !== undefined) el.dataset.draftVersion = String(m.draftVersion);
  void ensureDraftCardsLive();
  void refreshCard(el);
}

// ── Live refresh ──────────────────────────────────────────────────────────

let unlisten: Unlisten | null = null;

/** Sweeps every mounted card in the document. Elements the chat renderer has
 *  replaced are not in the DOM, so they fall out with no bookkeeping. */
function refreshAll(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".msg.draft-card[data-draft-id]")) {
    void refreshCard(el);
  }
}

/** Idempotent: called on every card mount, subscribes exactly once per window.
 *  Never torn down - one listener for the window's lifetime, matching how the
 *  cards themselves outlive any single chat. */
export async function ensureDraftCardsLive(): Promise<void> {
  if (unlisten) return;
  // Sentinel before the await so two mounts in one tick cannot both subscribe.
  unlisten = () => {};
  try {
    // Kebab, not the snake_case name the daemon publishes: it renames on the
    // way out on both transports, and the snake name matches nothing (the
    // same trap drafts-panel.ts documents).
    unlisten = await getTransport().listen("message-drafts-changed", () => refreshAll());
  } catch (err) {
    console.warn("[draft-card] listen(message-drafts-changed) failed", err);
    unlisten = null;
  }
}

/** Both payloads in one write, mirroring drafts-editor.ts's Copy: Slack and
 *  Google Chat read the tags, a plain field gets the markdown rather than
 *  stripped mush. Flips the draft to `copied`, which is also what drops it out
 *  of the per-turn injection. */
export function copyDraftCard(el: HTMLElement, btn: HTMLElement): void {
  const body = el.querySelector<HTMLElement>(".dc-body");
  if (!body) return;
  const html = body.innerHTML;
  const plain = markdownOf.get(el) ?? (body.textContent ?? "").trim();
  const done = (): void => {
    const icon = btn.querySelector("i");
    if (icon) icon.className = "ph ph-check";
    setTimeout(() => {
      const back = btn.querySelector("i");
      if (back) back.className = "ph ph-copy";
    }, 1500);
    const id = el.dataset.draftId;
    const sessionId = el.dataset.draftSession;
    if (!id || !sessionId) return;
    void invoke("set_draft_state", { sessionId, id, next: "copied" })
      .catch((err) => console.error("[draft-card] set_draft_state failed", err));
  };
  void navigator.clipboard
    .write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ])
    .then(done)
    .catch(() => void navigator.clipboard.writeText(plain).then(done));
}
