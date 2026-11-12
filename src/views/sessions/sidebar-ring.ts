import type { PlanStepSnapshot } from "../../types/ipc.generated";

/** The ring on a sidebar avatar's edge. It replaced the old bottom-left status
 *  dot: the ring's shape says HOW FAR (plan arc, one segment per question) and
 *  its colour says WHICH STATE, so no second marker is needed. */
export type RingTone =
  | "working" | "question" | "done" | "waiting" | "rate-limited"
  | "external" | "attention" | "close-failed" | "closing"
  /** A sub that is not making progress (queued, paused, usage limit, stopped): a quiet full circle. */
  | "dim";

export type RingSpec =
  | { kind: "none" }
  /** One full circle. `pulse` = the needs-attention rhythm, `glow` = the slow
   *  soft breathing used for "working, no plan". */
  | { kind: "solid"; tone: RingTone; pulse?: boolean; glow?: boolean }
  /** Steps done of total, drawn as one arc over a dim track. */
  | { kind: "plan"; done: number; total: number }
  /** One segment per question: answered ones solid, the current one pulses,
   *  the rest dim. A single question is one full ring and pulses whole. */
  | { kind: "segments"; total: number; answered: number; tone?: RingTone };

export interface QuestionRingInfo { total: number; answered: number }

/** Steps that count as finished. A skipped step is settled, so it fills the
 *  arc like a done one rather than leaving it permanently short. */
export function planProgress(plan: readonly PlanStepSnapshot[] | null | undefined): { done: number; total: number } | null {
  if (!plan || plan.length === 0) return null;
  const done = plan.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total: plan.length };
}

/** Maps a row's `st-*` status class (the dot class the old dot used, so every
 *  existing state decision stays in `statusDotClass`) to what the ring draws.
 *  `st-your-turn` (done and already read) is the one state with no ring. */
export function ringSpecFor(
  dotClass: string,
  plan: readonly PlanStepSnapshot[] | null | undefined,
  question: QuestionRingInfo | null | undefined,
): RingSpec {
  switch (dotClass) {
    case "st-closing": return { kind: "solid", tone: "closing" };
    case "st-attention":
      // A question card waiting on permission still has N questions: a whole
      // pulsing ring means exactly one, so a multi-question card keeps its segments.
      if (question && question.total > 1) {
        return { kind: "segments", total: question.total, answered: Math.min(question.answered, question.total), tone: "attention" };
      }
      return { kind: "solid", tone: "attention", pulse: true };
    case "st-question":
      if (question && question.total > 0) {
        return { kind: "segments", total: question.total, answered: Math.min(question.answered, question.total) };
      }
      return { kind: "solid", tone: "question", pulse: true };
    case "st-working": {
      const p = planProgress(plan);
      return p ? { kind: "plan", done: p.done, total: p.total } : { kind: "solid", tone: "working", glow: true };
    }
    case "st-done": return { kind: "solid", tone: "done" };
    case "st-waiting": return { kind: "solid", tone: "waiting" };
    case "st-rate-limited": return { kind: "solid", tone: "rate-limited" };
    case "st-external": return { kind: "solid", tone: "external" };
    case "st-close-failed": return { kind: "solid", tone: "close-failed" };
    default: return { kind: "none" };
  }
}

/** The ring of a Use-subchats main chat: a plain working ring with no plan arc
 *  while the main agent works OR any sub has a turn running (`subsWorking`), so
 *  the row never reads idle while work is happening behind it. Once nothing runs
 *  the ring is the chat's own: green only while its finish is unread (`st-done`)
 *  and none once Joe has read it. It used to stay green for as long as every sub
 *  was finished, which is forever, and Joe's read of the chat never cleared it. A
 *  question or permission wait, a close and the error states draw as they do on
 *  any chat, so a parked card still reads `st-attention`. */
export function mainChatRingSpec(
  dotClass: string,
  question: QuestionRingInfo | null | undefined,
  subsWorking: boolean,
): RingSpec {
  if (dotClass === "st-working") return { kind: "solid", tone: "working", glow: true };
  // Idle or unread-done: a sub's running turn is the only thing the row has to say.
  if (subsWorking && (dotClass === "st-your-turn" || dotClass === "st-done")) return { kind: "solid", tone: "working", glow: true };
  return ringSpecFor(dotClass, null, question);
}

// viewBox is 50 units for the 50px avatar; r leaves half the 3.5 stroke inside.
const R = 23.25;
const CIRC = 2 * Math.PI * R;
/** Space between question segments, in circumference units. */
const SEGMENT_GAP = 4.5;

// Keep in step with the animation durations in sidebar-ring.css.
const PULSE_MS = 1400;
const GLOW_MS = 3200;

/** A sidebar rebuild replaces the SVG, which would restart its animation from
 *  0 and read as a sudden jump. A negative delay of (page clock mod period)
 *  starts every fresh element at the phase the old one had reached. */
function phaseStyle(cls: string): string {
  const period = cls.includes("is-pulse") ? PULSE_MS : cls.includes("is-glow") ? GLOW_MS : 0;
  if (!period) return "";
  return ` style="animation-delay:-${Math.round(performance.now() % period)}ms"`;
}

function circle(len: number, offset: number, cls: string, tone: RingTone): string {
  // The dash array draws `len` then leaves the rest of the circle empty;
  // the negative offset slides the drawn stretch to its start angle.
  return `<circle class="${cls}" data-tone="${tone}" cx="25" cy="25" r="${R}" stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"${phaseStyle(cls)}/>`;
}

/** Markup for the ring, or "" for `none`. Sits inside `.session-avatar-wrap`
 *  (see sidebar-ring.css for geometry and the keyframes). */
export function ringHtml(spec: RingSpec): string {
  if (spec.kind === "none") return "";
  let body = "";
  let tone: RingTone = "working";
  let cls = "avatar-ring";
  if (spec.kind === "solid") {
    tone = spec.tone;
    body = circle(CIRC, 0, `ring-seg${spec.pulse ? " is-pulse" : ""}${spec.glow ? " is-glow" : ""}`, tone);
  } else if (spec.kind === "plan") {
    tone = "working";
    cls += " is-plan";
    body = circle(CIRC, 0, "ring-seg is-track", tone);
    if (spec.done > 0) body += circle(CIRC * (spec.done / spec.total), 0, "ring-seg", tone);
  } else {
    tone = spec.tone ?? "question";
    cls += " is-segments";
    const gap = spec.total === 1 ? 0 : SEGMENT_GAP;
    const seg = CIRC / spec.total;
    for (let i = 0; i < spec.total; i++) {
      const state = i < spec.answered ? "" : i === spec.answered ? " is-pulse" : " is-track";
      body += circle(seg - gap, i * seg + gap / 2, `ring-seg${state}`, tone);
    }
  }
  return `<svg class="${cls}" viewBox="0 0 50 50" aria-hidden="true">${body}</svg>`;
}
