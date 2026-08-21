// Reusable diagnostic probe (ai_todo 722): snapshots a selector under wdio
// without hand-writing a throwaway spec each time. Opt-in only.
//   PROBE_VIEW=sessions PROBE_SELECTOR="#newSessionBtn" [PROBE_CLICK=sel]
//   [PROBE_SETTLE_MS=500] npm run test:e2e:probe

const VIEW = process.env.PROBE_VIEW || "";
const SELECTOR = process.env.PROBE_SELECTOR || "";
const CLICK = process.env.PROBE_CLICK || "";
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS || 0);

describe("probe (ai_todo 722)", () => {
  it("snapshots the target selector, its window, and its ancestor chain", async () => {
    if (!SELECTOR) throw new Error('PROBE_SELECTOR is required, e.g. PROBE_SELECTOR="#newSessionBtn"');

    if (VIEW) await browser.execute((v) => window.showView && window.showView(v), VIEW);
    if (CLICK) {
      const el = await $(CLICK);
      if (await el.isExisting()) await el.click().catch(() => {});
    }
    if (SETTLE_MS) await browser.pause(SETTLE_MS);

    const handles = await browser.getWindowHandles();
    const currentHandle = await browser.getWindowHandle();

    const snapshot = await browser.execute((sel) => {
      const describeEl = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          id: el.id || null,
          className: el.className || null,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
        };
      };

      const target = document.querySelector(sel);
      if (!target) {
        return { found: false, href: location.href, bodyClassName: document.body.className };
      }

      const ancestors = [];
      for (let el = target.parentElement; el; el = el.parentElement) ancestors.push(describeEl(el));

      const r = target.getBoundingClientRect();
      const atPoint = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);

      return {
        found: true,
        href: location.href,
        bodyClassName: document.body.className,
        target: describeEl(target),
        elementFromPointAtCentre: atPoint
          ? { tag: atPoint.tagName, id: atPoint.id || null, className: atPoint.className || null }
          : null,
        ancestors,
      };
    }, SELECTOR);

    console.log("PROBE_RESULT " + JSON.stringify({ selector: SELECTOR, handles, currentHandle, ...snapshot }, null, 2));
  });
});
