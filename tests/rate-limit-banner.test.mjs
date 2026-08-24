// @vitest-environment jsdom
//
// Tests for the rate-limit banner controller. The daemon is the sole source
// of truth for "blocked" now (Instance.rate_limited_resets_at /
// rate_limited_type); this module only reflects that, one banner per
// exhausted account, and offers "Continue on <other account>" (forks the
// session via api.moveSessionToAccount) and "View in Schedule" (navigates).
// No frontend timer ever sends a turn on its own any more.
//
// isBlocked() reads the real Date.now() (it's the same formula every other
// consumer inlines - sidebar.ts, active-session.ts, composer's isBlocked
// wiring), so these tests fake the system clock rather than injecting a
// `now` dependency, keeping every time-based check (isBlocked, countdown,
// clock labels) consistent with a single faked "now".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { listAccounts, moveSessionToAccount } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  moveSessionToAccount: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: { listAccounts: (...a) => listAccounts(...a), moveSessionToAccount: (...a) => moveSessionToAccount(...a) },
}));

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => showToast(...a) }));

const { showView } = vi.hoisted(() => ({ showView: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: (...a) => showView(...a) }));

const { RateLimitBanner, isBlocked, formatClockLabel, capitalize } = await import(
  "../src/shared/chat/rate-limit-banner.ts"
);

/** Flushes pending microtasks so the async accounts-cache load settles. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const PERSONAL = { id: "acc-personal", label: "personal", colour: "#9d7dfc", icon: "user" };
const FIBO = { id: "acc-fibo", label: "fibo", colour: "#3ecf8e", icon: "buildings" };

// Fixed "now" for every test: 2026-01-01T12:00:00.000Z.
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function instance(overrides = {}) {
  return {
    session_id: "s1",
    account_id: FIBO.id,
    rate_limited_resets_at: null,
    rate_limited_type: null,
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let host;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  document.body.innerHTML = "<div id='host'></div>";
  host = document.getElementById("host");
  listAccounts.mockReset().mockResolvedValue([PERSONAL, FIBO]);
  moveSessionToAccount.mockReset();
  showToast.mockReset();
  showView.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isBlocked", () => {
  it("false when rate_limited_resets_at is null", () => {
    expect(isBlocked(instance({ rate_limited_resets_at: null }))).toBe(false);
  });

  it("true when resets_at is in the future", () => {
    expect(isBlocked(instance({ rate_limited_resets_at: BigInt(NOW_SEC + 3600) }))).toBe(true);
  });

  it("false when resets_at is in the past", () => {
    expect(isBlocked(instance({ rate_limited_resets_at: BigInt(NOW_SEC - 3600) }))).toBe(false);
  });
});

describe("capitalize", () => {
  it("title-cases the first letter only", () => {
    expect(capitalize("fibo")).toBe("Fibo");
    expect(capitalize("")).toBe("");
  });
});

describe("RateLimitBanner", () => {
  it("renders nothing when no account is blocked", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ rate_limited_resets_at: null })]);
    expect(host.hidden).toBe(true);
    expect(host.querySelectorAll(".rate-limit-banner").length).toBe(0);
  });

  it("renders one banner for a blocked account, naming the account + window", async () => {
    const resetsAtSec = NOW_SEC + 2 * 3600 + 14 * 60; // now + 2h14m
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ account_id: FIBO.id, rate_limited_resets_at: BigInt(resetsAtSec), rate_limited_type: "five_hour" })]);

    expect(host.hidden).toBe(false);
    const card = host.querySelector(".rate-limit-banner");
    expect(card).toBeTruthy();
    expect(card.querySelector(".rlb-title").textContent).toBe("Fibo hit its 5-hour limit");
    expect(card.querySelector(".rlb-time").textContent).toBe(`Resets ${formatClockLabel(resetsAtSec * 1000)}`);
    expect(card.querySelector(".rlb-countdown").textContent).toBe("in 2h 14m");
    expect(card.querySelector(".rlb-icon").className).toContain("ph-buildings");
  });

  it("maps seven_day/weekly to the 'weekly' label", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ rate_limited_resets_at: BigInt(NOW_SEC + 3600), rate_limited_type: "seven_day" })]);
    expect(host.querySelector(".rlb-title").textContent).toBe("Fibo hit its weekly limit");
  });

  it("appends '· N chats affected' only when more than one blocked chat shares the account", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([
      instance({ session_id: "s1", rate_limited_resets_at: BigInt(NOW_SEC + 3600) }),
      instance({ session_id: "s2", rate_limited_resets_at: BigInt(NOW_SEC + 3600) }),
    ]);
    expect(host.querySelector(".rlb-time").textContent).toMatch(/· 2 chats affected$/);
  });

  it("shows an enabled 'Continue on <other>' when the other account is not blocked", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600) })]);
    const btn = host.querySelector(".rlb-move");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Continue on Personal");
  });

  it("disables 'Continue on <other>' (with a title, not hidden) when both accounts are blocked", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([
      instance({ session_id: "s1", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600) }),
      instance({ session_id: "s2", account_id: PERSONAL.id, rate_limited_resets_at: BigInt(NOW_SEC + 7200) }),
    ]);
    for (const btn of host.querySelectorAll(".rlb-move")) {
      expect(btn.disabled).toBe(true);
      expect(btn.title).toMatch(/is also at its limit until/);
    }
  });

  // The daemon switches the account in place now, so it hands back the SAME
  // session id it was given. onMoved still fires with both ids because the
  // pane repaint is shared with the fork fallback.
  it("clicking 'Continue on <other>' switches the selected blocked session's account", async () => {
    moveSessionToAccount.mockResolvedValue("s2");
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    const onMoved = vi.fn();
    b.setOnMoved(onMoved);
    b.setSelectedSessionGetter(() => "s2");
    b.update([
      instance({ session_id: "s1", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600), started_at: "2026-01-01T00:00:00Z" }),
      instance({ session_id: "s2", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600), started_at: "2026-01-02T00:00:00Z" }),
    ]);

    host.querySelector(".rlb-move").click();
    await flush();

    expect(moveSessionToAccount).toHaveBeenCalledWith("s2", PERSONAL.id);
    expect(showToast).toHaveBeenCalledWith("Now on Personal, continuing.");
    expect(onMoved).toHaveBeenCalledWith("s2", "s2");
  });

  it("falls back to the most-recently-started blocked session when none is selected", async () => {
    moveSessionToAccount.mockResolvedValue("new-session-id");
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.setSelectedSessionGetter(() => null);
    b.update([
      instance({ session_id: "older", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600), started_at: "2026-01-01T00:00:00Z" }),
      instance({ session_id: "newer", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600), started_at: "2026-01-02T00:00:00Z" }),
    ]);

    host.querySelector(".rlb-move").click();
    await flush();

    expect(moveSessionToAccount).toHaveBeenCalledWith("newer", PERSONAL.id);
  });

  it("'View in Schedule' navigates via showView('schedule')", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ rate_limited_resets_at: BigInt(NOW_SEC + 3600) })]);
    host.querySelector(".rlb-schedule").click();
    expect(showView).toHaveBeenCalledWith("schedule");
  });

  it("renders one banner per exhausted account when both are blocked", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([
      instance({ session_id: "s1", account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600) }),
      instance({ session_id: "s2", account_id: PERSONAL.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600) }),
    ]);
    expect(host.querySelectorAll(".rate-limit-banner").length).toBe(2);
  });

  it("clears itself once the account's reset time passes (no clear-event needed)", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ rate_limited_resets_at: BigInt(NOW_SEC + 10) })]);
    expect(host.hidden).toBe(false);

    vi.setSystemTime(NOW_MS + 20_000); // past the 10s reset
    b.update([instance({ rate_limited_resets_at: BigInt(NOW_SEC + 10) })]);
    expect(host.hidden).toBe(true);
  });

  it("clicking minimize collapses the card to an icon-only pill; clicking the pill re-expands", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600), rate_limited_type: "seven_day" })]);

    host.querySelector(".rlb-minimize").click();
    expect(host.querySelector(".rate-limit-banner--min")).toBeTruthy();
    expect(host.querySelector(".rlb-title")).toBeFalsy();
    expect(host.hidden).toBe(false); // pill still visible, not fully dismissed

    host.querySelector(".rate-limit-banner--min").click();
    expect(host.querySelector(".rate-limit-banner--min")).toBeFalsy();
    expect(host.querySelector(".rlb-title").textContent).toBe("Fibo hit its weekly limit");
  });

  it("persists the minimized state across instances (survives an app restart) while the window is still live", async () => {
    const resetsAt = BigInt(NOW_SEC + 3600);
    const b1 = new RateLimitBanner();
    b1.mount(host);
    await flush();
    b1.update([instance({ account_id: FIBO.id, rate_limited_resets_at: resetsAt })]);
    host.querySelector(".rlb-minimize").click();

    const b2 = new RateLimitBanner();
    b2.mount(host);
    await flush();
    b2.update([instance({ account_id: FIBO.id, rate_limited_resets_at: resetsAt })]);
    expect(host.querySelector(".rate-limit-banner--min")).toBeTruthy();
  });

  it("does not carry the minimized flag over to a new rejection window (different resets_at)", async () => {
    const b = new RateLimitBanner();
    b.mount(host);
    await flush();
    b.update([instance({ account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 3600) })]);
    host.querySelector(".rlb-minimize").click();

    // A fresh rejection during a new window gets a new resets_at.
    b.update([instance({ account_id: FIBO.id, rate_limited_resets_at: BigInt(NOW_SEC + 7200) })]);
    expect(host.querySelector(".rate-limit-banner--min")).toBeFalsy();
    expect(host.querySelector(".rlb-title")).toBeTruthy();
  });
});
