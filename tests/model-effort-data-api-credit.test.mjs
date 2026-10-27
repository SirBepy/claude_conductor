import { describe, it, expect } from "vitest";
import { resolveModelEffortData } from "../src/views/sessions/model-effort-data.ts";

const sub = { id: "sub", label: "Plan", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const credit = { id: "api", label: "Credit", icon: "key", colour: "#f5a623", kind: "api_credit" };

const read = (value) => ({ cached: value, ready: Promise.resolve(value) });
// A getter, so the rejection only exists once the code under test awaits it.
const failing = () => ({
  cached: undefined,
  get ready() {
    return Promise.reject(new Error("no backend"));
  },
});

function source(preferred, projectAccountRead) {
  return {
    kind: "local",
    projectsRead: read([{ id: "p1", path: "C:/proj", preferred_account_id: preferred }]),
    accountsRead: read([sub, credit]),
    projectAccountRead,
  };
}

describe("resolveModelEffortData project binding", () => {
  it("ignores a raw stored binding to an API-credit account when the backend read fails", async () => {
    const data = await resolveModelEffortData("C:/proj", read({}), source("api", failing()));
    expect(data.preferredAccountId).toBeNull();
    expect(data.accountId).not.toBe("api");
  });

  it("ignores an API-credit binding even if the backend read still returns it", async () => {
    const data = await resolveModelEffortData("C:/proj", read({}), source("api", read("api")));
    expect(data.preferredAccountId).toBeNull();
  });

  it("keeps a subscription binding", async () => {
    const data = await resolveModelEffortData("C:/proj", read({}), source("sub", failing()));
    expect(data.preferredAccountId).toBe("sub");
  });
});
