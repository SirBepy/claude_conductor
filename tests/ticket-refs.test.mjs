// @vitest-environment jsdom

// Ticket ids in a chat message link to the project's tracker, and only ids
// that tracker actually uses: Linear keys come from the workspace's own teams,
// and a bare Shortcut number links only as a whole inline-code span.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { applyTicketLinks, linkifyTickets, parseTicketUrl, ticketCardHtml, forgetTicketTracker } = await import(
  "../src/shared/chat/ticket-refs.ts"
);

const SC = { kind: "shortcut", workspace: "zirtue", team_keys: [], inferred: true };
const LI = { kind: "linear", workspace: "revaire", team_keys: ["MOB", "REV"], inferred: true };

function mount(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const links = (root) => [...root.querySelectorAll("a.ticket-ref")].map((a) => [a.textContent, a.getAttribute("href")]);

describe("applyTicketLinks", () => {
  it("links sc- ids in prose and inline code to the workspace's story URL", () => {
    const root = mount("<p>Fixed in SC-55411 and <code>sc-12</code>.</p>");
    applyTicketLinks(root, SC);
    expect(links(root)).toEqual([
      ["sc-55411", "https://app.shortcut.com/zirtue/story/55411"],
      ["sc-12", "https://app.shortcut.com/zirtue/story/12"],
    ]);
    expect(root.textContent).toBe("Fixed in sc-55411 and sc-12.");
  });

  it("links a bare Shortcut number only as a whole inline-code span", () => {
    const root = mount("<p>Processed 55411 rows, see <code>55412</code> and <code>55413 x</code></p>");
    applyTicketLinks(root, SC);
    expect(links(root)).toEqual([["55412", "https://app.shortcut.com/zirtue/story/55412"]]);
  });

  it("leaves existing links, fenced code and look-alikes alone", () => {
    const root = mount('<p><a href="https://x.dev">sc-1</a> path/sc-2 sc-3x</p><pre><code>sc-4</code></pre>');
    applyTicketLinks(root, SC);
    expect(links(root)).toEqual([]);
  });

  it("links only the Linear workspace's own team keys", () => {
    const root = mount("<p>MOB-12 and REV-7, but not UTF-8 or SHA-256</p>");
    applyTicketLinks(root, LI);
    expect(links(root)).toEqual([
      ["MOB-12", "https://linear.app/revaire/issue/MOB-12"],
      ["REV-7", "https://linear.app/revaire/issue/REV-7"],
    ]);
  });

  it("links nothing for Linear when no team keys are known", () => {
    const root = mount("<p>MOB-12</p>");
    applyTicketLinks(root, { ...LI, team_keys: [] });
    expect(links(root)).toEqual([]);
  });
});

describe("linkifyTickets", () => {
  beforeEach(() => invokeMock.mockReset());

  it("asks for a repo's tracker once, then links synchronously from the cache", async () => {
    invokeMock.mockResolvedValueOnce(SC);
    const first = mount("<p>sc-1</p>");
    await linkifyTickets(first, "C:/zirtue");
    const second = mount("<p>sc-2</p>");
    await linkifyTickets(second, "C:/zirtue");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_ticket_tracker", { cwd: "C:/zirtue" });
    expect(links(second)).toHaveLength(1);
  });

  it("links nothing in a repo with no tracker, and re-asks after forgetTicketTracker", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const root = mount("<p>sc-1</p>");
    await linkifyTickets(root, "C:/personal");
    expect(links(root)).toEqual([]);
    forgetTicketTracker("C:/personal");
    invokeMock.mockResolvedValueOnce(SC);
    await linkifyTickets(root, "C:/personal");
    expect(links(root)).toHaveLength(1);
  });
});

describe("parseTicketUrl + card", () => {
  it("recognizes Shortcut and Linear ticket URLs, and nothing else", () => {
    expect(parseTicketUrl("https://app.shortcut.com/zirtue/story/55411/some-slug")).toEqual({ kind: "shortcut", workspace: "zirtue", id: "sc-55411" });
    expect(parseTicketUrl("https://linear.app/revaire/issue/MOB-12/title")).toEqual({ kind: "linear", workspace: "revaire", id: "MOB-12" });
    expect(parseTicketUrl("https://github.com/x/y/issues/12")).toBeNull();
  });

  it("escapes every field the tracker returned", () => {
    const html = ticketCardHtml({ id: "sc-1", title: "<img src=x>", state: "Ready", owner: null, ticket_type: "bug", url: "" });
    expect(html).not.toContain("<img");
    expect(html).toContain("Unassigned");
  });
});
