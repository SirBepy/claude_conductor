// Line-chart building for the session/weekly usage widgets: SVG construction,
// the "worked on" project list under a chart, legend toggles, pagination
// button wiring, and hover tooltips. Split out of usage-charts.ts, see
// .for_bepy/ai_todos/177-split-usage-charts-widget-file.md.

import { getTokenHistory } from "../../../shared/state";
import type { TokenRecord } from "../../../shared/tokens";
import { totalTok } from "../../../shared/tokens";
import { hourToMs } from "../../../shared/time";
import { buildProjectListHTML, isBlackRef, type ListProject } from "./project-list";
import type { UsageRecord } from "../../../shared/api";
import { stepPageOffset } from "./usage-charts";

// ── Module-local chart state (line visibility) ─────────────────────────────
// Shared across accounts (mirrors the pre-milestone single-account behaviour;
// switching accounts does not reset line-visibility toggles).

const lineVisible: Record<"session" | "weekly" | "expected", boolean> = {
  session: true,
  weekly: true,
  expected: true,
};

type Wired = Element & { _legWired?: boolean; _pageWired?: boolean; _hoverWired?: boolean };
function wired(el: Element): Wired { return el as Wired; }

// ── Window projects list (used inside chart cards) ──────────────────────────

export function buildWindowProjectsHTML(
  startMs: number, endMs: number,
  usageHistory: UsageRecord[] | undefined,
  pctKey: "s" | "w" = "s",
  maxItems: number | null = 5,
  listId: string | null = null,
): string {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) return "";

  const byProject = new Map<string, ListProject>();
  for (const r of tokenHistory) {
    const endTs = r.lastActiveAt || "";
    const startTs = (r as TokenRecord & { startedAt?: string }).startedAt || "";
    if (!endTs) continue;
    const sessionEndMs = new Date(endTs).getTime();
    if (isNaN(sessionEndMs)) continue;
    if (startTs) {
      const sessionStartMs = new Date(startTs).getTime();
      if (isNaN(sessionStartMs)) continue;
      if (sessionStartMs >= endMs || sessionEndMs <= startMs) continue;
    } else {
      if (sessionEndMs < startMs || sessionEndMs > endMs) continue;
    }
    const key = r.cwd || "(unknown)";
    if (isBlackRef(key)) continue;
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0, lastActiveAt: "" };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
    if (endTs > (p.lastActiveAt || "")) p.lastActiveAt = endTs;
  }

  const projects = Array.from(byProject.values());
  let hasPct = false;
  if (usageHistory && usageHistory.length && projects.length) {
    const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
    const windowPts = usageHistory
      .filter((r) => (r as Record<string, unknown>)[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: (r as Record<string, number>)[pctField] as number }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);

    if (windowPts.length >= 2) {
      const first = windowPts[0]!;
      const last = windowPts[windowPts.length - 1]!;
      const delta = last.pct - first.pct;
      if (delta > 0) {
        const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
        if (totalTokens > 0) {
          hasPct = true;
          for (const p of projects) {
            p.sessionPct = Math.round((p.tokens / totalTokens) * delta);
          }
        }
      }
    }
  }

  return buildProjectListHTML({
    title: "Worked on",
    projects,
    maxItems,
    showTime: false,
    showPct: hasPct,
    sortable: true,
    defaultSort: hasPct ? "sessionPct" : "tokens",
    id: listId || `window-${startMs}`,
    style: "margin-top:2px;margin-bottom:8px",
  });
}

// ── Chart SVG ─────────────────────────────────────────────────────────────

export function buildChart(
  history: UsageRecord[],
  startMs: number, endMs: number,
  lineKey: "s" | "w",
  svgId: string,
): string {
  const W = 420, H = 172;
  const ML = 30, MR = 8, MT = 8, MB = 42;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const minT = startMs;
  const maxT = endMs;
  const tRange = maxT - minT || 1;
  const px = (t: number): number => ML + ((t - minT) / tRange) * PW;
  const py = (v: number): number => MT + (1 - v / 100) * PH;

  const gridLines = [0, 25, 50, 75, 100].map((v) => {
    const y = py(v);
    return `<line x1="${ML}" x2="${W - MR}" y1="${y}" y2="${y}" stroke="#2d2c44" stroke-width="1"/>
            <text x="${ML - 4}" y="${y + 3.5}" text-anchor="end" fill="#6b6990" font-size="11" font-family="Fira Code, monospace">${v}</text>`;
  }).join("");

  const tickItems: string[] = [];
  const windowMs = maxT - minT;
  if (windowMs <= 12 * 3_600_000) {
    const hourMs = 3_600_000;
    const firstTick = Math.ceil(minT / hourMs) * hourMs;
    for (let t = firstTick; t <= maxT; t += hourMs) {
      const x = px(t).toFixed(1);
      const d = new Date(t);
      const hh = d.getHours().toString().padStart(2, "0");
      const mm = d.getMinutes().toString().padStart(2, "0");
      tickItems.push(
        `<line x1="${x}" x2="${x}" y1="${MT + PH}" y2="${MT + PH + 4}" stroke="#2d2c44" stroke-width="1"/>` +
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="11" font-family="DM Sans, system-ui">${hh}:${mm}</text>`,
      );
    }
  } else {
    const cursor = new Date(minT);
    cursor.setHours(24, 0, 0, 0);
    while (cursor.getTime() <= maxT) {
      const x = px(cursor.getTime()).toFixed(1);
      const dayName = cursor.toLocaleDateString("en-US", { weekday: "short" });
      const dateStr = (cursor.getMonth() + 1) + "/" + cursor.getDate();
      tickItems.push(
        `<line x1="${x}" x2="${x}" y1="${MT + PH}" y2="${MT + PH + 4}" stroke="#2d2c44" stroke-width="1"/>` +
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="11" font-family="DM Sans, system-ui">${dayName}</text>` +
        `<text x="${x}" y="${H - MB + 26}" text-anchor="middle" fill="#4a4870" font-size="11" font-family="DM Sans, system-ui">${dateStr}</text>`,
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const refLine =
    `<line data-line="expected"` +
    ` x1="${px(minT).toFixed(1)}" y1="${py(0).toFixed(1)}"` +
    ` x2="${px(maxT).toFixed(1)}" y2="${py(100).toFixed(1)}"` +
    ` stroke="#6b6990" stroke-width="1.5" stroke-dasharray="5,4"/>`;

  interface Pt { t: number; s: number | null; w: number | null; }
  const pts: Pt[] = history
    .map((r) => ({ t: hourToMs(r.hour), s: r.session_pct, w: r.weekly_pct }))
    .filter((p) => p.t >= minT && p.t <= maxT);

  if (pts.length && pts[0]!.t > minT) {
    pts.unshift({ t: minT, s: 0, w: 0 });
  }

  const lineColor = lineKey === "s" ? "#9d7dfc" : "#6e8fff";
  const lineName = lineKey === "s" ? "session" : "weekly";

  const makeLine = (key: "s" | "w", color: string, name: string): string => {
    const f = pts.filter((p) => p[key] !== null && p[key] !== undefined) as Array<Pt & { s: number; w: number }>;
    if (f.length === 0) return `<g data-line="${name}"></g>`;
    if (f.length === 1) {
      const first = f[0]!;
      return `<circle data-line="${name}" cx="${px(first.t).toFixed(1)}" cy="${py(first[key]).toFixed(1)}" r="2.5" fill="${color}"/>`;
    }
    const cPts = f.map((p) => ({ x: px(p.t), y: py(p[key]) }));
    let d = `M${cPts[0]!.x.toFixed(1)},${cPts[0]!.y.toFixed(1)}`;
    for (let i = 0; i < cPts.length - 1; i++) {
      const p0 = cPts[Math.max(0, i - 1)]!;
      const p1 = cPts[i]!;
      const p2 = cPts[i + 1]!;
      const p3 = cPts[Math.min(cPts.length - 1, i + 2)]!;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return `<path data-line="${name}" d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  };

  const hoverPts = pts
    .filter((p) => p[lineKey] !== null && p[lineKey] !== undefined)
    .map((p) => `${p.t}:${p[lineKey]}`)
    .join(";");
  const windowType = windowMs <= 12 * 3_600_000 ? "session" : "weekly";

  const hoverGroup =
    `<g id="${svgId}-hover" style="pointer-events:none;display:none">` +
    `<line id="${svgId}-hline" x1="0" x2="0" y1="${MT}" y2="${MT + PH}" stroke="#4a4870" stroke-width="1" stroke-dasharray="3,2"/>` +
    `<circle id="${svgId}-hdot" cx="0" cy="0" r="3.5" fill="${lineColor}" stroke="#1e1d30" stroke-width="1.5"/>` +
    `<rect id="${svgId}-hbox" rx="5" ry="5" fill="#1a1928" stroke="#2d2c44" stroke-width="1"/>` +
    `<text id="${svgId}-hlabel" fill="#8885aa" font-size="10" font-family="DM Sans, system-ui"></text>` +
    `<text id="${svgId}-hval" fill="${lineColor}" font-size="12" font-family="Fira Code, monospace" font-weight="600"></text>` +
    `</g>` +
    `<rect id="${svgId}-overlay" x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="transparent" style="cursor:crosshair"/>`;

  return (
    `<svg id="${svgId}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible"` +
    ` data-hover-pts="${hoverPts}" data-min-t="${minT}" data-max-t="${maxT}" data-window-type="${windowType}" data-line-color="${lineColor}">` +
    gridLines +
    `<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>` +
    tickItems.join("") +
    refLine +
    makeLine(lineKey, lineColor, lineName) +
    hoverGroup +
    `</svg>`
  );
}

// ── Line visibility + legend toggles + pagination ─────────────────────────

export function applyLineVisibility(root: ParentNode): void {
  for (const key of ["session", "weekly", "expected"] as const) {
    root.querySelectorAll<HTMLElement>(`[data-line="${key}"]`).forEach((el) => {
      el.style.display = lineVisible[key] ? "" : "none";
    });
    root.querySelectorAll<HTMLElement>(`[data-legend="${key}"]`).forEach((leg) => {
      leg.style.opacity = lineVisible[key] ? "1" : "0.35";
    });
  }
}

export function setupLegendToggles(root: ParentNode, onToggle: () => void): void {
  root.querySelectorAll<HTMLElement>("[data-legend]").forEach((el) => {
    const w = wired(el);
    if (w._legWired) return;
    w._legWired = true;
    el.onclick = () => {
      const key = el.dataset["legend"] as keyof typeof lineVisible | undefined;
      if (!key) return;
      lineVisible[key] = !lineVisible[key];
      applyLineVisibility(root);
      onToggle();
    };
  });
}

export function setupPaginationButtons(root: ParentNode, onPage: () => void): void {
  root.querySelectorAll<HTMLElement>("[data-page-nav]").forEach((btn) => {
    const w = wired(btn);
    if (w._pageWired) return;
    w._pageWired = true;
    const graph = btn.dataset["pageGraph"];
    const dir = btn.dataset["pageNav"];
    btn.onclick = () => {
      if (graph === "session" || graph === "weekly") {
        stepPageOffset(graph, dir === "prev" ? "prev" : "next");
      }
      onPage();
    };
  });
}

// ── Chart hover tooltips ──────────────────────────────────────────────────

function formatHoverLabel(t: number, windowType: string): string {
  const d = new Date(t);
  if (windowType === "session") {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const m = d.getMonth() + 1;
  const dy = d.getDate();
  return `${day} ${m}/${dy}`;
}

export function setupChartHover(root: ParentNode): void {
  const W = 420, H = 172;
  const ML = 30, MR = 8, MT = 8, MB = 42;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  root.querySelectorAll<SVGElement>("svg[data-hover-pts]").forEach((svg) => {
    const w = wired(svg as unknown as Element);
    if (w._hoverWired) return;
    w._hoverWired = true;

    const svgId = svg.id;
    const overlay = document.getElementById(`${svgId}-overlay`);
    if (!overlay) return;

    const ptsRaw = svg.dataset["hoverPts"] || "";
    const minT = parseInt(svg.dataset["minT"] || "0");
    const maxT = parseInt(svg.dataset["maxT"] || "1");
    const windowType = svg.dataset["windowType"] || "session";
    const color = svg.dataset["lineColor"] || "#9d7dfc";
    const tRange = maxT - minT || 1;

    const hoverPts: Array<{ t: number; v: number }> = ptsRaw
      ? ptsRaw.split(";").map((s) => {
          const [ts, vs] = s.split(":");
          return { t: parseInt(ts!), v: parseFloat(vs!) };
        }).filter((p) => !isNaN(p.t) && !isNaN(p.v))
      : [];

    const hoverGroup = document.getElementById(`${svgId}-hover`);
    const hline = document.getElementById(`${svgId}-hline`);
    const hdot = document.getElementById(`${svgId}-hdot`);
    const hbox = document.getElementById(`${svgId}-hbox`);
    const hlabel = document.getElementById(`${svgId}-hlabel`);
    const hval = document.getElementById(`${svgId}-hval`);
    if (!hoverGroup || !hline || !hdot || !hbox || !hlabel || !hval) return;

    overlay.addEventListener("mousemove", (e: Event) => {
      const me = e as MouseEvent;
      const rect = svg.getBoundingClientRect();
      const svgX = (me.clientX - rect.left) * (W / rect.width);
      const t = minT + ((svgX - ML) / PW) * tRange;

      let v = 0;
      if (hoverPts.length === 0) return;
      if (hoverPts.length === 1) {
        v = hoverPts[0]!.v;
      } else {
        let lo = hoverPts[0]!, hi = hoverPts[hoverPts.length - 1]!;
        for (let i = 0; i < hoverPts.length - 1; i++) {
          if (hoverPts[i]!.t <= t && hoverPts[i + 1]!.t >= t) {
            lo = hoverPts[i]!;
            hi = hoverPts[i + 1]!;
            break;
          }
        }
        const frac = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t);
        v = lo.v + frac * (hi.v - lo.v);
      }
      v = Math.max(0, Math.min(100, v));

      const cx = ML + ((t - minT) / tRange) * PW;
      const cy = MT + (1 - v / 100) * PH;

      hline.setAttribute("x1", cx.toFixed(1));
      hline.setAttribute("x2", cx.toFixed(1));
      hdot.setAttribute("cx", cx.toFixed(1));
      hdot.setAttribute("cy", cy.toFixed(1));
      hdot.setAttribute("fill", color);

      const label = formatHoverLabel(t, windowType);
      const valText = `${Math.round(v)}%`;
      hlabel.textContent = label;
      hval.textContent = valText;

      const tipW = Math.max(label.length * 6.2, valText.length * 7.8) + 18;
      const tipH = 34;
      let tipX = cx + 10;
      if (tipX + tipW > W - MR) tipX = cx - tipW - 10;
      let tipY = cy - tipH - 6;
      if (tipY < MT) tipY = cy + 8;

      hbox.setAttribute("x", tipX.toFixed(1));
      hbox.setAttribute("y", tipY.toFixed(1));
      hbox.setAttribute("width", tipW.toFixed(1));
      hbox.setAttribute("height", tipH.toFixed(1));
      const midX = (tipX + tipW / 2).toFixed(1);
      hlabel.setAttribute("x", midX);
      hlabel.setAttribute("y", (tipY + 13).toFixed(1));
      hlabel.setAttribute("text-anchor", "middle");
      hval.setAttribute("x", midX);
      hval.setAttribute("y", (tipY + 27).toFixed(1));
      hval.setAttribute("text-anchor", "middle");

      hoverGroup.style.display = "";
    });

    overlay.addEventListener("mouseleave", () => {
      hoverGroup.style.display = "none";
    });
  });
}
