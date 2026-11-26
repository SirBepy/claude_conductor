// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/quick-view.ts, src/views/sessions/chat-dashboard/chat-view-pref.ts

// Lane 4 of the chat dashboard, drawn: the Attachments card (Links, Files,
// Previews and Images tabs) with its three quick-view buttons and the read view
// they open, the preview rows that open the panel, the image rows that open the
// gallery, the figures beside an approval question, and the Changes card behind
// Joe's section switch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { setSettings } = await import("../src/shared/state.ts");
const { ChatDashboard } = await import("../src/views/sessions/chat-dashboard/chat-dashboard.ts");
const { readSections } = await import("../src/views/sessions/chat-dashboard/chat-view-pref.ts");
const { PREVIEW_OPEN_EVENT } = await import("../src/shared/chat/chat-preview-card.ts");
const { ATTACHMENT_SETTLED_EVENT } = await import("../src/shared/chat/attachment-hydrator.ts");

const SEND = "mcp__cc_conductor__send_message";
const PLAN = "mcp__cc_conductor__write_plan";
const ASK = "mcp__cc_conductor__ask_user_question";
let seq = 0;
const ok = (id) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "{}" }, is_error: false, timestamp: 0 });

/** Fake Tauri: every command answers from `answers` (a function or a value); the calls are kept. */
let calls = [];
let answers = {};
function installTauri() {
  calls = [];
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (!(cmd in answers)) throw new Error(`unmocked ${cmd}`);
        const a = answers[cmd];
        return typeof a === "function" ? a(args) : a;
      },
    },
    event: { listen: async () => () => {} },
  };
  resetTransportForTests();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.querySelectorAll(".cdash-qvm").forEach((e) => e.remove());
  answers = {};
  setSettings({});
  installTauri();
});

function mountPane() {
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell"><div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  const r = new ChatRenderer(pane.querySelector(".session-messages"));
  r.sessionId = "sess-1";
  return { pane, r };
}

const feed = (r, evs) => evs.forEach((e) => r.handleEvent(e));
const send = (input) => { const id = `m${++seq}`; return [toolUseEvent(SEND, input, id), ok(id)]; };
const plan = (steps) => { const id = `p${++seq}`; return [toolUseEvent(PLAN, { steps }, id), ok(id)]; };
const tool = (name, input) => { const id = `t${++seq}`; return [toolUseEvent(name, input, id), ok(id)]; };
const tick = (ms = 20) => new Promise((res) => setTimeout(res, ms));

const meta = (id, over = {}) => ({ id, slug: `slug-${id}`, title: `Title ${id}`, source: "chat", session_id: "sess-1", version: 1, created_at: "", published: null, versions: [], shared: false, ...over });

describe("Links and files", () => {
  it("lists links and files and carries the three quick-view buttons", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("ship the fix"),
      ...send({ kind: "artifact", text: "PR https://github.com/acme/app/pull/42 and the file C:\\proj\\src\\a.ts" }),
      ...tool("Edit", { file_path: "C:\\proj\\src\\b.ts", old_string: "a", new_string: "b" }),
    ]);
    await tick();
    const card = pane.querySelector(".cdash-links");
    expect(card).not.toBeNull();
    // The card opens on the first non-empty tab in the order Previews, Images, Files, Links: here Files; the link is one click away. Previews and
    // Images are tabs of the same card (pc-1805), muted while empty.
    expect(card.querySelector(".cdash-ltab[data-tab='images']").classList.contains("is-empty")).toBe(true);
    expect(card.querySelector(".cdash-ltab[data-tab='links']").classList.contains("is-empty")).toBe(false);
    expect([...card.querySelectorAll("[data-act='links-tab']")].map((b) => b.textContent)).toEqual(["Previews0", "Images0", "Files2", "Links1"]);
    expect(card.querySelector(".cdash-ltab.on").dataset.tab).toBe("files");
    expect(card.querySelectorAll(".file-ref")).toHaveLength(2);
    card.querySelector(".cdash-ltab[data-tab='links']").click();
    const link = pane.querySelector("a.cdash-link");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(link.textContent).toContain("PR #42");
    expect(link.querySelector(".cdash-lsub").textContent).toBe("github.com");
    pane.querySelector("[data-act='links-tab'][data-tab='files']").click();
    const files = pane.querySelector(".cdash-links");
    const chips = [...files.querySelectorAll(".file-ref")].map((c) => c.dataset.path);
    expect(chips).toEqual(expect.arrayContaining(["C:\\proj\\src\\a.ts", "C:\\proj\\src\\b.ts"]));
    // A file row shows the name only; the folder stays in the chip's tooltip.
    expect(files.querySelector(".cdash-frow .cdash-lsub")).toBeNull();
    expect([...files.querySelectorAll(".cdash-frow .file-ref-name")].map((n) => n.textContent)).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(files.querySelector(".cdash-touched")).not.toBeNull();
    expect(files.querySelectorAll("a.cdash-link")).toHaveLength(0);
    expect([...files.querySelectorAll("[data-act='quick-view']")].map((b) => b.dataset.view)).toEqual(["plan", "decided", "memory"]);
  });

  it("keeps the tab Joe picked across a redraw, and opens on Files when the chat has no link", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("edit it"),
      ...tool("Edit", { file_path: "C:\\proj\\src\\only.ts", old_string: "a", new_string: "b" }),
      ...send({ kind: "artifact", text: "done, see C:\\proj\\src\\only.ts" }),
    ]);
    await tick();
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("files");
    expect(pane.querySelectorAll(".cdash-links .file-ref")).toHaveLength(1);
    pane.querySelector("[data-act='links-tab'][data-tab='links']").click();
    expect(pane.querySelector(".cdash-llist .cdash-lnone").textContent).toBe("No links yet.");
    // A later message redraws the card from the model; the tab stays where Joe put it.
    feed(r, send({ kind: "artifact", text: "also https://github.com/acme/app/pull/7" }));
    await tick();
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("links");
    expect(pane.querySelector(".cdash-llist a.cdash-link").textContent).toContain("PR #7");
  });

  // The redraw replaces the tab that was used; keyboard focus follows to the tab
  // Joe picked, not to the first tab (pc-1745).
  it("a tab picked by keyboard keeps focus on itself after the redraw", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [
      userEvent("ship the fix"),
      ...send({ kind: "artifact", text: "PR https://github.com/acme/app/pull/42 and the file C:\\proj\\src\\a.ts" }),
    ]);
    await tick();
    const filesTab = pane.querySelector("[data-act='links-tab'][data-tab='files']");
    filesTab.focus();
    filesTab.click();
    expect(document.activeElement?.getAttribute("data-act")).toBe("links-tab");
    expect(document.activeElement?.getAttribute("data-tab")).toBe("files");
    const linksTab = pane.querySelector("[data-act='links-tab'][data-tab='links']");
    linksTab.focus();
    linksTab.click();
    expect(document.activeElement?.getAttribute("data-tab")).toBe("links");
  });

  it("a redraw of the same tab keeps the list's scroll position, and another tab starts at the top", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    const links = (n) => Array.from({ length: n }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`).join(" ");
    feed(r, [userEvent("ship"), ...send({ kind: "artifact", text: `many ${links(8)}` })]);
    await tick();
    pane.querySelector(".cdash-llist").scrollTop = 90;
    feed(r, send({ kind: "artifact", text: "one more https://github.com/acme/app/pull/99" }));
    await tick();
    expect(pane.querySelector(".cdash-llist a.cdash-link")).not.toBeNull();
    expect(pane.querySelector(".cdash-llist").scrollTop).toBe(90);
    pane.querySelector("[data-act='links-tab'][data-tab='files']").click();
    expect(pane.querySelector(".cdash-llist").scrollTop).toBe(0);
  });

  it("draws no card for a one-question chat", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("what is X?"), ...send({ kind: "answer", verdict: "Y", text: "Y." })]);
    await tick();
    expect(pane.querySelector(".cdash-links")).toBeNull();
  });

  it("opens Decided in a read view and says so when there is none", async () => {
    answers.chat_quick_view = ({ view }) => view === "decided"
      ? { view, title: "Decided", docs: [], message: "Nothing decided yet: this chat has no decisions log." }
      : { view, title: view, docs: [{ name: "x.md", body: "# hi" }], message: "" };
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("go"), ...plan([{ text: "s", status: "active" }])]);
    await tick();
    // The first draw looked each view up: Decided has nothing, so it reads muted.
    // The lookup lands a redraw later, which a loaded machine can take past one tick.
    await vi.waitFor(() => expect(pane.querySelector("[data-view='decided']").classList.contains("is-none")).toBe(true));
    expect(pane.querySelector("[data-view='plan']").classList.contains("is-none")).toBe(false);
    pane.querySelector("[data-view='decided']").click();
    await tick();
    const dlg = document.querySelector(".cdash-qvm");
    expect(dlg).not.toBeNull();
    expect(dlg.querySelector(".cdash-qvm-none").textContent).toContain("Nothing decided yet");
    expect(calls.filter((c) => c.cmd === "chat_quick_view" && c.args.sessionId === "sess-1" && c.args.view === "decided").length).toBeGreaterThan(0);
    dlg.querySelector(".cdash-qvm-x").click();
    expect(document.querySelector(".cdash-qvm")).toBeNull();
  });

  it("shows Project memory's files with a list to pick from, read-only", async () => {
    answers.chat_quick_view = () => ({
      view: "memory",
      title: "Project memory",
      docs: [{ name: "MEMORY.md", body: "- [a](a.md)" }, { name: "a.md", body: "# Fact A\nbody" }],
      message: "",
    });
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("go"), ...plan([{ text: "s", status: "active" }])]);
    await tick();
    pane.querySelector("[data-view='memory']").click();
    await tick();
    const dlg = document.querySelector(".cdash-qvm");
    expect([...dlg.querySelectorAll(".cdash-qvm-file")].map((b) => b.textContent)).toEqual(["MEMORY.md", "a.md"]);
    dlg.querySelectorAll(".cdash-qvm-file")[1].click();
    expect(dlg.querySelector(".cdash-qvm-doc").textContent).toContain("Fact A");
    expect(dlg.querySelector("textarea, input, [contenteditable]")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cdash-qvm")).toBeNull();
  });
});

/** The Previews tab, opened. */
const onPreviews = (pane) => {
  const tab = pane.querySelector("[data-act='links-tab'][data-tab='previews']");
  if (!tab.classList.contains("on")) tab.click();
};

describe("Previews tab", () => {
  it("draws this chat's previews as rows, newest first, each opening the panel", async () => {
    answers.list_previews = [meta("c"), meta("b"), meta("a")];
    answers.get_preview = { id: "c", html: "<p>hi</p>" };
    answers.render_preview_doc = "http://127.0.0.1:1/doc";
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("show me")]);
    await tick(60);
    // A chat with only previews opens on the Previews tab: the first tab with something in it.
    const card = pane.querySelector(".cdash-links");
    expect(card.querySelector(".cdash-ltab.on").dataset.tab).toBe("previews");
    expect([...card.querySelectorAll(".cdash-prow")].map((t) => t.dataset.slug)).toEqual(["slug-c", "slug-b", "slug-a"]);
    expect([...card.querySelectorAll(".cdash-prow .cdash-lname")].map((t) => t.textContent)).toEqual(["Title c", "Title b", "Title a"]);
    expect(card.querySelector("[data-act='links-tab'][data-tab='previews']").textContent).toBe("Previews3");
    expect(card.querySelector(".cdash-h .cdash-count").textContent).toBe("3");
    expect(card.querySelector("[data-act='pv-others']")).toBeNull();
    // Each page is staged and its frame points at it.
    await tick(60);
    expect([...card.querySelectorAll(".cdash-pv-frame")].map((f) => f.getAttribute("src"))).toEqual(Array(3).fill("http://127.0.0.1:1/doc"));
    let opened = null;
    window.addEventListener(PREVIEW_OPEN_EVENT, (e) => { opened = e.detail.slug; }, { once: true });
    pane.querySelector(".cdash-prow[data-slug='slug-a']").click();
    expect(opened).toBe("slug-a");
  });

  it("never shows another chat's preview as this chat's: a sub's and the main chat's sit behind a fold", async () => {
    answers.list_previews = [meta("sub1", { session_id: "sub-x" }), meta("mine"), meta("main1", { session_id: "main-y" }), meta("sub2", { session_id: "sub-x" })];
    answers.get_preview = { id: "x", html: "<p>hi</p>" };
    answers.render_preview_doc = "http://127.0.0.1:1/doc";
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("show me")]);
    await tick(60);
    const card = () => pane.querySelector(".cdash-links");
    expect([...card().querySelectorAll(".cdash-prow")].map((t) => t.dataset.slug)).toEqual(["slug-mine"]);
    const fold = card().querySelector("[data-act='pv-others']");
    expect(fold.textContent).toContain("3 more by other chats");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fold.click();
    await tick();
    const groups = [...card().querySelectorAll(".cdash-pv-group")];
    expect(groups.map((g) => [...g.querySelectorAll(".cdash-prow")].map((t) => t.dataset.slug))).toEqual([["slug-sub1", "slug-sub2"], ["slug-main1"]]);
    expect(card().querySelector("[data-act='pv-others']").getAttribute("aria-expanded")).toBe("true");
  });

  it("says this chat made none when only the rest of the family has previews", async () => {
    answers.list_previews = [meta("other", { session_id: "main-y" })];
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("hi")]);
    await tick(60);
    const card = pane.querySelector(".cdash-links");
    onPreviews(pane);
    expect(card.querySelector(".cdash-prow")).toBeNull();
    expect(pane.querySelector(".cdash-llist .cdash-lnone").textContent).toContain("no previews");
    expect(pane.querySelector("[data-act='pv-others']").textContent).toContain("1 more by other chats");
  });

  it("in a sub read in place, lists the sub's own and labels its parent's as the main chat's", async () => {
    const { state } = await import("../src/views/sessions/state.ts");
    const inst = (session_id, over = {}) => ({ session_id, name: session_id, pid: 1, project: "p", cwd: "C:\p", busy: false, awaiting: null, ...over });
    state.sessions = [inst("main-y"), inst("sess-1", { subchat_of: "main-y", name: "Hero" })];
    try {
      answers.list_previews = [meta("main1", { session_id: "main-y", title: "<b>x</b>" }), meta("mine")];
      answers.get_preview = { id: "x", html: "<p>hi</p>" };
      answers.render_preview_doc = "http://127.0.0.1:1/doc";
      const { pane, r } = mountPane();
      new ChatDashboard(pane, r);
      feed(r, [userEvent("show me")]);
      await tick(60);
      const card = pane.querySelector(".cdash-links");
      expect([...card.querySelectorAll(".cdash-prow")].map((t) => t.dataset.slug)).toEqual(["slug-mine"]);
      // The scope is the parent's family, so the list is read under the main chat's id.
      expect(calls.find((c) => c.cmd === "list_previews").args.sessionId).toBe("main-y");
      card.querySelector("[data-act='pv-others']").click();
      await tick();
      expect(pane.querySelector(".cdash-pv-owner").textContent).toBe("Main chat");
      // A title is text, never markup.
      expect(pane.querySelector(".cdash-pv-group .cdash-prow").getAttribute("title")).toBe("<b>x</b>: open in the preview panel");
      expect(pane.querySelector(".cdash-pv-group b")).toBeNull();
    } finally {
      state.sessions = [];
    }
  });

  it("caps a long list with a +N row that opens the panel instead of mounting every page", async () => {
    answers.list_previews = Array.from({ length: 12 }, (_, i) => meta(`p${i}`));
    answers.get_preview = { id: "x", html: "<p>hi</p>" };
    answers.render_preview_doc = "http://127.0.0.1:1/doc";
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("show me")]);
    await tick(60);
    const card = pane.querySelector(".cdash-links");
    expect(card.querySelector(".cdash-h .cdash-count").textContent).toBe("12");
    expect(card.querySelectorAll(".cdash-pv-frame")).toHaveLength(8);
    const rest = card.querySelector(".cdash-lmore");
    expect(rest.textContent).toBe("4 more in the preview panel");
    let opened = null;
    window.addEventListener(PREVIEW_OPEN_EVENT, (e) => { opened = e.detail.slug; }, { once: true });
    rest.click();
    expect(opened).toBe("slug-p8");
  });

  it("keeps the Previews tab Joe picked, and the same frame node while the card's content is unchanged", async () => {
    answers.list_previews = [meta("a")];
    answers.get_preview = { id: "a", html: "<p>hi</p>" };
    answers.render_preview_doc = "http://127.0.0.1:1/doc";
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("show me"), ...send({ kind: "artifact", text: "https://example.com/x" })]);
    await tick(60);
    // The chat has a preview, so Previews is the tab it opens on; Links is Joe's own pick first, then Previews again.
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("previews");
    pane.querySelector("[data-act='links-tab'][data-tab='links']").click();
    await tick(60);
    pane.querySelector("[data-act='links-tab'][data-tab='previews']").click();
    await tick(60);
    const frame = pane.querySelector(".cdash-pv-frame");
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:1/doc");
    frame.dataset.mark = "same";
    // A later message that adds nothing to the card redraws from the model and leaves the frame alone.
    feed(r, [userEvent("and another thing")]);
    await tick(60);
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("previews");
    expect(pane.querySelector(".cdash-pv-frame").dataset.mark).toBe("same");
    // One that adds a link changes the card's content, and the tab Joe picked still holds.
    feed(r, send({ kind: "artifact", text: "also https://example.com/y" }));
    await tick(60);
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("previews");
    expect(pane.querySelector("[data-act='links-tab'][data-tab='links']").textContent).toBe("Links2");
  });

  it("draws nothing when the family has no previews, or Joe switched the Previews tab off", async () => {
    answers.list_previews = [];
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("hi")]);
    await tick();
    expect(pane.querySelector(".cdash-links")).toBeNull();

    answers.list_previews = [meta("p")];
    setSettings({ dashboardSections: { preview: false } });
    const second = mountPane();
    new ChatDashboard(second.pane, second.r);
    feed(second.r, [userEvent("hi")]);
    await tick();
    expect(second.pane.querySelector(".cdash-links")).toBeNull();
  });
});

describe("Images tab", () => {
  const DATA = "iVBORw0KGgo=";
  const withImages = (...names) => names.map((n) => ({ type: "user_message", content: [{ type: "text", text: n }, { type: "image", mime: "image/png", data: DATA + n.length }], timestamp: 0 }));

  it("lists the chat's images newest first, points each thumbnail at its bytes and opens the gallery at the row", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, withImages("first", "second one"));
    await tick();
    const card = pane.querySelector(".cdash-links");
    expect(card.querySelector(".cdash-ltab.on").dataset.tab).toBe("images");
    expect(card.querySelector("[data-act='links-tab'][data-tab='images']").textContent).toBe("Images2");
    const rows = [...card.querySelectorAll(".cdash-irow")];
    // Newest first: the gallery's second image heads the list.
    expect(rows.map((b) => b.dataset.index)).toEqual(["1", "0"]);
    expect(rows[0].querySelector(".cdash-lmeta").textContent).toBe("You attached");
    // A pasted image has no name, so its row carries the message it came with.
    expect(rows.map((b) => b.querySelector(".cdash-lname").textContent)).toEqual(["second one", "first"]);
    expect(rows[0].querySelector("img").getAttribute("src")).toBe(`data:image/png;base64,${DATA}10`);
    expect(rows[1].querySelector("img").getAttribute("src")).toBe(`data:image/png;base64,${DATA}5`);
    rows[1].click();
    expect(document.querySelector(".chat-image-gallery-overlay")).not.toBeNull();
    // It opens at the clicked row's image: the counter reads "1 / 2" for the older one.
    expect(document.querySelector(".gallery-total-counter")?.textContent ?? "").toContain("1");
    document.querySelector(".lightbox-close")?.click();
  });

  it("says so when the chat has no image", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("hi"), ...send({ kind: "artifact", text: "https://example.com/x" })]);
    await tick();
    pane.querySelector("[data-act='links-tab'][data-tab='images']").click();
    expect(pane.querySelector(".cdash-llist .cdash-lnone").textContent).toBe("No images in this chat yet.");
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("images");
  });

  it("caps a long list with a row that opens the gallery on the first one left out", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, Array.from({ length: 15 }, (_, i) => ({ type: "user_message", content: [{ type: "text", text: `m${i}` }, { type: "image", mime: "image/png", data: `${DATA}${"A".repeat(i)}` }], timestamp: 0 })));
    await tick();
    const card = pane.querySelector(".cdash-links");
    expect(card.querySelectorAll(".cdash-irow")).toHaveLength(12);
    const more = card.querySelector(".cdash-lmore");
    expect(more.textContent).toBe("3 more in the gallery");
    // Newest first, so the rows left out are the oldest three: the first of them is image 2.
    expect(more.dataset.index).toBe("2");
    more.click();
    expect(document.querySelector(".chat-image-gallery-overlay")).not.toBeNull();
    // Opens at image 3 of 15, the first one the list left out.
    expect(document.querySelector(".gallery-total-counter")?.textContent ?? "").toContain("3");
    document.querySelector(".lightbox-close")?.click();
  });

  it("re-reads the images when a path-attached one finishes loading into the transcript", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, withImages("only"));
    await tick();
    expect(pane.querySelector("[data-act='links-tab'][data-tab='images']").textContent).toBe("Images1");
    // The settings change reaches the card only through a redraw, so a redraw is what the event must cause.
    setSettings({ dashboardSections: { images: false } });
    window.dispatchEvent(new CustomEvent(ATTACHMENT_SETTLED_EVENT));
    await tick();
    expect(pane.querySelector("[data-act='links-tab'][data-tab='images']")).toBeNull();
  });

  it("is a tab switch away, and Joe's section switch removes it", async () => {
    setSettings({ dashboardSections: { images: false } });
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [...withImages("only"), ...send({ kind: "artifact", text: "https://example.com/x" })]);
    await tick();
    expect([...pane.querySelectorAll("[data-act='links-tab']")].map((b) => b.dataset.tab)).toEqual(["previews", "files", "links"]);
    expect(pane.querySelector(".cdash-irow")).toBeNull();
  });

  it("Arrow keys, Home and End move between the tabs and keep focus on the one picked", async () => {
    const { pane, r } = mountPane();
    new ChatDashboard(pane, r);
    feed(r, [userEvent("ship"), ...send({ kind: "artifact", text: "PR https://github.com/acme/app/pull/42" })]);
    await tick();
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    pane.querySelector("[data-tab='links']").focus();
    key("ArrowRight");
    expect(document.activeElement.dataset.tab).toBe("previews");
    expect(pane.querySelector(".cdash-ltab.on").dataset.tab).toBe("previews");
    key("End");
    expect(document.activeElement.dataset.tab).toBe("links");
    key("ArrowRight");
    expect(document.activeElement.dataset.tab).toBe("previews");
    key("ArrowLeft");
    expect(document.activeElement.dataset.tab).toBe("links");
    key("Home");
    expect(document.activeElement.dataset.tab).toBe("previews");
  });
});

describe("Changes", () => {
  it("stays hidden until Joe switches it on, then lists the edited files", async () => {
    const { pane, r } = mountPane();
    const dash = new ChatDashboard(pane, r);
    feed(r, [userEvent("fix"), ...tool("Edit", { file_path: "C:\\p\\a.ts", old_string: "a", new_string: "b" })]);
    await tick();
    expect(pane.querySelector(".cdash-changes")).toBeNull();
    setSettings({ dashboardSections: { changes: true } });
    dash.schedule();
    await tick();
    const card = pane.querySelector(".cdash-changes");
    expect(card).not.toBeNull();
    expect(card.querySelector(".file-ref").dataset.path).toBe("C:\\p\\a.ts");
    expect(card.textContent).toContain("1 edit");
  });

  it("reads only booleans from the saved section choices", () => {
    expect(readSections({})).toEqual({});
    expect(readSections({ dashboardSections: { changes: true, links: "yes", preview: false } })).toEqual({ changes: true, preview: false });
    expect(readSections({ dashboardSections: ["x"] })).toEqual({});
  });
});
