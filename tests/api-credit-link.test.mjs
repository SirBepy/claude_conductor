// @vitest-environment jsdom

// An API-credit account belongs to a plan account, linked by email: the helper
// that resolves the link, every place that names it, and the Add account flow's
// "which kind?" step.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));

const { linkedPlanAccount, linkedToLabel, apiCreditLinkedName } = await import("../src/shared/account-chip.ts");
const { runAddAccountFlow } = await import("../src/views/settings/subviews/accounts/add-account-flow.ts");
const { apiCreditMeterHtml } = await import("../src/views/dashboard/api-credit-meter.ts");
const { renderAccountFieldHtml } = await import("../src/views/sessions/account-field.ts");
const { renderAccountListBodyHtml } = await import("../src/shared/change-account-modal.ts");

const personal = { id: "p", label: "personal", icon: "user", colour: "#8b5cf6", kind: "subscription", email: "Joe@Example.com" };
const work = { id: "w", label: "work", icon: "briefcase", colour: "#f5a623", kind: "subscription", email: "joe@work.com" };
const credit = { id: "c", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit", email: "joe@example.com" };

describe("linkedPlanAccount", () => {
  it("matches the plan account with the same email", () => {
    expect(linkedPlanAccount(credit, [work, personal, credit])).toBe(personal);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(linkedPlanAccount({ email: "  JOE@EXAMPLE.COM " }, [personal])).toBe(personal);
  });

  it("links nothing for an empty or missing email", () => {
    expect(linkedPlanAccount({ email: "" }, [{ ...personal, email: "" }])).toBeNull();
    expect(linkedPlanAccount({}, [personal])).toBeNull();
    expect(linkedPlanAccount(null, [personal])).toBeNull();
  });

  it("returns null when no plan account shares the email", () => {
    expect(linkedPlanAccount({ email: "other@example.com" }, [personal, work])).toBeNull();
  });

  it("never links to another API-credit account", () => {
    expect(linkedPlanAccount(credit, [credit, { ...credit, id: "c2" }])).toBeNull();
  });
});

describe("where the link is named", () => {
  it("Settings line: plan label, else the raw email, else nothing", () => {
    expect(linkedToLabel(credit, [personal, credit])).toBe("Linked to personal");
    expect(linkedToLabel({ email: "x@y.com" }, [personal])).toBe("Linked to x@y.com");
    expect(linkedToLabel({ email: "" }, [personal])).toBe("");
  });

  it("apiCreditLinkedName falls back to plain 'API credit'", () => {
    expect(apiCreditLinkedName(credit, [personal])).toBe("API credit · personal");
    expect(apiCreditLinkedName({ email: "" }, [personal])).toBe("API credit");
  });

  it("dashboard meter line is labelled with the plan account when linked, its own label otherwise", () => {
    expect(apiCreditMeterHtml([personal, credit], {})).toContain("API credit · personal");
    const unlinked = { ...credit, email: "", label: "Spare key" };
    expect(apiCreditMeterHtml([personal, unlinked], {})).toContain("Spare key");
  });

  it("new-chat picker chip tooltip names the plan account", () => {
    const html = renderAccountFieldHtml({ accountId: "p" }, { accounts: [personal, credit] });
    expect(html).toContain('title="API credit · personal"');
  });

  it("change-account modal chip tooltip names the plan account", () => {
    const html = renderAccountListBodyHtml([personal, credit], "p");
    expect(html).toContain('title="API credit · personal"');
    expect(renderAccountListBodyHtml([personal, work], "p")).not.toContain("title=");
  });
});

describe("Add account flow", () => {
  function deps(over = {}) {
    return {
      remote: false,
      pickKind: vi.fn(async () => "subscription"),
      closeKindCard: vi.fn(),
      openWizard: vi.fn(async () => personal),
      openApiCredit: vi.fn(async () => credit),
      ...over,
    };
  }

  it("Claude plan closes the kind card and continues into the subscription wizard", async () => {
    const d = deps();
    expect(await runAddAccountFlow([work], d)).toBe(personal);
    expect(d.closeKindCard).toHaveBeenCalledOnce();
    expect(d.openWizard).toHaveBeenCalledWith([work]);
    expect(d.openApiCredit).not.toHaveBeenCalled();
  });

  it("API credit continues into the API-credit form on the same host card", async () => {
    const d = deps({ pickKind: vi.fn(async () => "api_credit") });
    expect(await runAddAccountFlow([work], d)).toBe(credit);
    expect(d.openApiCredit).toHaveBeenCalledOnce();
    expect(d.closeKindCard).not.toHaveBeenCalled();
    expect(d.openWizard).not.toHaveBeenCalled();
  });

  it("cancelling the choice opens nothing and closes the card", async () => {
    const d = deps({ pickKind: vi.fn(async () => null) });
    expect(await runAddAccountFlow([], d)).toBeNull();
    expect(d.closeKindCard).toHaveBeenCalledOnce();
    expect(d.openWizard).not.toHaveBeenCalled();
    expect(d.openApiCredit).not.toHaveBeenCalled();
  });

  it("on the phone the question is skipped and the wizard opens directly", async () => {
    const d = deps({ remote: true });
    expect(await runAddAccountFlow([work], d)).toBe(personal);
    expect(d.pickKind).not.toHaveBeenCalled();
    expect(d.openWizard).toHaveBeenCalledWith([work]);
  });
});
