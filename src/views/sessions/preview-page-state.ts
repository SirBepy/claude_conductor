// Page-state channel for the Preview panel. A pushed page runs in an opaque-origin
// sandbox, so it cannot save anything itself; this gives it two calls instead:
//   ccPreview.state.save(value)      remember where the page is (slide, tab, scroll)
//   ccPreview.state.onRestore(fn)    fn(value) once the saved value is known, and
//                                    again when another window changes it
// The app keeps the value on the daemon (PreviewSnapshot.view_state.page), so the
// docked panel, the pop-out window and a reload all hand the page the same value.

/** Injected into the head of a panel document. A late `onRestore` still gets the value. */
export const PAGE_STATE_SCRIPT = `<script>(function(){
  var cbs = [], has = false, last;
  window.ccPreview = { state: {
    save: function(v){ parent.postMessage({ cc: "state", value: v }, "*"); },
    onRestore: function(fn){ cbs.push(fn); if (has) { try { fn(last); } catch (_) {} } }
  } };
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.cc !== "restore") return;
    has = true; last = d.value;
    cbs.forEach(function(f){ try { f(d.value); } catch (_) {} });
  });
})();</script>`;

/** A page may save on every scroll tick; the daemon gets the last value after a pause. */
export const PAGE_STATE_DEBOUNCE_MS = 300;

export interface PageStateHost {
  frame(): HTMLIFrameElement | null;
  /** The value the daemon holds for the page now, undefined when none. */
  stored(): unknown;
  /** The preview in view; a save is filed under the one in view when the page made it. */
  id(): string | null;
  /** Writes the value locally and to the daemon. */
  save(id: string, value: unknown): void;
}

export class PageStateBridge {
  private timer: number | null = null;
  private pending: { id: string; value: unknown } | null = null;
  private readonly onMessage = (e: MessageEvent): void => {
    const frame = this.host.frame();
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as { cc?: string; value?: unknown } | null;
    if (d?.cc !== "state") return;
    const id = this.host.id();
    if (!id) return;
    // A save for another preview still waiting must not be lost to this one.
    if (this.pending && this.pending.id !== id) this.flush();
    this.pending = { id, value: d.value };
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), PAGE_STATE_DEBOUNCE_MS);
  };

  constructor(private readonly host: PageStateHost) {
    window.addEventListener("message", this.onMessage);
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.flush();
  }

  /** Writes a save the page made but the pause has not yet flushed. */
  flush(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p) this.host.save(p.id, p.value);
  }

  /** Hands the page what the daemon holds; run on the frame's load. */
  restore(): void {
    this.post(this.host.stored());
  }

  /** Another window changed the value: hand it to the page unless it is already what this window holds. */
  follow(previous: unknown, next: unknown): void {
    if (sameJson(previous, next)) return;
    this.post(next);
  }

  private post(value: unknown): void {
    if (value === undefined) return;
    this.host.frame()?.contentWindow?.postMessage({ cc: "restore", value }, "*");
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
