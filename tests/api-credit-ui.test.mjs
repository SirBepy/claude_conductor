// @vitest-environment jsdom

// The API-credit account kind where the frontend draws it: the account badge,
// the dashboard meter line, and the live status watcher it reads.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getApiCreditStatus: vi.fn(),
    onApiCreditStatusChanged: vi.fn(),
    addApiCreditAccount: vi.fn(),
    replaceApiCreditKey: vi.fn(),
  },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const { openReplaceMock } = vi.hoisted(() => ({ openReplaceMock: vi.fn() }));
vi.mock("../src/views/settings/subviews/accounts/add-api-credit-modal.ts", () => ({
  openReplaceApiKeyModal: openReplaceMock,
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { apiCreditMeterHtml } = await import("../src/views/dashboard/api-credit-meter.ts");
const { watchApiCreditStatus, ensureApiCreditWatch } = await import("../src/shared/api-credit-watch.ts");
const { accountIconBadgeHtml, accountChipHtml } = await import("../src/shared/account-chip.ts");
const rowsModule = await import("../src/views/settings/subviews/accounts/api-credit-rows.ts");

const sub = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const credit = { id: "acct-credit", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit" };

const status = (over = {}) => ({
  account_id: "acct-credit",
  max_grant_remaining_cents: 17871,
  max_grant_total_cents: 20000,
  max_grant_expires_at: "2026-11-02T00:00:00Z",
  purchased_remaining_cents: 0,
  spend_cents: 2128,
  limit_cents: 20000,
  spend_resets_at: "2026-11-01T00:00:00Z",
  fetched_at: "2026-10-26T12:00:00Z",
  blocked: false,
  block_reason: null,
  error: null,
  ...over,
});

describe("account badge", () => {
  it("draws a key for an API-credit account whatever icon it stores", () => {
    expect(accountIconBadgeHtml(credit)).toContain("ph-key");
    expect(accountIconBadgeHtml(credit)).not.toContain("ph-user");
    expect(accountIconBadgeHtml(sub)).toContain("ph-user");
  });
});

describe("dashboard meter", () => {
  it("is empty without an API-credit account", () => {
    expect(apiCreditMeterHtml([sub], {})).toBe("");
  });

  it("draws one line per API-credit account with the figures and a fill", () => {
    const html = apiCreditMeterHtml([sub, credit], { "acct-credit": status() });
    expect(html.match(/class="dash-credit"/g)).toHaveLength(1);
    expect(html).toContain("API credit");
    expect(html).toContain("<b>$178.71</b> left");
    expect(html).toContain("of $200 · expires Nov 2");
    expect(html).toContain("Spent $21.28 of $200");
    expect(html).toContain("width:89.4%");
  });

  it("says so before the first figures arrive", () => {
    expect(apiCreditMeterHtml([credit], {})).toContain("No figures yet");
  });

  it("does not claim there are no figures when only the spend is known", () => {
    const html = apiCreditMeterHtml([credit], {
      "acct-credit": status({ max_grant_remaining_cents: null, max_grant_total_cents: null }),
    });
    expect(html).toContain("Spent $21.28 of $200");
    expect(html).not.toContain("No figures yet");
  });

  it("shows the error as a link to Settings, with the Connect Console hint when that is the fix", () => {
    const html = apiCreditMeterHtml([credit], {
      "acct-credit": status({
        max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
        spend_cents: null, limit_cents: null, error: "Console not connected",
      }),
    });
    expect(html).toContain("dash-credit-link");
    expect(html).toContain("Console not connected - Connect Console");
    expect(html).not.toContain("dash-credit-bar");
  });

  it("shows the block reason in the warning style", () => {
    const html = apiCreditMeterHtml([credit], {
      "acct-credit": status({ blocked: true, block_reason: "Console spend limit $200 reached" }),
    });
    expect(html).toContain("dash-credit-warn");
    expect(html).toContain("Console spend limit $200 reached");
  });

  it("escapes a label", () => {
    const html = apiCreditMeterHtml([{ ...credit, label: "<b>x</b>" }], {});
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("watchApiCreditStatus", () => {
  let emit;
  const unlisten = vi.fn();

  beforeEach(() => {
    unlisten.mockReset();
    apiMock.getApiCreditStatus.mockReset();
    apiMock.onApiCreditStatusChanged.mockReset().mockImplementation((cb) => { emit = cb; return unlisten; });
  });

  it("emits the first read, then folds each event in", async () => {
    apiMock.getApiCreditStatus.mockResolvedValue({ "acct-credit": status() });
    const seen = [];
    watchApiCreditStatus((m) => seen.push(m));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(2128);

    emit({ account_id: "acct-credit", status: status({ spend_cents: 5000 }) });
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(5000);
  });

  it("lets an event that beat the first read win over that read's copy", async () => {
    let resolveRead;
    apiMock.getApiCreditStatus.mockReturnValue(new Promise((r) => { resolveRead = r; }));
    const seen = [];
    watchApiCreditStatus((m) => seen.push(m));
    emit({ account_id: "acct-credit", status: status({ spend_cents: 9000 }) });
    resolveRead({ "acct-credit": status({ spend_cents: 100 }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)["acct-credit"].spend_cents).toBe(9000);
  });

  it("stops emitting and unlistens once disposed", async () => {
    apiMock.getApiCreditStatus.mockResolvedValue({});
    const seen = [];
    const dispose = watchApiCreditStatus((m) => seen.push(m));
    dispose();
    emit({ account_id: "acct-credit", status: status() });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("ensureApiCreditWatch", () => {
  beforeEach(() => {
    apiMock.getApiCreditStatus.mockReset().mockResolvedValue({});
    apiMock.onApiCreditStatusChanged.mockReset().mockReturnValue(() => {});
  });

  it("never subscribes without an API-credit account", () => {
    expect(ensureApiCreditWatch(null, [sub], () => {})).toBeNull();
    expect(apiMock.onApiCreditStatusChanged).not.toHaveBeenCalled();
  });

  it("subscribes once an API-credit account exists, and only once per holder", () => {
    const first = ensureApiCreditWatch(null, [sub, credit], () => {});
    expect(typeof first).toBe("function");
    const second = ensureApiCreditWatch(first, [sub, credit], () => {});
    expect(second).toBe(first);
    expect(apiMock.onApiCreditStatusChanged).toHaveBeenCalledTimes(1);
  });
});

describe("Replace API key row action", () => {
  const { apiCreditRowHtml, wireCreditRowMenus } = rowsModule;

  function mountRow() {
    document.body.innerHTML = `<div id="root"><div id="list">${apiCreditRowHtml(credit, [sub, credit])}</div></div>`;
    const list = document.getElementById("list");
    wireCreditRowMenus(list, document.getElementById("root"));
    return list;
  }

  beforeEach(() => {
    openReplaceMock.mockReset();
    apiMock.refreshApiCreditStatus = vi.fn().mockResolvedValue(status());
  });

  it("is in the API-credit row's menu", () => {
    const item = mountRow().querySelector(".acc-menu-replace-key");
    expect(item?.textContent).toContain("Replace API key");
    expect(item?.getAttribute("data-id")).toBe("acct-credit");
  });

  it("opens the masked-key modal for that account and refreshes the balance once the key was replaced", async () => {
    openReplaceMock.mockResolvedValue(true);
    mountRow().querySelector(".acc-menu-replace-key").click();
    await vi.waitFor(() => expect(apiMock.refreshApiCreditStatus).toHaveBeenCalledWith("acct-credit"));
    expect(openReplaceMock).toHaveBeenCalledWith({ id: "acct-credit", label: "API credit" });
  });

  it("leaves the balance alone when the modal closes without a new key", async () => {
    openReplaceMock.mockResolvedValue(false);
    mountRow().querySelector(".acc-menu-replace-key").click();
    await vi.waitFor(() => expect(openReplaceMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(apiMock.refreshApiCreditStatus).not.toHaveBeenCalled();
  });
});

describe("account chip", () => {
  it("carries the API credit tag inside the chip for an API-credit account only", () => {
    expect(accountChipHtml(credit)).toMatch(/<span class="cam-credit-hint">API credit<\/span><\/span>$/);
    expect(accountChipHtml(sub)).not.toContain("cam-credit-hint");
  });
});

describe("API-key modals while a save is in flight", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let modals;

  // The file mocks the modal module for the row tests above; these tests drive
  // the real one.
  beforeEach(async () => {
    modals ??= await vi.importActual("../src/views/settings/subviews/accounts/add-api-credit-modal.ts");
    apiMock.addApiCreditAccount.mockReset();
    apiMock.replaceApiCreditKey.mockReset();
  });

  // closeHostCard tears the card down on a 150ms timer; the next test's card
  // must not be cleared by the previous test's timer.
  afterEach(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(200);
    document.getElementById("modal-host")?.remove();
  });

  const card = () => document.querySelector(".aikm-modal-card");

  async function mountCard(open) {
    const result = open();
    let settled = false;
    result.then(() => { settled = true; });
    await vi.waitFor(() => expect(card()?.querySelector("input")).toBeTruthy());
    return { result, isSettled: () => settled };
  }

  function type(selector, value) {
    const input = card().querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const pressEscape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  const clickBackdrop = () => document.querySelector("#modal-host .modal-backdrop").click();
  const cancelButton = () => card().querySelector(".btn-secondary");

  const cases = [
    {
      name: "Add API-credit",
      open: () => modals.openAddApiCreditModal(),
      fill: () => { type("#aacm-label", "Credit"); type("#aacm-key", "sk-ant-x"); },
      save: ".aacm-save-btn",
      mock: () => apiMock.addApiCreditAccount,
      okValue: credit,
      cancelled: null,
    },
    {
      name: "Replace API key",
      open: () => modals.openReplaceApiKeyModal({ id: "acct-credit", label: "API credit" }),
      fill: () => type("#rapk-key", "sk-ant-y"),
      save: ".rapk-save-btn",
      mock: () => apiMock.replaceApiCreditKey,
      okValue: undefined,
      cancelled: false,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("ignores Escape, the backdrop and Cancel while saving, then resolves with the saved result", async () => {
        let finish;
        c.mock().mockReturnValue(new Promise((r) => { finish = r; }));
        const { result, isSettled } = await mountCard(c.open);
        c.fill();
        card().querySelector(c.save).click();
        await vi.waitFor(() => expect(c.mock()).toHaveBeenCalledTimes(1));

        expect(cancelButton().disabled).toBe(true);
        cancelButton().click();
        pressEscape();
        clickBackdrop();
        await sleep(200);
        expect(isSettled()).toBe(false);
        expect(card()).toBeTruthy();

        finish(c.okValue);
        const value = await result;
        expect(value).toEqual(c.name === "Replace API key" ? true : credit);
      });

      it("closes on Escape, the backdrop and Cancel while idle", async () => {
        for (const dismiss of [pressEscape, clickBackdrop, () => cancelButton().click()]) {
          const { result } = await mountCard(c.open);
          dismiss();
          expect(await result).toBe(c.cancelled);
          await sleep(200);
        }
      });

      it("shows the error, re-enables Cancel and stays open when the save fails", async () => {
        c.mock().mockRejectedValue(new Error("Anthropic said no"));
        const { result, isSettled } = await mountCard(c.open);
        c.fill();
        card().querySelector(c.save).click();
        await vi.waitFor(() => expect(card().querySelector(".aikm-error")?.textContent).toContain("Anthropic said no"));
        expect(isSettled()).toBe(false);
        expect(cancelButton().disabled).toBe(false);
        cancelButton().click();
        expect(await result).toBe(c.cancelled);
      });
    });
  }
});
