import type { RenderedMessage } from "./chat-transforms";
import { extractAttachedFilePaths } from "./chat-transforms";
import { toolSummary, canonicalTool, toolLabel } from "./tool-meta";
import { escapeHtml } from "../escape-html";
import { type ScreenshotShot } from "./screenshot-gallery";
import type { ToolGroup } from "./turn-collapse";

// ---------------------------------------------------------------------------
// Screenshot blocks (ai_todo 313, split off of turn-collapse.ts): any tool's
// image tool_results are pulled out of the raw action log and surfaced as an
// always-visible thumbnail row (turn-collapse's existing per-tool-type chip
// still opens the accordion for the tool's NON-image calls). Agent
// attribution (main turn vs Nth subagent) reuses the same idParent/
// description tracking the nested per-subagent strips in turn-collapse.ts
// are built from, so there is one source of truth for "who called this".
// ---------------------------------------------------------------------------

/** Per-turn map of a screenshot-row element to the shots it currently shows,
 *  so the delegated thumbnail click handler (chat-click-handlers.ts) can look
 *  up the full gallery list without re-parsing the DOM or duplicating base64
 *  image data into attributes. Mirrors attachment-hydrator.ts's chipData map. */
const rowShots = new WeakMap<HTMLElement, ScreenshotShot[]>();

/** Look up the shots a `.screenshot-row` element is currently showing (for the
 *  delegated thumbnail click handler). */
export function getScreenshotRowShots(row: HTMLElement): ScreenshotShot[] | undefined {
  return rowShots.get(row);
}

/**
 * Collect every image tool_result in [start, end), grouped by canonical tool
 * key and tagged with which agent captured it: "main" for a top-level call
 * (no parentToolUseId), or the Nth distinct subagent (Task/Agent tool_use,
 * first-seen order in the turn) otherwise. Recomputed fresh from message data
 * every call - same idempotent full-range-rebuild pattern as turn-collapse.ts's
 * rebuildCustomBucket - so it never depends on which rows a PRIOR flush
 * already folded.
 */
export function collectScreenshotShots(
  messages: RenderedMessage[],
  start: number,
  end: number,
): Map<string, ScreenshotShot[]> {
  const idTool = new Map<string, string>();
  const idInput = new Map<string, unknown>();
  const idParent = new Map<string, string>();
  const agentIndexById = new Map<string, number>();
  let nextAgentIndex = 1;
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || !m.id) continue;
    idTool.set(m.id, m.tool ?? "");
    idInput.set(m.id, m.input);
    if (m.parentToolUseId) idParent.set(m.id, m.parentToolUseId);
    if ((m.tool === "Task" || m.tool === "Agent") && !agentIndexById.has(m.id)) {
      agentIndexById.set(m.id, nextAgentIndex++);
    }
  }

  // The turn's opening user message (activeTurnStart is set right after it's
  // pushed, so it lives one slot before `start`) - files the user attached
  // there whose Claude then Read back shouldn't resurface as a "screenshot":
  // it's the same image they just sent, not a new artifact Claude produced.
  const opener = messages[start - 1];
  const attachedPaths = opener && opener.kind === "user"
    ? extractAttachedFilePaths(opener.content ?? [])
    : new Set<string>();

  const shotsByKey = new Map<string, ScreenshotShot[]>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_result") continue;
    const out = m.output;
    if (!out || out.type !== "image") continue;
    const tid = m.tool_use_id;
    const tool = tid ? idTool.get(tid) : undefined;
    if (!tid || !tool) continue;
    if (tool === "Read" && attachedPaths.size > 0) {
      const input = idInput.get(tid) as { file_path?: unknown } | undefined;
      const readPath = typeof input?.file_path === "string" ? input.file_path : "";
      if (readPath && attachedPaths.has(readPath.toLowerCase().replace(/\\/g, "/"))) continue;
    }

    const key = canonicalTool(tool);
    const parentId = idParent.get(tid) ?? null;
    const agentIdx = parentId ? agentIndexById.get(parentId) : undefined;
    const agentKind: "main" | "sub" = agentIdx ? "sub" : "main";
    const agentTag = agentIdx ? `Sub ${agentIdx}` : "Main";
    const agentLabel = agentIdx ? `Subagent ${agentIdx}` : "Main agent";
    const summary = toolSummary(tool, idInput.get(tid));
    const title = summary.target || toolLabel(key);

    const shot: ScreenshotShot = {
      toolUseId: tid,
      mime: out.mime,
      data: out.data,
      title,
      agentKind,
      agentTag,
      agentLabel,
    };
    const arr = shotsByKey.get(key);
    if (arr) arr.push(shot);
    else shotsByKey.set(key, [shot]);
  }
  return shotsByKey;
}

function screenshotThumbHtml(shot: ScreenshotShot, index: number): string {
  const titleAttr = escapeHtml(`${shot.title} — ${shot.agentTag}`);
  return `<div class="sent-attachment-thumb screenshot-thumb" data-agent="${shot.agentKind}" data-shot-index="${index}" title="${titleAttr}"><span class="screenshot-agent-tag">${escapeHtml(shot.agentTag)}</span><img src="data:${escapeHtml(shot.mime)};base64,${escapeHtml(shot.data)}" alt="${escapeHtml(shot.title)}"></div>`;
}

// Thumbnails per carousel page. The main session window is 520px wide
// (src-tauri/src/ipc/window.rs); each .sent-attachment-thumb is 80px + 2px
// right margin, and the prev/next chevron pair (~22px + gap, each side) takes
// roughly another 50px off the row when shown. That leaves room for about 5
// thumbnails at that width - used as a fixed constant rather than measuring
// the live container, since the row's usable width barely varies across the
// app's chat surfaces (main window / detached chat / history) and a fixed
// number keeps the carousel's paging math simple.
const SCREENSHOT_PER_PAGE = 5;

/** Paint (or repaint) a screenshot-row's paginated thumbnails + carousel nav.
 *  Wires prev/next locally (self-contained pagination state); thumbnail click
 *  is a delegated container-level handler (chat-click-handlers.ts's
 *  handleScreenshotThumbClick), same pattern as handleBlockImageClick. */
function paintScreenshotRow(row: HTMLElement, shots: ScreenshotShot[]): void {
  rowShots.set(row, shots);
  const pages: ScreenshotShot[][] = [];
  for (let i = 0; i < shots.length; i += SCREENSHOT_PER_PAGE) {
    pages.push(shots.slice(i, i + SCREENSHOT_PER_PAGE));
  }
  let page = 0;

  function paint(): void {
    const showNav = pages.length > 1;
    let gi = 0;
    const pagesHtml = pages
      .map((p) => `<div class="screenshot-page">${p.map((s) => screenshotThumbHtml(s, gi++)).join("")}</div>`)
      .join("");
    row.innerHTML = `
      ${showNav ? `<button type="button" class="screenshot-nav screenshot-nav--prev" ${page === 0 ? "disabled" : ""} aria-label="Previous screenshots"><i class="ph ph-caret-left"></i></button>` : ""}
      <div class="screenshot-viewport">
        <div class="screenshot-track" style="transform: translateX(-${page * 100}%)">${pagesHtml}</div>
      </div>
      ${showNav ? `<button type="button" class="screenshot-nav screenshot-nav--next" ${page === pages.length - 1 ? "disabled" : ""} aria-label="Next screenshots"><i class="ph ph-caret-right"></i></button>` : ""}
    `;
    if (row.nextElementSibling?.classList.contains("screenshot-dots")) row.nextElementSibling.remove();
    if (showNav) {
      const dots = document.createElement("div");
      dots.className = "screenshot-dots";
      dots.innerHTML = pages.map((_, i) => `<span class="screenshot-dot${i === page ? " active" : ""}"></span>`).join("");
      row.after(dots);
    }
    row.querySelector(".screenshot-nav--prev")?.addEventListener("click", () => { page = Math.max(0, page - 1); paint(); });
    row.querySelector(".screenshot-nav--next")?.addEventListener("click", () => { page = Math.min(pages.length - 1, page + 1); paint(); });
  }
  paint();
}

/**
 * Mount or refresh the always-visible screenshot block for one canonical tool
 * key within a turn: a small header (title + the tool's real chip, relocated
 * here from the main strip) over a divider, then the paginated thumbnail row.
 * Idempotent: safe to call every flush as more screenshots stream in; the row
 * only repaints (and its carousel resets to page 0) when the shot count
 * actually changed, so an unrelated flush never disturbs an in-progress
 * carousel page.
 */
export function mountScreenshotBlock(
  stripHost: HTMLElement,
  group: ToolGroup,
  key: string,
  shots: ScreenshotShot[],
): void {
  let block = stripHost.querySelector<HTMLElement>(`:scope > .screenshot-block[data-tool="${key}"]`);
  if (!block) {
    block = document.createElement("div");
    block.className = "screenshot-block";
    block.dataset.tool = key;
    const header = document.createElement("div");
    header.className = "screenshot-block-header";
    const title = document.createElement("span");
    title.className = "screenshot-block-title";
    title.textContent = "Screenshots";
    header.appendChild(title);
    const divider = document.createElement("div");
    divider.className = "screenshot-block-divider";
    const row = document.createElement("div");
    row.className = "screenshot-row";
    block.appendChild(header);
    block.appendChild(divider);
    block.appendChild(row);
  }
  // Keep the block immediately before the shared main strip, so it reads as
  // "replacing" the relocated chip's old position (screenshot-block, then
  // whatever other tools' chips remain, then the shared accordion panel).
  if (block.parentElement !== stripHost || block.nextElementSibling !== group.strip) {
    stripHost.insertBefore(block, group.strip);
  }
  // Relocate the tool's real chip into the header (idempotent DOM move) so it
  // keeps its normal label/count/click-to-toggle behavior, just repositioned.
  const header = block.querySelector<HTMLElement>(".screenshot-block-header")!;
  if (group.chip.parentElement !== header) header.appendChild(group.chip);

  if (block.dataset.shotCount === String(shots.length)) return;
  block.dataset.shotCount = String(shots.length);
  const row = block.querySelector<HTMLElement>(".screenshot-row")!;
  paintScreenshotRow(row, shots);
}
