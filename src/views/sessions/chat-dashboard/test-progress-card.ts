// The dashboard's Test progress card (pc-1684): what a running test run reported to
// the daemon (scripts/test-progress.mjs -> POST /hooks/test-progress -> `test-progress`
// event), one row per runner with a bar, the counts and the names of the failing
// tests. Owns its DOM inside the zone's `.tp-host` (like the Answers and Subchats
// cards) and PATCHES it in place: a tick of the numbers changes a text node and a bar's
// scale, so no enter animation replays and nothing under the pointer is rebuilt.
// Raises nothing: it is a place to look, never a Waiting-on-you item.

import "./test-progress-card.css";
import { getTransport } from "../../../shared/transport";
import { escapeHtml } from "../../../shared/escape-html";
import { agoLabel } from "../../../shared/chat/dashboard/dashboard-model";
import {
  countsParts, nextStaleAt, normaliseRuns, stateLabel,
  type TestProgressSide, type TestProgressState, type TestRun, type TestRunView,
} from "../../../shared/chat/dashboard/test-progress-model";

export interface TestProgressHost {
  /** The chat's id; null until the renderer knows it. */
  sessionId(): string | null;
  /** Asks the dashboard for a redraw. */
  schedule(): void;
}

/** How long a leaving row stays before it is removed if no transitionend arrives. */
const LEAVE_FALLBACK_MS = 400;

interface TestProgressEvent {
  session_id?: string;
  runs?: unknown;
}

/** The newest report per chat, kept past one dashboard's life. A dashboard is rebuilt on every chat
 *  switch and a run that ends while another chat is open is announced once, so without this a
 *  finished run (and the names of its failing tests) would be gone when Joe comes back. */
const lastReport = new Map<string, { event: TestProgressEvent; at: number }>();
const REMEMBERED_CHATS = 50;

function startFeed(): void {
  try {
    void getTransport().listen<TestProgressEvent>("test-progress", (p) => {
      const sid = p?.session_id;
      if (!sid) return;
      lastReport.delete(sid);
      lastReport.set(sid, { event: p, at: Date.now() });
      if (lastReport.size > REMEMBERED_CHATS) lastReport.delete(lastReport.keys().next().value as string);
    }).catch((err) => console.warn("[chat-dashboard] test-progress feed failed", err));
  } catch (err) {
    console.warn("[chat-dashboard] test-progress feed failed", err);
  }
}
startFeed();

export class TestProgressCard {
  /** Newest report per runner, keyed by runner name. */
  private runs = new Map<string, TestRun>();
  /** The daemon time of the report Joe dismissed, per runner: older or equal reports stay gone. */
  private dismissed = new Map<string, number>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private host: HTMLElement | null = null;
  private rows = new Map<string, HTMLElement>();
  /** Pending fold-out fallbacks, cleared with the card so none fires on a disposed one. */
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly cb: TestProgressHost) {}

  /** What the dashboard derives from; undefined until the first report. */
  sideData(): TestProgressSide | undefined {
    return this.runs.size > 0 ? { runs: [...this.runs.values()] } : undefined;
  }

  async subscribe(): Promise<void> {
    try {
      const un = await getTransport().listen<TestProgressEvent>("test-progress", (p) => this.adopt(p));
      if (this.disposed) un();
      else this.unlisten = un;
      const sid = this.cb.sessionId();
      const last = sid ? lastReport.get(sid) : undefined;
      if (last) this.adopt(last.event, last.at);
    } catch (err) {
      console.warn("[chat-dashboard] listen(test-progress) failed", err);
    }
  }

  /** Takes one event. The daemon sends the chat's whole list on every report, so a runner it
   *  dropped for its cap is dropped here too; another chat's event is ignored. */
  adopt(p: TestProgressEvent | null | undefined, seen = Date.now()): void {
    const sid = this.cb.sessionId();
    if (this.disposed || !sid || p?.session_id !== sid) return;
    const next = new Map<string, TestRun>();
    for (const r of normaliseRuns(p.runs, seen)) {
      if (r.atMs <= (this.dismissed.get(r.runner) ?? -1)) continue;
      // The daemon resends the chat's whole list on every report; a run it has not heard from
      // again keeps the time this window last did, so it can still go stale and keep its age.
      const prev = this.runs.get(r.runner);
      if (prev && prev.atMs === r.atMs) r.seenMs = prev.seenMs;
      next.set(r.runner, r);
    }
    this.runs = next;
    this.cb.schedule();
  }

  /** Draws `state` into `host`, patching what is there. */
  update(host: HTMLElement, state: TestProgressState): void {
    if (this.host !== host) {
      this.host = host;
      this.rows.clear();
      host.replaceChildren();
      host.addEventListener("click", (e) => this.onClick(e));
    }
    const names = new Set(state.runs.map((r) => r.runner));
    for (const [runner, el] of this.rows) {
      if (!names.has(runner)) this.fold(runner, el);
    }
    for (const run of state.runs) {
      let el = this.rows.get(run.runner);
      if (!el) el = this.build(run);
      this.patch(el, run);
    }
    this.armStale();
  }

  detach(): void {
    this.host = null;
    this.rows.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.host = null;
  }

  /** A fallback timeout that forgets itself once it has run. */
  private later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  /** One redraw when the earliest live run goes quiet, so a killed run reads "Stopped"
   *  without waiting for some other event to redraw the dashboard. */
  private armStale(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    const at = nextStaleAt(this.sideData(), Date.now());
    if (at === null) return;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (!this.disposed) this.cb.schedule();
    }, Math.max(0, at - Date.now()));
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-tp-act='dismiss']");
    const runner = btn?.closest<HTMLElement>("[data-tp]")?.dataset["tp"];
    if (!btn || !runner || !this.host?.contains(btn)) return;
    const run = this.runs.get(runner);
    if (!run) return;
    this.dismissed.set(runner, run.atMs);
    const el = this.rows.get(runner);
    if (el) this.fold(runner, el, () => {
      // A report newer than the dismissed one that landed during the fold is a new run: keep it.
      if ((this.runs.get(runner)?.atMs ?? -1) <= (this.dismissed.get(runner) ?? -1)) this.runs.delete(runner);
      this.cb.schedule();
    });
  }

  /** Folds a row away (grid 0fr, the same exit as the Done card's rows) and removes it at the
   *  end of the transition. `done` runs once, after the removal. */
  private fold(runner: string, el: HTMLElement, done?: () => void): void {
    if (el.classList.contains("is-leaving")) return;
    el.classList.add("is-leaving");
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      el.remove();
      if (this.rows.get(runner) === el) this.rows.delete(runner);
      if (!this.disposed) done?.();
    };
    el.addEventListener("transitionend", (ev) => {
      if (ev.target === el && ev.propertyName === "grid-template-rows") finish();
    });
    this.later(finish, LEAVE_FALLBACK_MS);
  }

  private build(run: TestRunView): HTMLElement {
    const el = document.createElement("article");
    el.className = "tp-run is-new";
    el.dataset["tp"] = run.runner;
    el.innerHTML = `<div class="tp-in">`
      + `<div class="tp-top"><span class="tp-name">${escapeHtml(run.runner)}</span><span class="tp-chip"></span><em class="dn-at tp-at"></em>`
      + `<button type="button" class="tp-x" data-tp-act="dismiss" title="Dismiss" aria-label="Dismiss ${escapeHtml(run.runner)}"><i class="ph ph-x"></i></button></div>`
      + `<div class="tp-bar" role="progressbar"><i class="tp-bad"></i><i class="tp-ok"></i></div>`
      + `<div class="tp-nums"><span class="tp-pass"></span><span class="tp-fail"><span class="tp-fail-in"></span></span><span class="tp-of"><span class="tp-of-in"></span></span></div>`
      + `<ul class="tp-fails"></ul>`
      + `</div>`;
    this.host?.appendChild(el);
    this.rows.set(run.runner, el);
    // One reflow so the row's first frame is the folded one and is-new then transitions it open.
    void el.offsetHeight;
    el.classList.remove("is-new");
    return el;
  }

  private patch(el: HTMLElement, run: TestRunView): void {
    const state = run.stale ? "stale" : run.state;
    if (el.dataset["state"] !== state) el.dataset["state"] = state;
    el.classList.toggle("is-indet", run.indeterminate);
    const setText = (sel: string, text: string): void => {
      const n = el.querySelector(sel);
      if (n && n.textContent !== text) n.textContent = text;
    };
    setText(".tp-chip", stateLabel(run));
    const at = el.querySelector<HTMLElement>(".tp-at");
    if (at) {
      // Finished runs say how long ago (the dashboard's minute tick keeps it current, fillAgo).
      const ms = run.state === "running" ? "" : String(run.seenMs);
      if ((at.dataset["ms"] ?? "") !== ms) {
        if (ms) at.dataset["ms"] = ms; else delete at.dataset["ms"];
        at.textContent = ms ? agoLabel(run.seenMs, Date.now()) : "";
      }
    }
    const bar = el.querySelector<HTMLElement>(".tp-bar");
    if (bar) {
      bar.setAttribute("aria-label", `${run.runner} progress`);
      if (run.of > 0) {
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(run.of));
        bar.setAttribute("aria-valuenow", String(run.passed + run.failed));
      } else {
        bar.removeAttribute("aria-valuemax");
        bar.removeAttribute("aria-valuenow");
      }
    }
    // The bad layer is longer than the ok layer and sits behind it, so the red shows past the green.
    el.querySelector<HTMLElement>(".tp-ok")?.style.setProperty("--f", String(run.okFrac));
    el.querySelector<HTMLElement>(".tp-bad")?.style.setProperty("--f", String(Math.min(1, run.okFrac + run.badFrac)));
    const c = countsParts(run);
    setText(".tp-pass", c.passed);
    setText(".tp-fail-in", c.failed);
    el.querySelector(".tp-fail")?.classList.toggle("is-on", c.failed !== "");
    setText(".tp-of-in", c.of);
    el.querySelector(".tp-of")?.classList.toggle("is-on", c.of !== "");
    this.patchFailing(el.querySelector<HTMLElement>(".tp-fails"), run);
  }

  /** Keyed by name: a name already listed stays untouched, a new one folds open, one the
   *  runner no longer reports folds shut. The "+N more" line is the last row. */
  private patchFailing(ul: HTMLElement | null, run: TestRunView): void {
    if (!ul) return;
    const have = new Map<string, HTMLElement>();
    for (const li of ul.querySelectorAll<HTMLElement>("li.tp-f")) have.set(li.dataset["name"] ?? "", li);
    const want = new Set(run.failing);
    for (const [name, li] of have) {
      if (want.has(name) || li.classList.contains("is-leaving")) continue;
      li.classList.add("is-leaving");
      const drop = (): void => li.remove();
      li.addEventListener("transitionend", (ev) => { if (ev.target === li && ev.propertyName === "grid-template-rows") drop(); });
      this.later(drop, LEAVE_FALLBACK_MS);
    }
    let more = ul.querySelector<HTMLElement>("li.tp-more");
    if (!more) {
      more = document.createElement("li");
      more.className = "tp-more";
      more.innerHTML = `<span class="tp-more-t"></span>`;
    }
    if (more.parentElement !== ul) ul.appendChild(more);
    for (const name of run.failing) {
      const live = have.get(name);
      if (live && !live.classList.contains("is-leaving")) continue;
      const li = document.createElement("li");
      li.className = "tp-f is-new";
      li.dataset["name"] = name;
      li.innerHTML = `<div class="tp-fi"><i class="ph ph-x-circle"></i><span class="tp-fn" title="${escapeHtml(name)}">${escapeHtml(name)}</span></div>`;
      ul.insertBefore(li, more);
      void li.offsetHeight;
      li.classList.remove("is-new");
    }
    const text = run.failingMore > 0 ? `+${run.failingMore} more` : "";
    const t = more.querySelector(".tp-more-t");
    if (t && t.textContent !== text) t.textContent = text;
    more.classList.toggle("is-on", text !== "");
  }
}
