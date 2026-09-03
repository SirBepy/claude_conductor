// Subagent-nesting machinery, split off tool-strip.ts (ai_todo 847): routes a
// turn's child tool calls into their parent Task/Agent chip's own nested
// strip, distinct from main-strip folding and custom-view bucket routing.

import type { RenderedMessage } from "./chat-transforms";
import { canonicalTool } from "./tool-meta";
import { addGroupToStrip, bumpChip, type ToolGroup } from "./tool-strip";

/** Human label for a subagent chip: its Task description (or subagent_type), capped. */
export function descOf(input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const d = typeof obj.description === "string" ? obj.description : "";
  const t = typeof obj.subagent_type === "string" ? obj.subagent_type : "";
  const label = (d || t || "Subagent").trim();
  return label.length > 60 ? label.slice(0, 60) + "…" : label;
}

// ---------------------------------------------------------------------------
// Nested-strip helpers (child tool calls under a parent Agent/Task chip)
// ---------------------------------------------------------------------------

/** Lazily creates/gets the nested strip pair inside an Agent chip's bucket.
 *  Uses the same .tool-strip/.tool-strip-panel shape as the main strip, so
 *  the existing delegated handleToolChipClick toggles it identically
 *  without any nested-specific click handling. */
export function getOrCreateNestedStripInBucket(
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

/** Map from agent tool_use id -> the single main-strip Task/Agent ToolGroup
 *  (the bucket that holds the per-subagent strip). Pre-populated from grouped
 *  Task/Agent rows folded on a prior flush. */
export function buildAgentGroupById(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  groups: Map<string, ToolGroup>,
): Map<string, ToolGroup> {
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
  return agentGroupById;
}

/** Routes a child tool_use/tool_result into its parent subagent's nested
 *  strip (level-1 per-subagent, level-2 per-tool-type chips). Returns false
 *  when no parent could be resolved, telling the caller to fold it into the
 *  main strip instead. */
export function routeIntoSubagent(
  el: HTMLElement,
  key: string,
  isUse: boolean,
  parentId: string,
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  strip: HTMLElement,
  panel: HTMLElement,
  groups: Map<string, ToolGroup>,
  agentGroupById: Map<string, ToolGroup>,
  idTool: Map<string, string>,
  idDescription: Map<string, string>,
  subagentGroups: Map<string, ToolGroup>,
  toolGroupsBySub: Map<string, Map<string, ToolGroup>>,
): boolean {
  // Look up the parent agent's main-strip ToolGroup.
  let agentGrp = agentGroupById.get(parentId);

  if (!agentGrp) {
    // Parent may not be folded yet (edge: parent appears later in range).
    // Try to resolve it from idTool; if it exists in range it will fold in
    // a later iteration and we'll update agentGroupById then. For now fall
    // back to main-strip treatment to avoid crashing.
    const parentTool = idTool.get(parentId);
    if (!parentTool) return false; // Parent outside range or unknown.

    // Parent is in range but not yet folded. Fold it into main strip now
    // so we can nest under it. Find the parent element.
    const parentMsgIdx = Array.from({ length: end - start }, (_, k) => start + k)
      .find(k => messages[k]?.kind === "tool_use" && messages[k]!.id === parentId);
    if (parentMsgIdx === undefined) return false; // parent not found in range

    const parentEl = messageEls[parentMsgIdx];
    if (parentEl && parentEl.dataset.toolGrouped !== "1" && parentEl.classList.contains("tool-row")) {
      const parentKey = canonicalTool(parentTool);
      let parentGrp = groups.get(parentKey);
      if (!parentGrp) {
        parentGrp = addGroupToStrip(parentKey, strip, panel);
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
      agentGrp = groups.get(parentKey);
      if (agentGrp) agentGroupById.set(parentId, agentGrp);
      else return false; // give up, fold into main
    }
  }

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
  return true;
}
