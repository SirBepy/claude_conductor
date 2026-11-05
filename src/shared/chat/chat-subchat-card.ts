// Draws a sub's card in its main chat (subchat-cards.ts) with the real message
// card, tagged with the sub's name, and the fact chips under it. The chips are
// built by code from git and the sub's transcript, so anything the daemon could
// not read shows as unknown instead of a confident number. They are also the
// chips a final-stamp question card carries (permission-modal/question-ui-templates.ts).

import { escapeHtml } from "../escape-html";
import { tierLabel } from "../model-name";
import { renderMessageCard, type CardExtras, type RenderText } from "./chat-message-card";
import type { RenderedMessage } from "./chat-classifiers";
import type { SubCardEntry, SubFacts, SubSumFacts } from "./subchat-cards";

type ChipTone = "done" | "not" | "wait";

interface Chip {
  tone: ChipTone;
  icon: string;
  /** What prints beside the icon: a number or one short word. */
  value: string;
  /** The chip's name on hover and for a screen reader. */
  title: string;
}

const chipHtml = (c: Chip) =>
  `<span class="mc-chip mc-chip--${c.tone}" role="img" title="${escapeHtml(c.title)}" aria-label="${escapeHtml(c.title)}"><i class="ph ${c.icon}" aria-hidden="true"></i>${escapeHtml(c.value)}</span>`;

const caret = `<i class="ph ph-caret-down mc-caret" aria-hidden="true"></i>`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const UNKNOWN = "?";

/** ", <why>" when the daemon said why a figure is unknown, else nothing. */
const why = (note?: string | null) => (note ? `, ${note}` : "");

/** What a count is measured from, in the chip's own words. */
function sinceWords(f: SubFacts): string {
  return f.since === "last report" ? "its last report" : "it started";
}

function testChip(f: SubFacts): Chip {
  const t = f.test;
  if (t?.state === "passed") return { tone: t.stale ? "wait" : "done", icon: "ph-test-tube", value: t.stale ? "passed, old" : "passed", title: t.stale ? "Last test run passed, before the last edit" : "Last test run passed" };
  if (t?.state === "failed") return { tone: "not", icon: "ph-test-tube", value: "failed", title: "Last test run failed" };
  if (t?.command) return { tone: "wait", icon: "ph-test-tube", value: "unknown", title: "Last test run: result unknown, its output showed no pass or fail line" };
  return { tone: "wait", icon: "ph-test-tube", value: "unknown", title: "No test run found: unknown" };
}

function reviewerChip(f: SubFacts): Chip {
  if (f.reviewer?.state === "ran") return { tone: "done", icon: "ph-eye", value: "ran", title: "A fresh reviewer ran after the last edit" };
  if (f.reviewer?.state === "none") return { tone: "wait", icon: "ph-eye-slash", value: "no reviewer", title: "No reviewer" };
  return { tone: "wait", icon: "ph-eye", value: "unknown", title: "Reviewer: unknown" };
}

function factChips(f: SubFacts): Chip[] {
  const commits = f.commits ?? null;
  const files = f.files_changed ?? null;
  const dirty = f.uncommitted ?? null;
  const chips: Chip[] = [
    { tone: commits === null ? "wait" : commits > 0 ? "done" : "wait", icon: "ph-git-commit", value: commits === null ? UNKNOWN : String(commits), title: commits === null ? `Commits: unknown${why(f.commits_note)}` : plural(commits, "commit") },
    { tone: files === null ? "wait" : files > 0 ? "done" : "wait", icon: "ph-file", value: files === null ? UNKNOWN : String(files), title: files === null ? `Files changed: unknown${why(f.commits_note)}` : `${plural(files, "file")} changed` },
    { tone: dirty === null ? "wait" : dirty === 0 ? "done" : "not", icon: "ph-warning", value: dirty === null ? UNKNOWN : String(dirty), title: dirty === null ? `Uncommitted files: unknown${why(f.uncommitted_note)}` : `${dirty} of its own ${dirty === 1 ? "file" : "files"} uncommitted` },
    testChip(f),
    reviewerChip(f),
  ];
  const into = f.merged_into ?? "its target";
  if (f.merged === true) chips.push({ tone: "done", icon: "ph-git-merge", value: "merged", title: `Merged into ${into}` });
  else if (f.merged === false) chips.push({ tone: "not", icon: "ph-git-merge", value: "not merged", title: `Not merged into ${into}` });
  if (f.pushed === false) chips.push({ tone: "wait", icon: "ph-cloud-slash", value: "not pushed", title: "Not pushed" });
  else if (f.pushed === true) chips.push({ tone: "done", icon: "ph-cloud-check", value: "pushed", title: "Pushed" });
  return chips;
}

const li = (html: string) => `<li>${html}</li>`;
const code = (t: string) => `<code>${escapeHtml(t)}</code>`;

function factWords(f: SubFacts): string[] {
  const out: string[] = [];
  const commits = f.commits ?? null;
  if (commits === null) out.push(`Commits: unknown${f.commits_note ? `, ${escapeHtml(f.commits_note)}` : ", the daemon could not read git for this job"}`);
  else {
    const scope = f.scoped ? ", counting only commits that touch files it edited" : "";
    out.push(`${plural(commits, "commit")} since ${sinceWords(f)}${scope}`);
  }
  const files = f.files_changed ?? null;
  if (files !== null) out.push(`${plural(files, "file")} changed (+${f.insertions ?? 0} -${f.deletions ?? 0})`);
  const dirty = f.uncommitted ?? null;
  if (dirty === null) out.push(`Uncommitted files: unknown${why(f.uncommitted_note ? escapeHtml(f.uncommitted_note) : null)}`);
  else if (dirty === 0) out.push("Nothing uncommitted in the files it edited");
  else out.push(`${dirty} of its own ${dirty === 1 ? "file is" : "files are"} uncommitted: ${escapeHtml((f.uncommitted_files ?? []).join(", "))}`);
  const t = f.test;
  if (t?.state === "passed" || t?.state === "failed") {
    const how = `${t.state}${t.summary ? `: ${escapeHtml(t.summary)}` : ""}`;
    out.push(`Last test run ${t.command ? code(t.command) + " " : ""}${how}${t.stale ? ", but it ran before the last edit" : ""}`);
  } else if (t?.command) {
    out.push(`Last test run ${code(t.command)}: result unknown, its output showed no pass or fail line${t.summary ? ` (${escapeHtml(t.summary)})` : ""}`);
  } else {
    out.push("Last test run: unknown, no test command found in its transcript");
  }
  const r = f.reviewer;
  if (r?.state === "ran") out.push(`Fresh reviewer, after the last edit: ${escapeHtml(r.text ?? "")}`);
  else if (r?.state === "none") out.push(`No reviewer${r.note ? ` (${escapeHtml(r.note)})` : ""}`);
  else out.push("Reviewer: unknown");
  const into = escapeHtml(f.merged_into ?? "its target branch");
  if (f.merged === true) out.push(`Merged into ${into}`);
  else if (f.merged === false) out.push(`Not merged into ${into}: its commits are still on the sub's own branch`);
  if (f.pushed === false) out.push("Not pushed");
  else if (f.pushed === true) out.push("Pushed");
  return out;
}

function detailsHtml(chips: Chip[], words: string[]): string {
  return `<details class="mc-facts"><summary class="mc-chips" title="Built by code from git and the transcript, not from what the sub said">${chips.map(chipHtml).join("")}${caret}</summary><ul class="mc-facts-list">${words.map(li).join("")}</ul></details>`;
}

/** The chips and the words they open to, for one sub's work. */
export function factsHtml(f: SubFacts): string {
  return detailsHtml(factChips(f), factWords(f));
}

function sumChips(s: SubSumFacts): Chip[] {
  const more = s.unknown_subs > 0 ? "+" : "";
  const chips: Chip[] = [
    { tone: "done", icon: "ph-git-commit", value: `${s.commits}${more}`, title: `${plural(s.commits, "commit")} across ${plural(s.subs, "sub")}${more ? ", not counting a sub that is unknown" : ""}` },
    { tone: "done", icon: "ph-file", value: `${s.files_changed}${more}`, title: `${plural(s.files_changed, "file")} changed` },
    { tone: s.uncommitted > 0 ? "not" : "done", icon: "ph-warning", value: String(s.uncommitted), title: `${s.uncommitted} uncommitted in the files the subs edited` },
    { tone: s.tests_failed > 0 ? "not" : s.tests_unknown > 0 ? "wait" : "done", icon: "ph-test-tube", value: `${s.tests_passed}/${s.subs}`, title: `Last test run passed for ${s.tests_passed} of ${plural(s.subs, "sub")}` },
    { tone: s.unreviewed > 0 ? "wait" : "done", icon: "ph-eye", value: `${s.reviewed}/${s.subs}`, title: `A reviewer ran after the last edit for ${s.reviewed} of ${plural(s.subs, "sub")}` },
  ];
  if (s.unpushed > 0) chips.push({ tone: "wait", icon: "ph-cloud-slash", value: `${s.unpushed} not pushed`, title: `${s.unpushed} not pushed` });
  return chips;
}

function sumWords(s: SubSumFacts): string[] {
  const out = [`${plural(s.commits, "commit")} and ${plural(s.files_changed, "file")} changed across ${plural(s.subs, "sub")}`];
  const tests: string[] = [];
  if (s.tests_passed) tests.push(`${s.tests_passed} passed`);
  if (s.tests_failed) tests.push(`${s.tests_failed} failed`);
  if (s.tests_unknown) tests.push(`${s.tests_unknown} unknown`);
  out.push(`Last test run: ${tests.join(", ") || "unknown"}`);
  out.push(`${s.uncommitted} uncommitted in the files the subs edited`);
  out.push(`A reviewer ran after the last edit for ${s.reviewed} of ${s.subs}`);
  if (s.unpushed > 0) out.push(`${s.unpushed} not pushed`);
  if (s.unknown_subs > 0) out.push(`${plural(s.unknown_subs, "sub")} with figures the daemon could not read, left out of the totals`);
  return out;
}

/** The sub's card or the "all finished" card, as a row of the main chat. */
export function renderSubCard(m: RenderedMessage, entry: SubCardEntry, text: RenderText): string {
  const card = m.card!;
  let extras: CardExtras;
  if (entry.kind === "all_finished") {
    // The verdict of this card is code's: it states what ended, never that the
    // work is right, so it is never drawn green.
    extras = { tone: entry.tone === "bad" ? "bad" : "neutral", extraHtml: entry.sum ? detailsHtml(sumChips(entry.sum), sumWords(entry.sum)) : "" };
  } else {
    extras = {
      tag: entry.sub_name || "Subchat",
      tagNote: tierLabel(entry.model, entry.effort) || undefined,
      extraHtml: entry.kind === "finish" ? (entry.facts ? factsHtml(entry.facts) : detailsHtml([{ tone: "wait", icon: "ph-question", value: "unknown", title: "No facts were stored for this report" }], ["No facts were stored for this report: unknown"])) : "",
    };
  }
  return renderMessageCard(m, card, text, extras);
}
