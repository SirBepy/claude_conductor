// The tables and charts a send_message / update_message call carries in `visuals`.
// Like `details` and `kind`, the daemon only validates them (hooks_server/visuals.rs);
// the chat reads them straight off the tool_use input in the transcript, so live,
// reload, older pages and the phone all see them. Kept free of renderer imports so
// the event mappers can use it without a cycle through chat-transforms.
//
// Parsing is lenient where the daemon is strict: a malformed visual is dropped
// rather than failing the card, since the rest of the card still reads.

import { asObj } from "../obj-utils";

export interface TableVisual { type: "table"; title?: string; columns: string[]; rows: (string | number | null)[][] }
export interface BarVisual { type: "bar"; title?: string; unit?: string; data: { label: string; value: number }[] }
export interface LineVisual { type: "line"; title?: string; labels: string[]; series: { name: string; values: number[] }[] }
export interface DonutVisual { type: "donut"; title?: string; data: { label: string; value: number }[] }
interface TimelineBlock { start: number; end: number; label?: string }
export interface TimelineVisual { type: "timeline"; title?: string; rows: { label: string; blocks: TimelineBlock[] }[] }
export type Visual = TableVisual | BarVisual | LineVisual | DonutVisual | TimelineVisual;

const MAX_VISUALS = 3;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "HH:MM" to minutes since midnight; `24:00` is allowed as an end. */
export function parseClock(v: unknown): number | undefined {
  const m = typeof v === "string" ? /^(\d{2}):(\d{2})$/.exec(v) : null;
  if (!m) return undefined;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && mins <= 24 * 60 ? mins : undefined;
}

function labelled(raw: unknown, positive: boolean): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  for (const d of arr(raw)) {
    const { label, value } = asObj(d);
    const v = num(value);
    if (str(label) !== undefined && v !== undefined && v >= 0 && !(positive && v === 0)) out.push({ label: label as string, value: v });
  }
  return out;
}

function parseOne(raw: unknown): Visual | undefined {
  const o = asObj(raw);
  const title = str(o.title);
  switch (o.type) {
    case "table": {
      const columns = arr(o.columns).map(str);
      if (columns.length === 0 || columns.some((c) => c === undefined)) return undefined;
      const rows = arr(o.rows)
        .map((r) => arr(r))
        .filter((r) => r.length === columns.length)
        .map((r) => r.map((c) => (typeof c === "string" || typeof c === "number" ? c : null)));
      return rows.length > 0 ? { type: "table", title, columns: columns as string[], rows } : undefined;
    }
    case "bar": {
      const data = labelled(o.data, false);
      return data.length > 0 ? { type: "bar", title, unit: str(o.unit), data } : undefined;
    }
    case "donut": {
      const data = labelled(o.data, true);
      return data.length >= 2 ? { type: "donut", title, data } : undefined;
    }
    case "line": {
      const labels = arr(o.labels).map(str);
      if (labels.length < 2 || labels.some((l) => l === undefined)) return undefined;
      const series: { name: string; values: number[] }[] = [];
      for (const s of arr(o.series)) {
        const { name, values } = asObj(s);
        const vs = arr(values).map(num);
        if (str(name) !== undefined && vs.length === labels.length && vs.every((v) => v !== undefined)) series.push({ name: name as string, values: vs as number[] });
      }
      return series.length > 0 ? { type: "line", title, labels: labels as string[], series } : undefined;
    }
    case "timeline": {
      const rows: TimelineVisual["rows"] = [];
      for (const r of arr(o.rows)) {
        const { label, blocks } = asObj(r);
        const bs: TimelineBlock[] = [];
        for (const b of arr(blocks)) {
          const { start, end, label: bl } = asObj(b);
          const s = parseClock(start);
          const e = parseClock(end);
          if (s !== undefined && e !== undefined && e > s) bs.push({ start: s, end: e, label: str(bl) });
        }
        if (str(label) !== undefined && bs.length > 0) rows.push({ label: label as string, blocks: bs });
      }
      return rows.length > 0 ? { type: "timeline", title, rows } : undefined;
    }
    default:
      return undefined;
  }
}

/** Reads `visuals` off a tool_use input. Absent key is `undefined`; an explicit
 *  list with nothing valid is `[]`, which update_message uses to clear earlier ones. */
export function parseVisuals(input: unknown): Visual[] | undefined {
  const raw = asObj(input).visuals;
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_VISUALS).map(parseOne).filter((v): v is Visual => v !== undefined);
}
