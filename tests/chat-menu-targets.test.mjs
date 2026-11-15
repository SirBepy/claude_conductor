// @vitest-environment jsdom
// asserts: src/shared/chat/chat-menu-target.ts, src/views/sessions/chat-menu-open.ts, src/views/sessions/chat-dashboard/sub-avatar.ts, src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/finished-tray.ts, src/views/sessions/permission-modal/question-ui-templates.ts, src/views/sessions/permission-modal/asker-face.ts, src/views/sessions/sub-list.ts, src/shared/chat/chat-message-card.ts, src/shared/chat/chat-subchat-card.ts, src/shared/chat/author-message-group.ts, src/views/history/history-render.ts, src/views/command-palette/palette-ui.ts, src/views/command-palette/sources.ts

// Joe, 2026-11-15: a right-click on anything that stands for a chat (an avatar, a name, a
// link) opens that chat's menu, never the browser's own, on every surface. One document-level
// handler keyed on `data-chat-menu-id` does it; this file proves the handler and then sweeps
// every surface class that draws a chat, so a surface that stops tagging fails here.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/shared/projects.ts", () => ({ hydrateCharacterAvatars: vi.fn(async () => {}), hydrateProjectTechIcons: vi.fn(async () => {}) }));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};
const target = await import("../src/shared/chat/chat-menu-target.ts");
const { state } = await import("../src/views/sessions/state.ts");

// vitest runs from the repo root; jsdom replaces the global URL, so import.meta.url is not usable here.
const read = (rel) => readFileSync(join(process.cwd(), rel), "utf8");
const ATTR = "data-chat-menu-id";

function mount(html) {
  document.body.innerHTML = html;
  return document.body;
}

/** Fires a contextmenu on `el` the way the browser does: bubbling, cancelable. */
function rightClick(el) {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = "";
  target.setChatMenuOpener(null);
});

describe("the delegated chat-menu handler", () => {
  it("opens the tagged chat's menu from any child of the tagged element and cancels the native menu", () => {
    const open = vi.fn();
    target.setChatMenuOpener(open);
    const body = mount(`<span ${ATTR}="sub-1"><b class="name">name</b></span>`);
    const e = rightClick(body.querySelector(".name"));
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe("sub-1");
    expect(open.mock.calls[0][1]).toBe(body.querySelector(`[${ATTR}]`));
  });

  it("still cancels the native menu when no menu can open (chat gone, nothing registered)", () => {
    const body = mount(`<span ${ATTR}="sub-1">x</span>`);
    expect(rightClick(body.firstElementChild).defaultPrevented).toBe(true);
  });

  it("leaves an untagged element and a text field alone", () => {
    const open = vi.fn();
    target.setChatMenuOpener(open);
    const body = mount(`<p class="plain">x</p><span ${ATTR}="sub-1"><input class="field"></span>`);
    expect(rightClick(body.querySelector(".plain")).defaultPrevented).toBe(false);
    expect(rightClick(body.querySelector(".field")).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open a second menu when the surface's own handler already did", () => {
    const open = vi.fn();
    target.setChatMenuOpener(open);
    const body = mount(`<button ${ATTR}="sub-1" class="own">x</button>`);
    body.querySelector(".own").addEventListener("contextmenu", (e) => e.preventDefault());
    rightClick(body.querySelector(".own"));
    expect(open).not.toHaveBeenCalled();
  });

  it("cancels the native menu on the chat menu itself (the double menu in Joe's screenshot)", () => {
    const body = mount(`<div class="session-ctx-menu sx-menu"><button class="item">Open</button></div><div class="chat-menu-submenu"><button class="sub">x</button></div><div class="session-more-menu"><button class="kebab">x</button></div><div class="session-more-menu usage-detail-menu"><p class="usage-text">12%</p></div>`);
    expect(rightClick(body.querySelector(".kebab")).defaultPrevented).toBe(true);
    // The usage popup holds text worth copying, so it keeps the webview's own menu.
    expect(rightClick(body.querySelector(".usage-text")).defaultPrevented).toBe(false);
    expect(rightClick(body.querySelector(".item")).defaultPrevented).toBe(true);
    expect(rightClick(body.querySelector(".sub")).defaultPrevented).toBe(true);
  });

  it("yields to a card's own 'Shown badly' menu: a sub's name on a card opens the chat menu, the rest of the card still flags", async () => {
    const { createShownBadlyContextMenu } = await import("../src/shared/chat/shown-badly.ts");
    const open = vi.fn();
    target.setChatMenuOpener(open);
    const messages = [{ kind: "message", id: "m1", card: { kind: "report" } }];
    const body = mount(`<div class="host"><div class="mc-root" data-msg-id="m1"><span class="mc-sub" ${ATTR}="sub-1"><b class="tagged">Header</b></span><p class="rest">text</p></div></div>`);
    // The transcript container installs this handler, so it runs before the document's.
    body.querySelector(".host").addEventListener("contextmenu", createShownBadlyContextMenu(() => ({ sessionId: "main", messages })));
    const onTag = rightClick(body.querySelector(".tagged"));
    expect(onTag.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    // The same card elsewhere still gets Shown badly, which cancels the event itself and opens no chat menu.
    open.mockClear();
    expect(rightClick(body.querySelector(".rest")).defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("escapes the id and marks nothing for a card about no chat", () => {
    expect(target.chatMenuAttr('a"b')).toBe(` ${ATTR}="a&quot;b"`);
    expect(target.chatMenuAttr("")).toBe("");
    expect(target.chatMenuAttr(null)).toBe("");
    expect(target.chatMenuAttr(undefined)).toBe("");
  });
});

describe("what a right-click opens (chat-menu-open)", () => {
  const row = (session_id, name, extra = {}) => ({ session_id, name, model: "claude-sonnet-4-5", effort: "high", busy: false, ...extra });

  it("a sub opens the Subchats card's menu, any other chat the sidebar row's, a gone chat nothing", async () => {
    const { openChatMenuFor } = await import("../src/views/sessions/chat-menu-open.ts");
    state.sessions = [row("main", "Main"), row("sub-1", "Sub one", { subchat_of: "main" }), row("solo", "Solo")];
    const anchor = document.body.appendChild(document.createElement("span"));

    openChatMenuFor("sub-1", anchor);
    const subMenu = document.querySelector(".session-ctx-menu.sx-menu");
    expect(subMenu?.dataset.sub).toBe("sub-1");
    expect(subMenu.textContent).toContain("Open in new window");
    expect(subMenu.textContent).toContain("Pin to sidemenu");

    openChatMenuFor("solo", anchor);
    // Opening the row menu after the sub menu leaves one menu up, not two.
    expect(document.querySelector(".sx-menu")).toBeNull();
    expect(document.querySelectorAll(".session-ctx-menu").length).toBe(1);

    openChatMenuFor("sub-1", anchor);
    expect(document.querySelectorAll(".session-ctx-menu").length).toBe(1);

    document.querySelectorAll(".session-ctx-menu").forEach((m) => m.remove());
    openChatMenuFor("nobody", anchor);
    expect(document.querySelector(".session-ctx-menu")).toBeNull();
  });

  it("a right-click on a Subchats card avatar closes the sidebar row's menu instead of stacking a second one", async () => {
    const { openChatMenuFor } = await import("../src/views/sessions/chat-menu-open.ts");
    const { SubsCard } = await import("../src/views/sessions/chat-dashboard/subs-card.ts");
    state.sessions = [row("main", "Main"), row("sub-1", "Sub one", { subchat_of: "main" }), row("solo", "Solo")];
    const anchor = document.body.appendChild(document.createElement("span"));
    openChatMenuFor("solo", anchor);
    expect(document.querySelectorAll(".session-ctx-menu").length).toBe(1);

    const host = document.body.appendChild(document.createElement("div"));
    const card = new SubsCard({ mainId: () => "main", cwd: () => null, sessions: () => state.sessions, openSub: () => {}, rerender: () => {} });
    const sub = { id: "sub-1", name: "Sub one", kind: "working", closing: false, model: "sonnet", effort: "high", progress: "Working", startedAt: null, finishedAt: null, ring: { kind: "solid", tone: "working" } };
    card.update(host, { shown: [sub], earlier: [], foldsAt: null });
    const e = rightClick(host.querySelector(".sx-av"));
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelectorAll(".session-ctx-menu").length).toBe(1);
    expect(document.querySelector(".session-ctx-menu.sx-menu")?.dataset.sub).toBe("sub-1");
  }, 60_000);

  it("is what the delegated handler calls", async () => {
    const { openChatMenuFor } = await import("../src/views/sessions/chat-menu-open.ts");
    // The module registers itself at load (asserted below); the earlier tests cleared the opener.
    target.setChatMenuOpener(openChatMenuFor);
    state.sessions = [row("main", "Main"), row("sub-1", "Sub one", { subchat_of: "main" })];
    const body = mount(`<span ${ATTR}="sub-1"><i class="face">SO</i></span>`);
    const e = rightClick(body.querySelector(".face"));
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector(".session-ctx-menu.sx-menu")?.dataset.sub).toBe("sub-1");
  });
});

/** True when `el` (or an ancestor) carries the chat id: a right-click there reaches the handler. */
const taggedWith = (el, id) => el?.closest?.(`[${ATTR}="${id}"]`) != null;

describe("surface sweep: every class that draws a chat avatar or name is tagged", () => {
  const item = {
    id: "sub-1", name: "Concept 4 gaps", kind: "asking", closing: false, model: "sonnet", effort: "high",
    progress: "Asking", startedAt: null, finishedAt: null, ring: { kind: "solid", tone: "question" }, hover: null,
  };

  it("question and permission card header: the sub's avatar and name, and the main chat's chip", async () => {
    const { fromChipHtml, askersStripHtml } = await import("../src/views/sessions/permission-modal/question-ui-templates.ts");
    const { askerFaceOf } = await import("../src/views/sessions/permission-modal/asker-face.ts");
    const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
    state.sessions = [row2("main", "Main"), row2("sub-1", "Concept 4 gaps", { subchat_of: "main" })];
    adoptSubchatsOn("main");

    const sub = askerFaceOf({ session_id: "sub-1", display_session_id: "main", sub_name: "Concept 4 gaps" });
    expect(sub.id).toBe("sub-1");
    const body = mount(fromChipHtml(sub));
    expect(taggedWith(body.querySelector(".prompt-from__face"), "sub-1")).toBe(true);
    expect(taggedWith(body.querySelector(".prompt-from__name"), "sub-1")).toBe(true);

    const main = askerFaceOf({ session_id: "main" });
    expect(main.id).toBe("main");
    expect(taggedWith(mount(fromChipHtml(main)).querySelector(".prompt-from__name"), "main")).toBe(true);

    // A face with no chat behind it draws no tag.
    expect(fromChipHtml({ name: "Orphan" })).not.toContain(ATTR);

    const strip = mount(askersStripHtml([
      { askerId: "main", label: "Main chat", count: 1, isMain: true, active: false },
      { askerId: "sub-1", label: "Concept 4 gaps", count: 2, isMain: false, active: true },
    ]));
    expect(taggedWith(strip.querySelector('[data-asker="sub-1"] .prompt-asker__name'), "sub-1")).toBe(true);
    expect(taggedWith(strip.querySelector('[data-asker="main"] .prompt-asker__name'), "main")).toBe(true);
  });

  it("Subchats card: a working sub's avatar and a stuck sub's whole row, name included", async () => {
    const { avatarHtml } = await import("../src/views/sessions/chat-dashboard/sub-avatar.ts");
    const { stuckRowHtml } = await import("../src/views/sessions/chat-dashboard/subs-card.ts");
    const av = avatarHtml(item, "", false);
    expect(taggedWith(mount(av).querySelector(".sx-face"), "sub-1")).toBe(true);
    const rowHtml = stuckRowHtml(item, av, false);
    const body = mount(rowHtml);
    expect(taggedWith(body.querySelector(".sx-item-name"), "sub-1")).toBe(true);
    expect(taggedWith(body.querySelector(".sx-item-why"), "sub-1")).toBe(true);
  }, 60_000);

  it("Finished subchats card: the row's avatar, verdict line and dismiss all open the sub's menu", async () => {
    const { renderFinished } = await import("../src/views/sessions/chat-dashboard/finished-tray.ts");
    const html = renderFinished(
      { items: [{ sub: { ...item, kind: "finished" }, report: null }] },
      { open: null, card: () => "", ctxChip: () => "" },
    );
    const body = mount(html);
    expect(taggedWith(body.querySelector(".sx-face"), "sub-1")).toBe(true);
    expect(taggedWith(body.querySelector(".ft-line"), "sub-1")).toBe(true);
    expect(taggedWith(body.querySelector(".ft-x"), "sub-1")).toBe(true);
  });

  it("header sub list (the phone's list of subs): each row", async () => {
    const { subListHtml } = await import("../src/views/sessions/sub-list.ts");
    const sub = { id: "sub-1", name: "Concept 4 gaps", kind: "working", progress: "Working", tier: "", closing: false, hover: null, startedAt: null };
    const body = mount(subListHtml([sub], [row2("sub-1", "Concept 4 gaps", { subchat_of: "main" })]));
    expect(taggedWith(body.querySelector(".sub-name"), "sub-1")).toBe(true);
    expect(taggedWith(body.querySelector(".sub-dot"), "sub-1")).toBe(true);
  });

  it("Messages view: the sub's name above its card and in its one-line form", async () => {
    const { renderMessageCard } = await import("../src/shared/chat/chat-message-card.ts");
    const m = { kind: "assistant", text: "Built, not pushed\n\nbody", card: { kind: "report", verdict: "Built, not pushed" } };
    const text = (s) => `<p>${s}</p>`;
    const full = mount(renderMessageCard(m, m.card, text, { tag: "Header", tagId: "sub-1", tagNote: "Sonnet high" }));
    expect(taggedWith(full.querySelector(".mc-sub-name"), "sub-1")).toBe(true);
    expect(mount(renderMessageCard(m, m.card, text, { tag: "Header" })).innerHTML).not.toContain(ATTR);
  });

  it("History list: each past chat's row", async () => {
    const { renderList } = await import("../src/views/history/history-render.ts");
    const list = document.body.appendChild(document.createElement("ul"));
    const now = new Date().toISOString();
    renderList(list, [{ session_id: "old-1", title: "Old chat", cwd: "C:/work/app", started_at: now, ended_at: now, model: "" }], null);
    expect(taggedWith(list.querySelector(".history-row-title"), "old-1")).toBe(true);
  });

  it("command palette: a chat row opens the chat's menu, a command row does not", async () => {
    const { openPalette, closePalette } = await import("../src/views/command-palette/palette-ui.ts");
    // jsdom draws no layout, so it has no scrollIntoView.
    Element.prototype.scrollIntoView = () => {};
    openPalette({
      sync: () => [
        { id: "chat:sub-1", title: "Sub one", group: "Chat", icon: "chat-circle", chatId: "sub-1", run() {} },
        { id: "setting:x", title: "A setting", group: "Settings", icon: "gear", run() {} },
      ],
      later: [],
      remember: false,
    });
    const rows = [...document.querySelectorAll(".cp-row")];
    const chat = rows.find((r) => r.textContent.includes("Sub one"));
    const setting = rows.find((r) => r.textContent.includes("A setting"));
    expect(taggedWith(chat, "sub-1")).toBe(true);
    expect(setting.closest(`[${ATTR}]`)).toBeNull();
    closePalette();
  }, 60_000);

  it("peer messages folded into a turn: the author's avatar and name", () => {
    const src = read("src/shared/chat/author-message-group.ts");
    expect(src).toMatch(/author-avatar \$\{colorClass\}"\$\{chatMenuAttr\(sessionId\)\}/);
    expect(src).toMatch(/author-group-row-name \$\{colorClass\}"\$\{chatMenuAttr\(id\)\}/);
  });

  // The remaining surfaces need a mounted card or panel; their builders are single template
  // lines, so the sweep reads the line. Each is also exercised by its own view spec.
  it.each([
    ["Answers card by-line", "src/views/sessions/chat-dashboard/answers-card.ts", /class="ax-by"\$\{chatMenuAttr\(a\.subId\)\}/],
    ["Todos panel from-chat label", "src/views/sessions/todos-panel.ts", /class="td-origin"\$\{chatMenuAttr\(t\.origin_session_id\)\}/],
    ["Shared mockup owner chips", "src/views/sessions/shared-mockup-bar.ts", /data-owner="\$\{escapeHtml\(c\.id\)\}"\$\{chatMenuAttr\(c\.id === SHELL_ID \? null : c\.id\)\}/],
    ["Shared mockup 'Only <sub>' tag", "src/views/sessions/shared-mockup-bar.ts", /markChatMenu\(kind, tag\.id\)/],
    ["Preview history owner line", "src/views/sessions/preview-panel-history.ts", /pv-snap-meta"\$\{chatMenuAttr\(tag\?\.id\)\}/],
    ["Open chat's header avatar and title", "src/views/sessions/subchat-view.ts", /session-header-avatar-wrap, \.title"\)\) markChatMenu\(el, sess\.session_id\)/],
    ["Sub peek card's name", "src/views/sessions/chat-dashboard/sub-peek.ts", /class="sx-det-name"\$\{chatMenuAttr\(id\)\}/],
    ["Sub card tag id reaches the card", "src/shared/chat/chat-subchat-card.ts", /tagId: entry\.sub_id/],
  ])("%s", (_name, file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  it("the sessions view loads the opener, which registers itself", () => {
    expect(read("src/views/sessions/sessions-dom-wiring.ts")).toContain('import "./chat-menu-open"');
    expect(read("src/views/sessions/chat-menu-open.ts")).toContain("setChatMenuOpener(openChatMenuFor)");
  });
});

function row2(session_id, name, extra = {}) {
  return { session_id, name, model: "claude-sonnet-4-5", effort: "high", busy: false, ...extra };
}
