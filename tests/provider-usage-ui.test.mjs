// @vitest-environment jsdom
// asserts: src/shared/provider-usage-format.ts
// asserts: src/shared/provider-usage-watch.ts
// asserts: src/views/settings/subviews/models-providers/provider-usage-rows.ts
// asserts: src/views/sessions/statusbar-chips.ts

// Provider usage where the frontend draws it: the one-line wording, the shared
// watch, the Accounts row slot, the overlay dial and the header chip tooltip.
// An unknown figure is "Usage unknown" everywhere, never 0% and never a limit.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getProviderUsage: vi.fn(), onProviderUsageChanged: vi.fn() },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));

const { providerLine, formatMoney } = await import("../src/shared/provider-usage-format.ts");
const { watchProviderUsage, ensureProviderUsageWatch } = await import("../src/shared/provider-usage-watch.ts");
const rows = await import("../src/views/settings/subviews/models-providers/provider-usage-rows.ts");
const { providerLimitStatus } = await import("../src/shared/account-limit-status.ts");
const { buildOverlayProviderRow, buildOverlayEntries } = await import("../src/views/overlay/overlay-logic.ts");
const { renderChip } = await import("../src/views/sessions/statusbar-chips.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const kimi = { id: "acct-kimi", label: "Kimi", icon: "moon", colour: "#4f8cff", kind: "endpoint" };
const sub = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };

const usage = (over = {}) => ({
  account_id: "acct-kimi", fetched_at: "2026-11-25T10:00:00Z", windows: [], balances: [], spend: null,
  available: null, error: null, source: "deepseek", ...over,
});
const tokens = (week) => ({
  account_id: "acct-kimi",
  five_hour: { input: 0, output: 0, cache_read: 0, cache_creation: 0, turns: 0 },
  today: { input: 10, output: 0, cache_read: 0, cache_creation: 0, turns: 1 },
  seven_day: { input: week, output: 0, cache_read: 0, cache_creation: 0, turns: 3 },
});

describe("formatMoney", () => {
  it("uses a symbol when it has one and the code otherwise", () => {
    expect(formatMoney(12.4)).toBe("$12.40");
    expect(formatMoney(110, "CNY")).toBe("¥110.00");
    expect(formatMoney(5, "KRW")).toBe("5.00 KRW");
  });
});

describe("providerLine", () => {
  it("no read at all is unknown, not a limit", () => {
    const l = providerLine(undefined);
    expect(l).toMatchObject({ figures: null, text: "Usage unknown", atLimit: false, pill: null, pct: null });
  });

  it("an errored read is unknown, carries the error for the tooltip and is no limit", () => {
    const l = providerLine(usage({ error: "HTTP 503", windows: [{ label: "x", used_pct: 100 }] }));
    expect(l).toMatchObject({ text: "Usage unknown", error: "HTTP 503", atLimit: false });
  });

  it("a read with no figures and no availability flag is unknown", () => {
    expect(providerLine(usage()).text).toBe("Usage unknown");
  });

  it("a balance reads as money left", () => {
    const l = providerLine(usage({ balances: [{ currency: "USD", amount: 12.4 }], available: true }));
    expect(l.text).toBe("$12.40 left");
    expect(l.atLimit).toBe(false);
  });

  it("an empty balance is Out of balance and a limit", () => {
    const l = providerLine(usage({ balances: [{ currency: "USD", amount: 0 }] }));
    expect(l).toMatchObject({ atLimit: true, pill: "Out of balance" });
    expect(providerLine(usage({ available: false })).pill).toBe("Out of balance");
  });

  it("a key cap reads remaining of cap, and today's spend follows", () => {
    const l = providerLine(usage({ spend: { day: 1.2, week: null, month: null, limit: 20, limit_remaining: 3.1 } }));
    expect(l.text).toBe("$3.10 of $20 key limit left · $1.20 today");
  });

  it("a full capped window is a limit named without its cadence", () => {
    const l = providerLine(usage({ windows: [{ label: "Weekly limit", used_pct: 100, resets_at: null }] }));
    expect(l).toMatchObject({ atLimit: true, pill: "limit", pct: 100 });
  });

  it("a window under its cap shows its percent and is not a limit", () => {
    const l = providerLine(usage({ windows: [{ label: "5h", used_pct: 42.4, resets_at: null }] }));
    expect(l.text).toBe("5h 42%");
    expect(l).toMatchObject({ atLimit: false, pct: 42.4 });
  });

  it("the Conductor token line shows only once something was counted", () => {
    expect(providerLine(undefined, tokens(0)).tokens).toBeNull();
    const l = providerLine(undefined, tokens(1_800_000));
    expect(l.tokens).toBe("1.8M tokens via Conductor this week");
    expect(l.tokensTitle).toContain("Usage outside Conductor is not included");
  });
});

describe("providerLimitStatus", () => {
  it("maps unknown, ok and limit tones", () => {
    expect(providerLimitStatus(undefined)).toEqual({ text: "Usage unknown", tone: "unknown" });
    expect(providerLimitStatus(usage({ balances: [{ currency: "USD", amount: 3 }] })).tone).toBe("ok");
    expect(providerLimitStatus(usage({ available: false }))).toMatchObject({ tone: "limit", pill: "Out of balance" });
  });
});

describe("watchProviderUsage", () => {
  let emit;
  const unlisten = vi.fn();
  beforeEach(() => {
    unlisten.mockReset();
    apiMock.getProviderUsage.mockReset();
    apiMock.onProviderUsageChanged.mockReset().mockImplementation((cb) => { emit = cb; return unlisten; });
  });

  it("emits the first read, then folds each event in", async () => {
    apiMock.getProviderUsage.mockResolvedValue({ usage: { "acct-kimi": usage() }, tokens: {} });
    const seen = [];
    watchProviderUsage((m) => seen.push(m));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1).usage["acct-kimi"].balances).toEqual([]);
    emit({ account_id: "acct-kimi", usage: usage({ balances: [{ currency: "USD", amount: 1 }] }) });
    expect(seen.at(-1).usage["acct-kimi"].balances).toHaveLength(1);
  });

  it("an event that beat the first read wins over that read's copy", async () => {
    let resolveRead;
    apiMock.getProviderUsage.mockReturnValue(new Promise((r) => { resolveRead = r; }));
    const seen = [];
    watchProviderUsage((m) => seen.push(m));
    emit({ account_id: "acct-kimi", usage: usage({ error: "newer" }) });
    resolveRead({ usage: { "acct-kimi": usage({ error: "older" }) }, tokens: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1).usage["acct-kimi"].error).toBe("newer");
  });

  it("stop() unsubscribes and silences later events", async () => {
    apiMock.getProviderUsage.mockResolvedValue({ usage: {}, tokens: {} });
    const seen = [];
    const w = watchProviderUsage((m) => seen.push(m));
    w.stop();
    expect(unlisten).toHaveBeenCalled();
    const n = seen.length;
    emit({ account_id: "acct-kimi", usage: usage() });
    expect(seen.length).toBe(n);
  });

  it("ensureProviderUsageWatch never starts for a Claude-only setup and starts once otherwise", () => {
    apiMock.getProviderUsage.mockResolvedValue({ usage: {}, tokens: {} });
    expect(ensureProviderUsageWatch(null, [sub], () => {})).toBeNull();
    expect(apiMock.getProviderUsage).not.toHaveBeenCalled();
    const w = ensureProviderUsageWatch(null, [sub, kimi], () => {});
    expect(w).not.toBeNull();
    expect(ensureProviderUsageWatch(w, [sub, kimi], () => {})).toBe(w);
    expect(apiMock.getProviderUsage).toHaveBeenCalledTimes(1);
  });
});

describe("Accounts row slot", () => {
  beforeEach(() => {
    rows.stopProviderUsage();
    apiMock.getProviderUsage.mockReset();
    apiMock.onProviderUsageChanged.mockReset().mockImplementation(() => () => {});
  });

  it("only an Endpoint row carries a slot", () => {
    expect(rows.providerUsageSlotHtml(sub)).toBe("");
    expect(rows.providerUsageSlotHtml(kimi)).toContain('data-usage-for="acct-kimi"');
  });

  it("starts as Usage unknown, then repaints in place when the figures arrive", async () => {
    apiMock.getProviderUsage.mockResolvedValue({
      usage: { "acct-kimi": usage({ balances: [{ currency: "USD", amount: 12.4 }] }) },
      tokens: { "acct-kimi": tokens(2_000_000) },
    });
    const root = document.createElement("div");
    root.innerHTML = rows.providerUsageSlotHtml(kimi);
    const slot = root.querySelector(".mp-usage");
    expect(slot.textContent).toContain("Usage unknown");
    rows.ensureProviderUsage(root, [kimi]);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(".mp-usage")).toBe(slot);
    expect(slot.textContent).toContain("$12.40 left");
    expect(slot.textContent).toContain("2M tokens via Conductor this week");
  });

  it("an errored read keeps the muted unknown tone and puts the error in the tooltip only", () => {
    const html = rows.providerUsageInnerHtml("acct-kimi", { usage: { "acct-kimi": usage({ error: "the provider rejected the key (HTTP 401)" }) }, tokens: {} });
    expect(html).toContain("is-unknown");
    expect(html).toContain('title="the provider rejected the key (HTTP 401)"');
    expect(html).not.toContain("is-limit");
  });

  it("an empty balance draws the limit tone and pill", () => {
    const html = rows.providerUsageInnerHtml("acct-kimi", { usage: { "acct-kimi": usage({ available: false }) }, tokens: {} });
    expect(html).toContain("is-limit");
    expect(html).toContain("mp-usage-pill");
  });
});

describe("overlay entries", () => {
  it("an Endpoint account draws a dial only with a capped window", () => {
    expect(buildOverlayProviderRow(kimi, undefined)).toBeNull();
    expect(buildOverlayProviderRow(kimi, usage({ balances: [{ currency: "USD", amount: 5 }] }))).toBeNull();
    const row = buildOverlayProviderRow(kimi, usage({ windows: [{ label: "5h", used_pct: 25, resets_at: null }] }));
    expect(row.remaining).toBe(0.75);
    expect(row.left).toBe("5h 25%");
  });

  it("entries keep registry order and leave an Endpoint account out when it has no dial", () => {
    const withDial = buildOverlayEntries([sub, kimi], {}, {}, Date.now(), { "acct-kimi": usage({ windows: [{ label: "5h", used_pct: 10 }] }) });
    expect(withDial.map((e) => e.kind)).toEqual(["plan", "provider"]);
    const without = buildOverlayEntries([sub, kimi], {}, {}, Date.now(), {});
    expect(without.map((e) => e.kind)).toEqual(["plan"]);
  });
});

describe("header account chip tooltip", () => {
  beforeEach(() => setCachedAccounts([kimi, sub]));
  const ctx = (note) => ({ accountId: "acct-kimi", hasAccountClick: true, animatedKeys: new Set(), accountNote: note });

  it("appends the provider one-liner to the title", () => {
    expect(renderChip("account", ctx("$12.40 left"))).toContain('title="Kimi - $12.40 left - click');
  });

  it("is the plain title without a note", () => {
    expect(renderChip("account", ctx(null))).toContain('title="Kimi - click');
  });
});
