// Tool-chip-folding machinery (ai_todo 313, split off of turn-collapse.ts):
// groups a turn's compact tool rows into one strip of chips per tool type,
// with nested strips for subagent children.

import type { RenderedMessage } from "./chat-transforms";
import { toolSummary, canonicalTool, toolLabel } from "./tool-meta";
import { CUSTOM_VIEW_TOOLS, renderCustomToolView } from "./tool-views";
import { collectScreenshotShots, mountScreenshotBlock, getScreenshotRowShots } from "./screenshot-row";
import { foldAuthoredIntoStrip } from "./author-message-group";

/** Per-tool-type state for one turn's strip. */
export interface ToolGroup {
  chip: HTMLElement;
  bucket: HTMLElement;
  strip: HTMLElement;
  panel: HTMLElement;
}

// ---------------------------------------------------------------------------
// DOM helpers shared by main-strip and nested-strip creation
// ---------------------------------------------------------------------------

/** Create a tool-chip button (without appending anywhere). */
function makeChip(key: string, opts?: { label?: string; icon?: string; agent?: boolean }): HTMLElement {
  const icon = opts?.icon ?? toolSummary(key, {}).icon;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = opts?.agent ? "tool-chip tool-chip--agent" : "tool-chip";
  chip.dataset.tool = key;
  chip.dataset.count = "0";
  const iconEl = document.createElement("i");
  iconEl.className = `ph ${icon}`;
  const labelEl = document.createElement("span");
  labelEl.className = "tool-chip-label";
  labelEl.textContent = opts?.label ?? toolLabel(key);
  const countEl = document.createElement("span");
  countEl.className = "tool-chip-count";
  countEl.textContent = "x0";
  chip.appendChild(iconEl);
  chip.appendChild(labelEl);
  chip.appendChild(countEl);
  return chip;
}

/** Shared by groupToolRange and ensureMetaChip (turn-chips.ts) so whichever
 *  runs first for a turn creates the strip/panel pair and the other reuses
 *  it - never two competing `.tool-strip` rows in one footer. */
export function ensureMainStrip(host: HTMLElement): { strip: HTMLElement; panel: HTMLElement } {
  const existingStrip = host.querySelector<HTMLElement>(":scope > .tool-strip");
  const existingPanel = existingStrip?.nextElementSibling;
  if (existingStrip && existingPanel instanceof HTMLElement && existingPanel.classList.contains("tool-strip-panel")) {
    return { strip: existingStrip, panel: existingPanel };
  }
  const strip = document.createElement("div");
  strip.className = "tool-strip";
  const panel = document.createElement("div");
  panel.className = "tool-strip-panel";
  panel.hidden = true;
  host.appendChild(strip);
  host.appendChild(panel);
  return { strip, panel };
}

/**
 * Create a tool-strip + tool-strip-panel pair. When `host` is given (the
 * turn's footer) the pair is reused/created there via ensureMainStrip - after
 * the meta chips row, so the strip is the footer's second row. Without a host
 * it falls back to the legacy placement before `anchorEl` (first tool row).
 */
function makeStripPair(anchorEl: HTMLElement, host?: HTMLElement | null): { strip: HTMLElement; panel: HTMLElement } {
  if (host) return ensureMainStrip(host);
  const strip = document.createElement("div");
  strip.className = "tool-strip";
  const panel = document.createElement("div");
  panel.className = "tool-strip-panel";
  panel.hidden = true;
  anchorEl.parentElement?.insertBefore(strip, anchorEl);
  strip.after(panel);
  return { strip, panel };
}

/** Append a new ToolGroup (chip + bucket) to an existing strip/panel pair. */
function addGroupToStrip(
  key: string,
  strip: HTMLElement,
  panel: HTMLElement,
  opts?: { label?: string; icon?: string; agent?: boolean },
): ToolGroup {
  const chip = makeChip(key, opts);
  strip.appendChild(chip);

  const bucket = document.createElement("div");
  bucket.className = "tool-strip-group";
  bucket.dataset.tool = key;
  bucket.hidden = true;
  panel.appendChild(bucket);

  return { chip, bucket, strip, panel };
}

/** Write a chip's count to `n` (both the dataset and the visible "xN"). */
function setChipCount(chip: HTMLElement, n: number): void {
  chip.dataset.count = String(n);
  const countEl = chip.querySelector(".tool-chip-count");
  if (countEl) countEl.textContent = `x${n}`;
}

/** Move everything `src` shows into `dest`, then drop `src`: same-tool chips
 *  merge (counts add, buckets concatenate) and screenshot rows re-mount from
 *  the concatenated shots. Only for a wake turn that rendered no bubble, so
 *  nothing ever sat between the two footers anyway. */
export function absorbFooterContents(src: HTMLElement, dest: HTMLElement): void {
  const srcStrip = src.querySelector<HTMLElement>(":scope > .tool-strip");
  const srcPanelEl = srcStrip?.nextElementSibling;
  const srcPanel = srcPanelEl instanceof HTMLElement && srcPanelEl.classList.contains("tool-strip-panel")
    ? srcPanelEl
    : null;
  if (srcStrip) {
    const { strip, panel } = ensureMainStrip(dest);
    for (const node of [...srcStrip.children]) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("tool-chip")) continue;
      const key = node.dataset.tool;
      const srcBucket = key && srcPanel
        ? srcPanel.querySelector<HTMLElement>(`:scope > .tool-strip-group[data-tool="${key}"]`)
        : null;
      const destChip = key
        ? strip.querySelector<HTMLElement>(`:scope > .tool-chip[data-tool="${key}"]`)
        : null;
      if (destChip) {
        setChipCount(destChip, Number(destChip.dataset.count ?? "0") + Number(node.dataset.count ?? "0"));
        const destBucket = panel.querySelector<HTMLElement>(`:scope > .tool-strip-group[data-tool="${key}"]`);
        if (srcBucket && destBucket) {
          while (srcBucket.firstChild) destBucket.appendChild(srcBucket.firstChild);
        }
        srcBucket?.remove();
        node.remove();
        continue;
      }
      // Meta chips (Scheduled wake, peer, retry) lead the strip - same
      // placement ensureMetaChip gives them on their own footer.
      if (node.classList.contains("tool-chip--meta")) strip.prepend(node);
      else strip.appendChild(node);
      if (srcBucket) panel.appendChild(srcBucket);
    }
    srcStrip.remove();
    srcPanel?.remove();
  }

  // Whatever else the footer carried (a settled todo checklist, say) lands
  // above dest's screenshots, keeping the chips-then-images reading order.
  const shotAnchor = dest.querySelector<HTMLElement>(":scope > .screenshot-block");
  for (const node of [...src.children]) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.classList.contains("turn-meta-chips") || node.classList.contains("screenshot-block")) continue;
    if (shotAnchor) dest.insertBefore(node, shotAnchor);
    else dest.appendChild(node);
  }

  for (const block of [...src.querySelectorAll<HTMLElement>(":scope > .screenshot-block")]) {
    const key = block.dataset.tool ?? "";
    const srcRow = block.querySelector<HTMLElement>(".screenshot-row");
    const shots = (srcRow && getScreenshotRowShots(srcRow)) || [];
    const destRow = dest.querySelector<HTMLElement>(`:scope > .screenshot-block[data-tool="${key}"] .screenshot-row`);
    const existing = (destRow && getScreenshotRowShots(destRow)) || [];
    block.remove();
    if (shots.length > 0) mountScreenshotBlock(dest, key, [...existing, ...shots]);
  }

  src.remove();
}

/** Increment a chip's displayed count and flash highlight. */
function bumpChip(chip: HTMLElement): void {
  setChipCount(chip, Number(chip.dataset.count ?? "0") + 1);
  chip.classList.remove("tool-chip--highlight");
  void (chip as HTMLElement & { offsetWidth: number }).offsetWidth;
  chip.classList.add("tool-chip--highlight");
}

/**
 * Elements that fold into a chip bucket. Compact tool rows (.tool-row) AND
 * rich file-edit cards (.tool-use--file): the edit card keeps its inline diff
 * view, it just lives inside the Edit/Write chip's panel instead of loose in
 * the chat flow (so a turn that touched 8 files shows one "Edited x8" chip,
 * not 8 stacked diff cards).
 */
function isFoldableToolEl(el: HTMLElement): boolean {
  return el.classList.contains("tool-row") || el.classList.contains("tool-use--file");
}

/** Human label for a subagent chip: its Task description (or subagent_type), capped. */
function descOf(input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const d = typeof obj.description === "string" ? obj.description : "";
  const t = typeof obj.subagent_type === "string" ? obj.subagent_type : "";
  const label = (d || t || "Subagent").trim();
  return label.length > 60 ? label.slice(0, 60) + "…" : label;
}

/** Rebuild a custom bucket's content from the turn's message data (shared with
 *  the statusline popover via tool-views.ts). */
function rebuildCustomBucket(
  bucket: HTMLElement,
  key: string,
  messages: RenderedMessage[],
  start: number,
  end: number,
): void {
  bucket.innerHTML = renderCustomToolView(key, messages, start, end) ?? "";
}

// ---------------------------------------------------------------------------
// Nested-strip helpers (child tool calls under a parent Agent/Task chip)
// ---------------------------------------------------------------------------

/** Lazily creates/gets the nested strip pair inside an Agent chip's bucket.
 *  Uses the same .tool-strip/.tool-strip-panel shape as the main strip, so
 *  the existing delegated handleToolChipClick toggles it identically
 *  without any nested-specific click handling. */
function getOrCreateNestedStripInBucket(
  parentBucket: HTMLElement,
  nestedGroups: Map<string, ToolGroup>,
): { nestedStrip: HTMLElement; nestedPanel: HTMLElement } {
  // If we already created the nested strip (recovery or prior flush), reuse it.
  const existing = parentBucket.querySelector<HTMLElement>(":scope > .tool-strip");
  if (existing) {
    const panel = existing.nextElementSibling as HTMLElement | null;
    if (panel?.classList.contains("tool-strip-panel")) {
      // Repopulate nestedGroups from DOM if caller passed empty map.
      if (nestedGroups.size === 0) {
        for (const chip of existing.querySelectorAll<HTMLElement>(".tool-chip[data-tool]")) {
          const k = chip.dataset.tool!;
          if (nestedGroups.has(k)) continue;
          const bkt = panel.querySelector<HTMLElement>(`.tool-strip-group[data-tool="${k}"]`);
          if (bkt) nestedGroups.set(k, { chip, bucket: bkt, strip: existing, panel });
        }
      }
      return { nestedStrip: existing, nestedPanel: panel };
    }
  }
  // Create fresh nested strip/panel at the TOP of parentBucket so rows appended
  // later naturally follow it.
  const nestedStrip = document.createElement("div");
  nestedStrip.className = "tool-strip";
  const nestedPanel = document.createElement("div");
  nestedPanel.className = "tool-strip-panel";
  nestedPanel.hidden = true;
  parentBucket.prepend(nestedPanel);
  parentBucket.prepend(nestedStrip);
  return { nestedStrip, nestedPanel };
}

// ---------------------------------------------------------------------------
// Main grouping function
// ---------------------------------------------------------------------------

/** Folds a turn's compact tool rows into one chip strip per tool type;
 *  child tool_use rows nest under their parent Task/Agent chip's bucket
 *  instead of the main strip. Idempotent via `data-tool-grouped`, so the
 *  live render path can call this every flush to grow existing counts. */
export function groupToolRange(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  groups: Map<string, ToolGroup>,
  stripHost?: HTMLElement | null,
): void {
  if (end <= start) return;

  // ------------------------------------------------------------------
  // Pass 1: build id -> tool name map AND id -> parentToolUseId map so
  // tool_result rows land in the right bucket (main or nested).
  // ------------------------------------------------------------------
  const idTool = new Map<string, string>();
  const idParent = new Map<string, string>(); // tool_use id -> parentToolUseId (if child)
  const idDescription = new Map<string, string>(); // agent tool_use id -> subagent label
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (m.kind === "tool_use" && m.id && isFoldableToolEl(el)) {
      idTool.set(m.id, m.tool ?? "");
      if (m.parentToolUseId) idParent.set(m.id, m.parentToolUseId);
      if (m.tool === "Task" || m.tool === "Agent") idDescription.set(m.id, descOf(m.input));
    }
  }

  // Map from agent tool_use id -> the single main-strip Task/Agent ToolGroup
  // (the bucket that holds the per-subagent strip). Pre-populated from grouped
  // Task/Agent rows folded on a prior flush.
  const agentGroupById = new Map<string, ToolGroup>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el || el.dataset.toolGrouped !== "1") continue;
    if (m.kind === "tool_use" && m.id && (m.tool === "Task" || m.tool === "Agent")) {
      const grp = groups.get(canonicalTool(m.tool));
      if (grp) agentGroupById.set(m.id, grp);
    }
  }

  // Level-1 (per-subagent) chip groups, keyed by agent tool_use id. All
  // subagents share ONE level-1 strip inside the single Task/Agent bucket.
  // Repopulated lazily from the DOM by getOrCreateNestedStripInBucket on the
  // first child routed this flush.
  const subagentGroups = new Map<string, ToolGroup>();
  // Level-2 (per-tool-type) chip groups, keyed by agent id -> canonical tool.
  const toolGroupsBySub = new Map<string, Map<string, ToolGroup>>();

  // If groups already has entries, recover strip/panel from the first entry.
  let strip: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  if (groups.size > 0) {
    const first = groups.values().next().value!;
    strip = first.strip;
    panel = first.panel;
  }

  // Custom-view buckets touched this flush (bucket -> canonical key), rebuilt
  // from message data after the fold loop instead of holding raw rows.
  const customBuckets = new Map<HTMLElement, string>();

  // ------------------------------------------------------------------
  // Pass 2: fold each ungrouped row
  // ------------------------------------------------------------------
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (el.dataset.toolGrouped === "1") continue;
    // Compact rows AND rich file-edit cards fold; everything else stays inline.
    if (!isFoldableToolEl(el)) continue;

    let tool: string | null = null;
    let isUse = false;
    let parentId: string | null = null;

    if (m.kind === "tool_use") {
      tool = m.tool ?? "";
      isUse = true;
      parentId = m.parentToolUseId ?? null;
    } else if (m.kind === "tool_result") {
      const tid = m.tool_use_id ?? null;
      tool = (tid && idTool.get(tid)) ?? null;
      parentId = (tid && idParent.get(tid)) ?? null;
    }
    if (!tool) continue;

    // Screenshots (image tool_results) never stack as raw rows: they're
    // pulled out of the action log entirely and surfaced in the turn-level
    // screenshot-block/gallery instead (collectScreenshotShots, below),
    // regardless of whether the call was top-level or a subagent's child.
    // The tool_use action itself still folds normally, just below.
    if (m.kind === "tool_result" && m.output?.type === "image") {
      el.dataset.toolGrouped = "1";
      el.remove();
      continue;
    }

    const key = canonicalTool(tool);

    // ------------------------------------------------------------------
    // Ensure main strip exists (inside the turn footer when provided)
    // ------------------------------------------------------------------
    if (!strip) {
      const pair = makeStripPair(el, stripHost);
      strip = pair.strip;
      panel = pair.panel;
    }

    // ------------------------------------------------------------------
    // Route: child (parentId set AND parent agent is in range) vs. main
    // ------------------------------------------------------------------
    if (parentId) {
      // Look up the parent agent's main-strip ToolGroup.
      let agentGrp = agentGroupById.get(parentId);

      if (!agentGrp) {
        // Parent may not be folded yet (edge: parent appears later in range).
        // Try to resolve it from idTool; if it exists in range it will fold in
        // a later iteration and we'll update agentGroupById then. For now fall
        // back to main-strip treatment to avoid crashing.
        const parentTool = idTool.get(parentId);
        if (!parentTool) {
          // Parent outside range or unknown - fall through to main-strip.
          parentId = null;
        } else {
          // Parent is in range but not yet folded. Fold it into main strip now
          // so we can nest under it. Find the parent element.
          const parentMsgIdx = Array.from({ length: end - start }, (_, k) => start + k)
            .find(k => messages[k]?.kind === "tool_use" && messages[k]!.id === parentId);
          if (parentMsgIdx !== undefined) {
            const parentEl = messageEls[parentMsgIdx];
            if (parentEl && parentEl.dataset.toolGrouped !== "1" && parentEl.classList.contains("tool-row")) {
              const parentKey = canonicalTool(parentTool);
              let parentGrp = groups.get(parentKey);
              if (!parentGrp) {
                parentGrp = addGroupToStrip(parentKey, strip, panel!);
                groups.set(parentKey, parentGrp);
              }
              parentGrp.bucket.appendChild(parentEl);
              parentEl.dataset.toolGrouped = "1";
              // parent is a tool_use, bump its chip
              bumpChip(parentGrp.chip);
              agentGroupById.set(parentId, parentGrp);
              agentGrp = parentGrp;
            } else {
              // Parent already grouped or not a tool-row - use whatever group exists
              const parentKey = canonicalTool(parentTool);
              agentGrp = groups.get(parentKey) ?? null!;
              if (agentGrp) agentGroupById.set(parentId, agentGrp);
              else { parentId = null; } // give up, fold into main
            }
          } else {
            parentId = null; // parent not found in range
          }
        }
      }

      if (parentId && agentGrp) {
        // Level 1: per-subagent chip (labeled by description) inside the single
        // Task/Agent bucket. All subagents of the turn share this one strip.
        const { nestedStrip: subStrip, nestedPanel: subPanel } =
          getOrCreateNestedStripInBucket(agentGrp.bucket, subagentGroups);
        let subGrp = subagentGroups.get(parentId);
        if (!subGrp) {
          subGrp = addGroupToStrip(parentId, subStrip, subPanel, {
            label: idDescription.get(parentId) ?? "Subagent",
            icon: "ph-robot",
            agent: true,
          });
          subagentGroups.set(parentId, subGrp);
        }

        // Level 2: per-tool-type chip inside this subagent's bucket.
        let toolGroups = toolGroupsBySub.get(parentId);
        if (!toolGroups) {
          toolGroups = new Map();
          toolGroupsBySub.set(parentId, toolGroups);
        }
        const { nestedStrip: tStrip, nestedPanel: tPanel } =
          getOrCreateNestedStripInBucket(subGrp.bucket, toolGroups);
        let tGrp = toolGroups.get(key);
        if (!tGrp) {
          tGrp = addGroupToStrip(key, tStrip, tPanel);
          toolGroups.set(key, tGrp);
        }

        tGrp.bucket.appendChild(el);
        el.dataset.toolGrouped = "1";

        if (isUse) {
          bumpChip(tGrp.chip);   // tool-type count (Read x4)
          bumpChip(subGrp.chip); // subagent total-calls count
        }
        continue; // done with this child row
      }
      // Fallthrough: couldn't resolve parent -> fold into main strip below
    }

    // ------------------------------------------------------------------
    // Main-strip fold
    // ------------------------------------------------------------------
    let group = groups.get(key);
    if (!group) {
      group = addGroupToStrip(key, strip, panel!);
      groups.set(key, group);
    }

    // If this is an Agent/Task tool_use, register it so later children find it.
    if (isUse && (tool === "Task" || tool === "Agent") && m.kind === "tool_use" && m.id) {
      agentGroupById.set(m.id, group);
    }

    // Custom-view tools: don't stack raw rows in the bucket. Pull the row out
    // of the chat flow, count it on the chip, and flag the bucket for a rebuild
    // from message data below (one-row-per-file, skill list, Q&A pairs).
    if (CUSTOM_VIEW_TOOLS.has(key)) {
      group.bucket.dataset.customView = key;
      el.dataset.toolGrouped = "1";
      el.remove();
      if (isUse) bumpChip(group.chip);
      customBuckets.set(group.bucket, key);
      continue;
    }

    group.bucket.appendChild(el);
    el.dataset.toolGrouped = "1";

    if (isUse) {
      bumpChip(group.chip);
    }
  }

  // Rebuild every custom bucket touched this flush from the full turn range so
  // counts/answers stay correct as more calls stream in (idempotent: a full
  // innerHTML rewrite each time).
  for (const [bucket, key] of customBuckets) {
    rebuildCustomBucket(bucket, key, messages, start, end);
  }

  // ------------------------------------------------------------------
  // Screenshot blocks: any canonical key with image tool_results this turn
  // gets its always-visible thumbnail row (mounted/refreshed above the shared
  // strip). Computed fresh over the WHOLE [start, end) range, like the
  // custom-view buckets above, so it stays correct as more calls stream in.
  // `strip` is guaranteed non-null here whenever a screenshot exists (its
  // originating tool_use always folds - and thus creates the main strip -
  // before its tool_result can arrive).
  // ------------------------------------------------------------------
  if (stripHost) foldAuthoredIntoStrip(messages, messageEls, start, end, stripHost);

  if (stripHost && strip) {
    const shotsByKey = collectScreenshotShots(messages, start, end);
    for (const [shotKey, shots] of shotsByKey) {
      if (shots.length === 0) continue;
      let group = groups.get(shotKey);
      if (!group) {
        // Every call for this key was nested under a subagent, so no
        // top-level chip exists yet. Its bucket stays empty (that tool's raw
        // action log lives under the subagent's own chip) and its count is the
        // screenshot count, since no top-level tool_use ever bumps it.
        group = addGroupToStrip(shotKey, strip, panel!);
        groups.set(shotKey, group);
        group.chip.dataset.count = String(shots.length);
        const countEl = group.chip.querySelector(".tool-chip-count");
        if (countEl) countEl.textContent = `x${shots.length}`;
      }
      mountScreenshotBlock(stripHost, shotKey, shots);
    }
  }
}

/**
 * Rebuild the per-tool-type group map from a strip already present in the DOM
 * for this range. When a turn straddles a bulk-load flush boundary, its first
 * tool rows were grouped into a strip on the earlier flush; recovering that
 * strip here lets the close pass extend it instead of spawning a SECOND strip
 * for the same turn (the reload "chips split into rows" bug).
 *
 * Only recovers MAIN-strip groups (strips not inside a .tool-strip-group).
 * Nested strips inside Agent/Task buckets are recovered lazily by
 * getOrCreateNestedStripInBucket when groupToolRange processes children.
 */
function recoverGroupsFromDom(
  messageEls: HTMLElement[],
  start: number,
  end: number,
  stripHost?: HTMLElement | null,
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  // Chip-driven pass first: a custom-view tool deletes its rows, so the
  // row-driven pass below can't find its group and minted a second chip.
  const hostStrip = stripHost?.querySelector<HTMLElement>(":scope > .tool-strip");
  const hostPanel = hostStrip?.nextElementSibling;
  if (hostStrip && hostPanel instanceof HTMLElement && hostPanel.classList.contains("tool-strip-panel")) {
    for (const bucket of hostPanel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
      const key = bucket.dataset.tool;
      if (!key || groups.has(key)) continue;
      const chip = hostStrip.querySelector<HTMLElement>(`:scope > .tool-chip[data-tool="${key}"]`);
      if (chip) groups.set(key, { chip, bucket, strip: hostStrip, panel: hostPanel });
    }
  }
  for (let i = start; i < end; i++) {
    const el = messageEls[i];
    if (!el || el.dataset.toolGrouped !== "1") continue;
    const bucket = el.closest<HTMLElement>(".tool-strip-group");
    const panel = bucket?.closest<HTMLElement>(".tool-strip-panel") ?? null;
    const strip = (panel?.previousElementSibling as HTMLElement | null) ?? null;
    const key = bucket?.dataset.tool;
    if (!bucket || !panel || !strip || !strip.classList.contains("tool-strip") || !key) continue;
    // Skip nested strips (those whose .tool-strip is itself inside a .tool-strip-group).
    if (strip.closest(".tool-strip-group")) continue;
    if (groups.has(key)) continue;
    const chip = strip.querySelector<HTMLElement>(`.tool-chip[data-tool="${key}"]`);
    if (!chip) continue;
    groups.set(key, { chip, bucket, strip, panel });
  }
  return groups;
}

/**
 * Finalize a closed turn: fold any not-yet-grouped tool rows (covers bulk
 * replay where multiple turns close inside one render flush). Reuses an
 * existing strip for this turn (if a prior flush already started one) so a
 * chunk-straddling turn stays ONE strip.
 */
export function applyTurnCollapse(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  stripHost?: HTMLElement | null,
): void {
  if (end <= start) return;

  const recovered = recoverGroupsFromDom(messageEls, start, end, stripHost);
  groupToolRange(messages, messageEls, start, end, recovered, stripHost);
}
