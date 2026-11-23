// @vitest-environment jsdom

// A project's payment group block: the override helpers in routing-rules, the
// row and menu markup, and the shared sheet controller the project popup and
// Settings > Models & providers both mount.

import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));

const rules = await import("../src/shared/routing-rules.ts");
const rows = await import("../src/views/sessions/project-dashboard/project-config/override-rows.ts");
const cards = await import("../src/views/settings/subviews/models-providers/role-cards.ts");
const ctlMod = await import("../src/views/settings/subviews/models-providers/sheet-controller.ts");

const SUB = { id: "s", label: "Claude personal", icon: "user", colour: "#8b5cf6", kind: "subscription" };
const DS = { id: "d", label: "DeepSeek", icon: "key", colour: "#fff", kind: "endpoint", endpoint: { preset: "deepseek", base_url: "https://api.deepseek.com/anthropic", auth_style: "bearer", models: ["deepseek-v4-pro", "deepseek-flash"] } };
const ACCOUNTS = [SUB, DS];
const CTX = { accounts: ACCOUNTS, claudeModels: ["haiku", "sonnet", "opus", "fable"] };
const ORDER = ["main_chat", "build", "review"];

describe("override helpers", () => {
  it("writeOverride sets, replaces and removes a kind without touching its input", () => {
    const base = { build: { model: "opus" } };
    const set = rules.writeOverride(base, "review", { account_id: "d" });
    expect(set).toEqual({ build: { model: "opus" }, review: { account_id: "d" } });
    expect(base).toEqual({ build: { model: "opus" } });
    expect(rules.writeOverride(set, "build", null)).toEqual({ review: { account_id: "d" } });
    expect(rules.writeOverride(set, "build", {})).toEqual({ review: { account_id: "d" } });
  });

  it("overriddenKinds lists known kinds in the page's order, then unknown ones alphabetically", () => {
    const o = { review: { model: "a" }, zeta: { model: "a" }, build: { model: "a" }, alpha: { model: "a" }, gone: undefined };
    expect(rules.overriddenKinds(o, ORDER)).toEqual(["build", "review", "alpha", "zeta"]);
    expect(rules.overriddenKinds(undefined, ORDER)).toEqual([]);
  });

  it("seedOverride copies the group's rule, range included, and is empty without one", () => {
    const routing = { groups: { personal: { build: { model: "opus", range: { min_model: "sonnet" } } } } };
    const seed = rules.seedOverride(routing, "personal", "build");
    expect(seed).toEqual({ model: "opus", range: { min_model: "sonnet" } });
    seed.range.min_model = "haiku";
    expect(routing.groups.personal.build.range.min_model).toBe("sonnet");
    expect(rules.seedOverride(routing, "client", "build")).toEqual({});
  });

  it("the requested settings tab is handed over once", () => {
    rules.requestGroupTab("client");
    expect(rules.takeRequestedGroupTab()).toBe("client");
    expect(rules.takeRequestedGroupTab()).toBeNull();
  });
});

describe("override rows", () => {
  it("shows the override's model and what the group would have run", () => {
    const html = rows.overrideRowHtml("build", { account_id: "d", model: "deepseek-flash" }, { account_id: "s", model: "opus" }, ACCOUNTS);
    expect(html).toContain("<b>Build</b>");
    expect(html).toContain("<em>deepseek-flash</em>");
    expect(html).toContain("instead of Opus");
    expect(html).toContain('data-kind="build"');
  });

  it("names the account when the rule has no model, and 'the default' when the group has no rule", () => {
    const html = rows.overrideRowHtml("review", { account_id: "d" }, undefined, ACCOUNTS);
    expect(html).toContain("<em>DeepSeek</em>");
    expect(html).toContain("instead of the default");
    expect(cards.ruleShortText(undefined, ACCOUNTS)).toBe("the default");
  });

  it("a kind the page does not know still draws, under its own id", () => {
    const html = rows.overrideRowHtml("mystery", { model: "opus" }, undefined, ACCOUNTS);
    expect(html).toContain("<b>mystery</b>");
  });

  it("the menu offers only kinds not overridden, and says so when none are left", () => {
    const free = rows.freeKinds({ build: { model: "opus" } });
    expect(free).not.toContain("build");
    expect(free).toContain("review");
    const menu = rows.menuItemsHtml(free);
    expect(menu).not.toContain('data-kind="build"');
    expect(menu).toContain('data-kind="review"');
    expect(rows.menuItemsHtml([])).toContain("Every role is already changed");
  });

  it("names the groups for the select and the link", () => {
    expect(rows.GROUP_OPTION_LABELS.personal).toBe("Personal project");
    expect(rows.groupShortName("client")).toBe("Client");
    expect(rows.groupShortName("studio")).toBe("studio");
  });
});

describe("sheet controller", () => {
  // Hosts share ids: a leftover one in the document would answer the next test's #id lookups.
  afterEach(() => { document.body.innerHTML = ""; });

  function mount(rule) {
    const host = document.createElement("div");
    document.body.append(host);
    const seen = [];
    const ctl = ctlMod.mountSheetController(host, { kind: "build", rule, ctx: () => CTX, onRule: (r) => seen.push(r) });
    const change = (id, value) => {
      const el = host.querySelector(`#${id}`);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    return { host, ctl, seen, change };
  }

  it("paints the body and reports each accepted change as a normalized rule", () => {
    const { host, ctl, seen, change } = mount({ model: "opus" });
    expect(host.querySelector("#sh-model").value).toBe("opus");
    change("sh-eff", "high");
    expect(seen.at(-1)).toEqual({ model: "opus", effort: "high" });
    expect(ctl.rule()).toEqual({ model: "opus", effort: "high" });
    ctl.dispose();
  });

  it("an account change redraws the body and reports the rule without the model the new account lacks", () => {
    const { host, seen, change } = mount({ model: "opus" });
    change("sh-acc", "d");
    expect(seen.at(-1)).toEqual({ account_id: "d" });
    expect(host.querySelector("#sh-acc").value).toBe("d");
    expect([...host.querySelectorAll("#sh-model option")].map((o) => o.value)).toContain("deepseek-v4-pro");
  });

  it("a refused model id reports nothing", () => {
    const { host, seen, change } = mount({ account_id: "d" });
    change("sh-model", "__other__");
    change("sh-model-other", "bad id with spaces");
    expect(seen).toHaveLength(0);
    expect(host.querySelector("#sh-model-error").hidden).toBe(false);
  });

  it("an emptied rule reports null, setRule redraws without reporting, and dispose stops listening", () => {
    const { host, ctl, seen, change } = mount({ effort: "high" });
    change("sh-eff", "");
    expect(seen.at(-1)).toBeNull();
    ctl.setRule({ model: "sonnet" });
    expect(host.querySelector("#sh-model").value).toBe("sonnet");
    expect(seen).toHaveLength(1);
    ctl.dispose();
    change("sh-eff", "low");
    expect(seen).toHaveLength(1);
  });
});
