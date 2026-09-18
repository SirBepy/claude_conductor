import "./running-instances.css";
import { formatTokens } from "../../../../shared/tokens";
import { escapeHtml } from "../../../../shared/escape-html";
import { uptimeFrom } from "../../../../shared/time";
import { getProjectDetailState } from "../../../../shared/state";
import type { ProjectConfig } from "../../../../shared/state";
import { openSessionDetail } from "../../../../shared/navigation";
import { api } from "../../../../shared/api";

interface Instance {
  session_id: string;
  pid: number;
  started_at: string;
  cwd: string;
  end_reason?: string | null;
  is_remote?: boolean;
  kind?: string;
  name?: string | null;
  model?: string;
  effort?: string;
}

interface InstanceStats {
  tokens?: number;
  turns?: number;
  prompts?: number;
}

function instanceRowHtml(i: Instance, stats: InstanceStats | undefined): string {
  const uptime = uptimeFrom(i.started_at);
  const tokens = stats?.tokens ?? 0;
  const turns = stats?.turns ?? 0;
  const prompts = stats?.prompts ?? 0;
  const fallback = `Chat ${i.session_id.slice(0, 8)}`;
  const label = (i.name && i.name.trim()) || fallback;
  const modelEffort = [i.model, i.effort].filter((v) => v && v.trim()).join(" ");
  const meTag = modelEffort ? ` · ${escapeHtml(modelEffort)}` : "";
  return `
    <div class="instance-row clickable v-row v-focusable" data-session-id="${i.session_id}" role="button" tabindex="0">
      <div class="status-dot"></div>
      <div class="instance-row-text">
        <div class="instance-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="row-line">up ${uptime} · ${prompts} ${prompts === 1 ? "msg" : "msgs"} · ${formatTokens(tokens)} tokens · ${turns} ${turns === 1 ? "turn" : "turns"}${meTag}</div>
      </div>
      <i class="ph ph-caret-right chev"></i>
    </div>
  `;
}

function setRunningInstancesEmpty(count: number): void {
  const c = document.getElementById("runningInstancesCount");
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (c) c.textContent = String(count);
  if (listEl) listEl.style.display = "none";
  // .v-empty (motion.css) lays itself out as flex, not block.
  if (emptyEl) emptyEl.style.display = "flex";
}

export async function renderRunningInstances(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  if (!cwd) return;
  const projects = (await api.listProjects()) as unknown as ProjectConfig[];
  const proj = projects.find((p) => p.path === cwd);
  if (!proj) {
    setRunningInstancesEmpty(0);
    return;
  }
  const instances = ((await api.listInstancesForProject(proj.id)) as unknown as Instance[])
    .filter((i) => !i.end_reason);
  const count = instances.length;

  const countEl = document.getElementById("runningInstancesCount");
  if (countEl) countEl.textContent = String(count);
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (!listEl || !emptyEl) return;
  if (count === 0) {
    listEl.style.display = "none";
    emptyEl.style.display = "flex";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "block";

  const stats = await Promise.all(
    instances.map((i) => api.instanceTokenStats(i.session_id) as unknown as Promise<InstanceStats>),
  );
  listEl.innerHTML = instances.map((i, idx) => instanceRowHtml(i, stats[idx])).join("");
  listEl.querySelectorAll<HTMLElement>(".instance-row").forEach((row) => {
    const sid = row.dataset.sessionId;
    const inst = instances.find((x) => x.session_id === sid);
    if (!inst) return;
    const open = () => {
      openSessionDetail(inst, "project-detail");
    };
    row.onclick = open;
    row.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
  });
}
