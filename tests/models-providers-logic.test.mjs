// @vitest-environment jsdom

// Settings > Models & providers: the provider table, the role-kind table, the
// rule read/write helpers, the sheet's reducer, the card honesty about unset
// fields, the keyed list's motion hooks, and the Endpoint-kind sweep over the
// places that used to read "not API credit" as "has plan usage".

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));

const meta = await import("../src/shared/provider-meta.ts");
const kinds = await import("../src/shared/routing-kinds.ts");
const rules = await import("../src/shared/routing-rules.ts");
const sheet = await import("../src/views/settings/subviews/models-providers/role-sheet.ts");
const cards = await import("../src/views/settings/subviews/models-providers/role-cards.ts");
const rows = await import("../src/views/settings/subviews/models-providers/account-rows.ts");
const keyed = await import("../src/views/settings/subviews/models-providers/keyed-list.ts");
const modals = await import("../src/views/settings/subviews/models-providers/provider-modals.ts");
const chip = await import("../src/shared/account-chip.ts");
const overlay = await import("../src/views/overlay/overlay-logic.ts");
const picker = await import("../src/shared/change-account-modal.ts");

const SUB = { id: "s", label: "Claude personal", icon: "user", colour: "#8b5cf6", kind: "subscription", email: "j@x.com" };
const CREDIT = { id: "c", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit", email: "j@x.com" };
const KIMI = { id: "k", label: "Kimi Code", icon: "key", colour: "#fff", kind: "endpoint", endpoint: { preset: "kimi_code", base_url: "https://api.kimi.ai/coding/", auth_style: "bearer", models: ["k3.1-pro", "kimi-for-coding"] } };
const OR = { id: "o", label: "OpenRouter", icon: "key", colour: "#fff", kind: "endpoint", endpoint: { preset: "openrouter", base_url: "https://openrouter.ai/api", auth_style: "bearer", models: [] } };
const ACCOUNTS = [SUB, CREDIT, KIMI, OR];
const CTX = { accounts: ACCOUNTS, claudeModels: ["haiku", "sonnet", "opus", "fable"] };

describe("provider meta", () => {
  it("names every provider's badge", () => {
    expect(meta.PROVIDER_META.claude.badge).toBe("Subscription");
    expect(meta.PROVIDER_META.kimi_code.badge).toBe("Subscription");
    expect(meta.PROVIDER_META.deepseek.badge).toBe("Pay per token");
    expect(meta.PROVIDER_META.openrouter.badge).toBe("Pay per token");
    expect(meta.PROVIDER_META.api_credit.badge).toBe("Included credit");
  });

  it("resolves an account to its provider, a missing kind being a subscription", () => {
    expect(meta.providerIdOf({})).toBe("claude");
    expect(meta.providerIdOf(CREDIT)).toBe("api_credit");
    expect(meta.providerIdOf(KIMI)).toBe("kimi_code");
    expect(meta.providerIdOf({ kind: "endpoint" })).toBe("custom");
  });

  it("keeps a Claude plan's own icon and colour but draws an endpoint from the table", () => {
    expect(meta.accountLook(SUB)).toEqual({ icon: "ph ph-user", colour: "#8b5cf6", badge: "Subscription" });
    expect(meta.accountLook(KIMI).colour).toBe(meta.PROVIDER_META.kimi_code.colour);
    expect(meta.accountLook(KIMI).icon).toBe("ph-fill ph-moon-stars");
  });

  it("prefills each preset with its URL, auth style and models", () => {
    expect(meta.ENDPOINT_PRESETS.kimi_code).toEqual({ baseUrl: "https://api.kimi.ai/coding/", authStyle: "bearer", models: ["k3.1-pro", "kimi-for-coding"] });
    expect(meta.ENDPOINT_PRESETS.deepseek.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(meta.ENDPOINT_PRESETS.openrouter.models).toEqual([]);
  });
});

describe("routing kinds", () => {
  it("lists the thirteen kinds the daemon knows, with the board's icons", () => {
    expect(kinds.ROUTING_KINDS.map((k) => k.id)).toEqual(["main_chat", "new_chat", "talk", "plan", "build", "review", "release", "fix", "gate", "test", "triage", "research", "errand"]);
    const icon = (id) => kinds.routingKind(id).icon;
    expect(icon("main_chat")).toBe("ph ph-chat-circle-dots");
    expect(icon("fix")).toBe("ph ph-bandaids");
    expect(icon("gate")).toBe("ph ph-git-merge");
    expect(icon("errand")).toBe("ph ph-briefcase");
  });

  it("only jobs can be flexed by the main chat", () => {
    expect(kinds.isJobKind("build")).toBe(true);
    expect(kinds.isJobKind("main_chat")).toBe(false);
    expect(kinds.isJobKind("new_chat")).toBe(false);
  });
});

describe("rule read and write", () => {
  it("sets a rule without touching its input and drops empty fields", () => {
    const before = { groups: { personal: { plan: { model: "opus" } } } };
    const after = rules.writeRule(before, "personal", "build", { account_id: "k", model: "", effort: undefined });
    expect(after.groups.personal.build).toEqual({ account_id: "k" });
    expect(after.groups.personal.plan).toEqual({ model: "opus" });
    expect(before.groups.personal.build).toBeUndefined();
  });

  it("removes a rule on null or when nothing is left", () => {
    const base = { groups: { client: { build: { model: "sonnet" } } } };
    expect(rules.readRule(rules.writeRule(base, "client", "build", null), "client", "build")).toBeUndefined();
    expect(rules.readRule(rules.writeRule(base, "client", "build", { model: "" }), "client", "build")).toBeUndefined();
  });

  it("creates the group on first write and reads an absent routing as no rule", () => {
    expect(rules.writeRule(undefined, "personal", "fix", { effort: "low" }).groups.personal.fix).toEqual({ effort: "low" });
    expect(rules.readRule(undefined, "personal", "fix")).toBeUndefined();
  });

  it("keeps a range that is switched on even when every bound is empty", () => {
    expect(rules.normalizeRule({ range: {} })).toEqual({ range: {} });
  });

  it("reads an unset payment group as personal", () => {
    expect(rules.projectGroup({})).toBe("personal");
    expect(rules.projectGroup({ payment_group: "client" })).toBe("client");
  });

  it("fills effort bars out of the account's own ladder, none for default or an off-ladder value", () => {
    expect(rules.effortFill(undefined, SUB)).toEqual({ filled: 0, of: 0 });
    expect(rules.effortFill("low", SUB)).toEqual({ filled: 1, of: 5 });
    expect(rules.effortFill("max", SUB)).toEqual({ filled: 5, of: 5 });
    expect(rules.effortFill("high", undefined)).toEqual({ filled: 3, of: 5 });
    // An endpoint offers three levels, so its top one is a full row of bars, never 3 of 5.
    expect(rules.effortFill("high", KIMI)).toEqual({ filled: 3, of: 3 });
    expect(rules.effortFill("low", KIMI)).toEqual({ filled: 1, of: 3 });
    // "max" is not a rung of an endpoint's ladder: label only.
    expect(rules.effortFill("max", KIMI)).toEqual({ filled: 0, of: 0 });
  });

  it("offers Claude families on a Claude or default account and the list on an endpoint", () => {
    expect(rules.modelChoices(SUB, CTX.claudeModels)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(rules.modelChoices(undefined, CTX.claudeModels)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(rules.modelChoices(KIMI)).toEqual(["k3.1-pro", "kimi-for-coding"]);
    expect(rules.effortChoices(KIMI)).toEqual(["low", "medium", "high"]);
  });

  it("validates a free-text model id like the daemon", () => {
    expect(rules.isValidEndpointModelId("my/model:7b")).toBe(true);
    expect(rules.isValidEndpointModelId("-flag")).toBe(false);
    expect(rules.isValidEndpointModelId("has space")).toBe(false);
    expect(rules.isValidEndpointModelId("a".repeat(129))).toBe(false);
  });

  it("drops what the new account cannot serve when the account changes", () => {
    const rule = { account_id: "s", model: "opus", effort: "xhigh", range: { min_model: "sonnet" }, fallback: { kind: "account", account_id: "k" } };
    const next = rules.withAccount(rule, "k", KIMI, CTX.claudeModels);
    expect(next).toEqual({ account_id: "k" });
    const keep = rules.withAccount({ account_id: "s", model: "sonnet", effort: "low" }, "s", SUB, CTX.claudeModels);
    expect(keep).toEqual({ account_id: "s", model: "sonnet", effort: "low" });
  });

  it("starts a range from everything the account offers", () => {
    expect(rules.fullRange(SUB, CTX.claudeModels)).toEqual({ min_model: "haiku", max_model: "fable", min_effort: "low", max_effort: "max" });
    expect(rules.fullRange(KIMI)).toEqual({ min_model: "k3.1-pro", max_model: "kimi-for-coding", min_effort: "low", max_effort: "high" });
    expect(rules.fullRange(OR)).toEqual({ min_effort: "low", max_effort: "high" });
  });

  it("round-trips the fallback select value", () => {
    expect(rules.parseFallback("wait")).toEqual({ kind: "wait" });
    expect(rules.parseFallback("account:k")).toEqual({ kind: "account", account_id: "k" });
    expect(rules.parseFallback("")).toBeUndefined();
    expect(rules.fallbackValue({ kind: "account", account_id: "k" })).toBe("account:k");
    expect(rules.fallbackValue(undefined)).toBe("");
  });
});

describe("role sheet reducer", () => {
  it("setting a model, an effort and a fallback each edits one field", () => {
    let r = {};
    r = sheet.applySheetChange(r, "sh-acc", "k", false, CTX).rule;
    r = sheet.applySheetChange(r, "sh-model", "k3.1-pro", false, CTX).rule;
    r = sheet.applySheetChange(r, "sh-eff", "high", false, CTX).rule;
    r = sheet.applySheetChange(r, "sh-then", "wait", false, CTX).rule;
    expect(r).toEqual({ account_id: "k", model: "k3.1-pro", effort: "high", fallback: { kind: "wait" } });
    r = sheet.applySheetChange(r, "sh-model", "", false, CTX).rule;
    expect(r.model).toBeUndefined();
  });

  it("an account change asks for a redraw", () => {
    expect(sheet.applySheetChange({}, "sh-acc", "s", false, CTX).redraw).toBe(true);
  });

  it("Other model id opens the field without saving, a valid id saves, a bad one reports", () => {
    const base = { account_id: "k" };
    expect(sheet.applySheetChange(base, "sh-model", sheet.OTHER_MODEL, false, CTX)).toEqual({ rule: base, otherOpen: true });
    expect(sheet.applySheetChange(base, "sh-model-other", " my-model ", false, CTX).rule.model).toBe("my-model");
    const bad = sheet.applySheetChange(base, "sh-model-other", "-x", false, CTX);
    expect(bad.modelError).toBeTruthy();
    expect(bad.rule).toBe(base);
  });

  it("the switch writes the full range and clears it", () => {
    const on = sheet.applySheetChange({ account_id: "s" }, "sh-flex", "on", true, CTX).rule;
    expect(on.range).toEqual({ min_model: "haiku", max_model: "fable", min_effort: "low", max_effort: "max" });
    const moved = sheet.applySheetChange(on, "sh-mnM", "sonnet", false, CTX).rule;
    expect(moved.range.min_model).toBe("sonnet");
    expect(moved.range.max_model).toBe("fable");
    expect(sheet.applySheetChange(moved, "sh-flex", "on", false, CTX).rule.range).toBeUndefined();
  });

  it("never mutates the rule it is given", () => {
    const r = Object.freeze({ account_id: "s", model: "opus" });
    expect(() => sheet.applySheetChange(r, "sh-eff", "low", false, CTX)).not.toThrow();
    expect(() => sheet.applySheetChange(r, "sh-acc", "k", false, CTX)).not.toThrow();
  });

  it("the body shows range controls only for a job, and Other only on an endpoint", () => {
    const job = sheet.sheetBodyHtml("build", { account_id: "k" }, CTX, false);
    const chat = sheet.sheetBodyHtml("main_chat", { account_id: "s" }, CTX, false);
    expect(job).toContain('id="sh-flex"');
    expect(chat).not.toContain('id="sh-flex"');
    expect(job).toContain("Other model id...");
    expect(chat).not.toContain("Other model id...");
    expect(chat).not.toContain(">Use Claude personal<");
    expect(job).not.toContain("coming soon");
    expect(job).toContain("When the account hits its limit");
  });

  it("an id off the endpoint's list reads as Other with the id in the field", () => {
    const html = sheet.sheetBodyHtml("build", { account_id: "k", model: "custom-7b" }, CTX, false);
    expect(html).toContain(`value="custom-7b"`);
    expect(html).toMatch(/<option value="__other__" selected>/);
  });

  it("API credit is never offered to a rule", () => {
    expect(sheet.sheetBodyHtml("build", {}, CTX, false)).not.toContain("API credit");
  });
});

describe("cards say Default honestly", () => {
  it("a kind with no rule shows Default and no invented value", () => {
    const v = cards.ruleView(undefined, ACCOUNTS);
    expect(v.isDefault).toBe(true);
    const html = cards.cardHtml(kinds.routingKind("build"), undefined, ACCOUNTS, "personal");
    expect(html).toContain("<b>Default</b>");
    expect(html).toContain("Same as today");
    expect(html).not.toContain("mp-card-foot");
    expect(html).not.toContain("mp-eff");
    expect(html).not.toContain("At its limit");
    expect(v.level).toBe(0);
  });

  it("draws every bar at the highest level the account offers, and none when there is no ladder position", () => {
    const bars = (html) => [(html.match(/<i class="f"><\/i>/g) ?? []).length, (html.match(/<i class="(f)?"><\/i>/g) ?? []).length];
    const kind = kinds.routingKind("build");
    expect(bars(cards.cardHtml(kind, { account_id: "k", effort: "high" }, ACCOUNTS, "personal"))).toEqual([3, 3]);
    expect(bars(cards.cardHtml(kind, { account_id: "s", effort: "max" }, ACCOUNTS, "personal"))).toEqual([5, 5]);
    expect(bars(cards.cardHtml(kind, { account_id: "s", effort: "high" }, ACCOUNTS, "personal"))).toEqual([3, 5]);
    const none = cards.cardHtml(kind, { account_id: "s", model: "opus" }, ACCOUNTS, "personal");
    expect(none).not.toContain("mp-pips");
    expect(none).toContain("<small>default</small>");
  });

  it("a partial rule shows Default for each field it leaves unset", () => {
    const v = cards.ruleView({ effort: "high" }, ACCOUNTS);
    expect(v.accountText).toBe("Default account");
    expect(v.modelText).toBe("Default model");
    expect(v.level).toBe(3);
  });

  it("a rule naming a removed account says so and a model shows the endpoint's id", () => {
    expect(cards.ruleView({ account_id: "gone" }, ACCOUNTS).accountText).toBe("Removed account");
    expect(cards.ruleView({ account_id: "k", model: "k3.1-pro" }, ACCOUNTS).modelText).toBe("k3.1-pro");
  });

  it("the limit line follows the stored fallback", () => {
    expect(cards.ruleView({ fallback: { kind: "wait" } }, ACCOUNTS).fallbackText).toBe("At its limit: wait");
    expect(cards.ruleView({ fallback: { kind: "account", account_id: "s" } }, ACCOUNTS).fallbackText).toBe("At its limit: Claude personal");
    expect(cards.ruleView({ model: "opus" }, ACCOUNTS).fallbackText).toBe("At its limit: not set");
  });

  it("escapes a label so an account name never becomes markup", () => {
    const html = cards.cardHtml(kinds.routingKind("plan"), { account_id: "x" }, [{ ...SUB, id: "x", label: "<img src=x>" }], "personal");
    expect(html).not.toContain("<img");
    expect(rows.accountRowHtml({ ...SUB, label: "<b>x</b>" })).not.toContain("<b>x</b>");
  });

  it("draws one card per kind, in two groups", () => {
    const html = cards.cardsHtml("personal", undefined, ACCOUNTS);
    expect((html.match(/class="mp-card[ "]/g) ?? []).length).toBe(13);
    expect(html).toContain("Chats you talk to");
    expect(html).toContain("Jobs subs do");
  });
});

describe("account rows", () => {
  it("offers Replace API key on a key account and Reauth on a plan", () => {
    expect(rows.accountRowHtml(KIMI)).toContain('data-act="key"');
    expect(rows.accountRowHtml(KIMI)).not.toContain('data-act="reauth"');
    expect(rows.accountRowHtml(SUB)).toContain('data-act="reauth"');
    expect(rows.accountRowHtml(CREDIT)).toContain('data-act="key"');
  });

  it("names the host and model count of an endpoint", () => {
    expect(rows.accountRowHtml(KIMI)).toContain("api.kimi.ai · 2 models");
    expect(rows.accountRowHtml(OR)).toContain("any model id");
  });
});

describe("keyed list", () => {
  const mk = () => document.createElement("div");
  const item = (key, text = key) => ({ key, html: `<div class="r">${text}</div>` });

  it("leaves an unchanged row alone, enters a new one folded and replaces a changed one in place", () => {
    const host = mk();
    keyed.patchKeyedList(host, [item("a"), item("b")], {}, false);
    const [a, b] = Array.from(host.children);
    expect(a.classList.contains("is-entering")).toBe(false);
    keyed.patchKeyedList(host, [item("a"), item("b", "B2"), item("c")]);
    expect(host.children[0]).toBe(a);
    expect(host.children[1]).toBe(b);
    expect(b.textContent).toBe("B2");
    expect(host.children[2].classList.contains("is-entering")).toBe(true);
  });

  it("marks a removed row leaving, keeps it in place and drops it when the transition ends", () => {
    vi.useFakeTimers();
    const host = mk();
    keyed.patchKeyedList(host, [item("a"), item("b")], {}, false);
    const [a, b] = Array.from(host.children);
    keyed.patchKeyedList(host, [item("b")]);
    expect(a.classList.contains("is-leaving")).toBe(true);
    expect(a.parentNode).toBe(host);
    a.dispatchEvent(new Event("transitionend"));
    expect(a.parentNode).toBeNull();
    expect(host.children[0]).toBe(b);
    vi.useRealTimers();
  });

  it("falls back to a timer when no transition ever ends", () => {
    vi.useFakeTimers();
    const host = mk();
    keyed.patchKeyedList(host, [item("a")], {}, false);
    const a = host.children[0];
    keyed.patchKeyedList(host, []);
    vi.advanceTimersByTime(500);
    expect(a.parentNode).toBeNull();
    vi.useRealTimers();
  });

  it("reorders to the new order and runs the wiring hooks for new and replaced rows only", () => {
    const host = mk();
    const wired = [];
    const gone = [];
    const hooks = { onRow: (r) => wired.push(r.textContent), onGone: (r) => gone.push(r.textContent) };
    keyed.patchKeyedList(host, [item("a"), item("b")], hooks, false);
    expect(wired).toEqual(["a", "b"]);
    keyed.patchKeyedList(host, [item("b"), item("a"), item("c", "C")], hooks);
    expect(Array.from(host.children).map((c) => c.dataset.key)).toEqual(["b", "a", "c"]);
    expect(wired).toEqual(["a", "b", "C"]);
    keyed.patchKeyedList(host, [item("b"), item("a"), item("c", "C2")], hooks);
    expect(gone).toEqual(["C"]);
  });
});

describe("model id parsing", () => {
  it("splits on commas and newlines, trims and de-duplicates", () => {
    expect(modals.parseModelIds("big, small,\n big ,, tiny")).toEqual(["big", "small", "tiny"]);
    expect(modals.parseModelIds("")).toEqual([]);
  });

  it("names the first id the CLI could read as a flag or choke on", () => {
    expect(modals.firstBadModelId(["ok", "-x", "also bad"])).toBe("-x");
    expect(modals.firstBadModelId(["a/b:c", "d[1m]"])).toBeNull();
  });
});

describe("Endpoint kind sweep", () => {
  it("only a plan account has plan usage and a plan to switch to", () => {
    expect(chip.isPlanAccount(SUB)).toBe(true);
    expect(chip.isPlanAccount({})).toBe(true);
    expect(chip.isPlanAccount(CREDIT)).toBe(false);
    expect(chip.isPlanAccount(KIMI)).toBe(false);
    expect(chip.isEndpointAccount(KIMI)).toBe(true);
    expect(chip.linkedPlanAccount({ email: "j@x.com" }, [KIMI, SUB])).toBe(SUB);
  });

  it("an endpoint account gets no overlay dial and no phone dial", () => {
    expect(overlay.buildOverlayRows(ACCOUNTS, {}).map((r) => r.id ?? r.accountId)).toHaveLength(1);
    const entries = overlay.buildOverlayEntries(ACCOUNTS, {}, {});
    expect(entries.map((e) => e.kind)).toEqual(["plan", "credit"]);
  });

  it("the account picker lists endpoints under their own label, with no limit slot", () => {
    const html = picker.renderAccountListBodyHtml(ACCOUNTS, "s", { usage: {}, credit: {} });
    expect(html).toContain("Other providers");
    expect(html).toContain("Kimi Code");
    expect(picker.limitSlotHtml(KIMI, { usage: {}, credit: {} })).toBe("");
  });
});
