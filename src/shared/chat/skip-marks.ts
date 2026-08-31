/** One durable "the user dismissed this card" mark from `companion.db`.
 *  `questionId` is null on pre-v4 rows, which recorded only a timestamp. */
export interface SkipMark {
  timestamp: number;
  questionId: string | null;
}

/** Normalize whatever `get_skipped_question_marks` returned into `SkipMark`s.
 *  A daemon older than schema v4 answers with a bare `number[]`, and the two
 *  transports can disagree on which build is live (see HttpTransport), so both
 *  shapes have to survive the same parse rather than one being assumed. */
export function normalizeSkipMarks(raw: unknown): SkipMark[] {
  if (!Array.isArray(raw)) return [];
  const out: SkipMark[] = [];
  for (const item of raw) {
    if (typeof item === "number") {
      if (Number.isFinite(item)) out.push({ timestamp: item, questionId: null });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as { timestamp?: unknown; question_id?: unknown; questionId?: unknown };
    const ts = Number(rec.timestamp);
    if (!Number.isFinite(ts)) continue;
    const id = rec.question_id ?? rec.questionId;
    out.push({ timestamp: ts, questionId: typeof id === "string" && id ? id : null });
  }
  return out;
}
