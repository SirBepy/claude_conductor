// @vitest-environment jsdom
// asserts: src/views/sessions/session-header.ts, src/views/sessions/chat-heads-model.ts

// A project's main chat shows only the project (its face and name) in the chat header, because the
// chat heads draw it as the project's face with no character and its chat name would only say
// "main chat of <project>". Every other chat, and every sub, keeps the character avatar and title.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { SessionHeader } = await import("../src/views/sessions/session-header.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
const { isProjectMainChat } = await import("../src/views/sessions/chat-heads-model.ts");

const CWD = "C:/Projects/rodge";
const chat = (id, over = {}) => ({ session_id: id, cwd: CWD, project_id: "p-rodge", kind: "interactive", ...over });

function bound(id) {
  const header = new SessionHeader({ title: "Refactor the router", meta: "rodge" });
  document.body.appendChild(header.el);
  header.bindSession({ sessionId: id, readOnly: false, charId: "ada", charUrl: "x.png", charStatus: "st-working", cwd: CWD });
  return header;
}

beforeEach(() => {
  document.body.innerHTML = "";
  state.sessions = [chat("main"), chat("plain"), chat("sub-1", { subchat_of: "main" })];
  adoptSubchatsOn("main");
});

describe("a project's main chat header", () => {
  it("shows the project face and name, with no character and no chat-name line", () => {
    const header = bound("main");
    expect(header.el.classList.contains("is-project-main")).toBe(true);
    const face = header.el.querySelector(".session-header-avatar-wrap .proj-face");
    expect(face.getAttribute("data-proj-face")).toBe(CWD);
    // The same monogram request as the stack head, so both draw the same two letters.
    expect(face.getAttribute("data-proj-mono")).toBe("rodge");
    expect(header.el.querySelector("img.char-avatar")).toBeNull();
    expect(header.el.querySelector(".header-char-clickable")).toBeNull();
    expect(header.el.querySelector(".session-header-avatar")).toBeNull();
    expect(header.el.querySelector(".meta-proj").textContent).toBe("rodge");
  });

  it("keeps the title node (hidden by CSS) so title updates still have a target", () => {
    const header = bound("main");
    expect(header.el.querySelector(".title")).not.toBeNull();
    header.setTitle("Renamed");
    expect(header.el.querySelector(".title")).not.toBeNull();
  });

  it("leaves a plain chat's header as it was: character avatar and chat name", () => {
    const header = bound("plain");
    expect(header.el.classList.contains("is-project-main")).toBe(false);
    expect(header.el.querySelector("img.session-header-char")).not.toBeNull();
    expect(header.el.querySelector(".header-char-clickable")).not.toBeNull();
    expect(header.el.querySelector(".title").textContent).toBe("Refactor the router");
  });

  it("leaves a sub's header alone even though its main chat is a main chat", () => {
    const header = bound("sub-1");
    expect(header.el.classList.contains("is-project-main")).toBe(false);
  });
});

describe("isProjectMainChat", () => {
  it("is true only for a chat in main-chat mode that is no sub", () => {
    expect(isProjectMainChat(state.sessions[0], state.sessions)).toBe(true);
    expect(isProjectMainChat(state.sessions[1], state.sessions)).toBe(false);
    adoptSubchatsOn("sub-1");
    expect(isProjectMainChat(state.sessions[2], state.sessions)).toBe(false);
  });
});
