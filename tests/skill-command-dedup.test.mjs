// Regression for the skill-invocation duplicate/truncated-bubble bug: typing
// "/commit pushnbump" rendered either as two bubbles (the full "/commit
// pushnbump" chip, then a second bubble with just "pushnbump"), or, after a
// reload, as a single bubble showing only "pushnbump" with the "/commit" chip
// gone entirely.
//
// Root cause: the composer's optimistic echo (pushSynthetic) carries the raw
// typed text "/commit pushnbump" verbatim. The file watcher delivers the same
// turn from the authoritative JSONL transcript, where Claude Code wraps it as
// <command-message>commit</command-message><command-name>/commit</command-name>
// <command-args>pushnbump</command-args>. normalizeUserMessageText used to
// delete the ENTIRE command-name block (including its "/commit" content),
// leaving just "pushnbump" - a different string from the synthetic echo's
// "/commit pushnbump". The content-based dedup signature (sigOf in
// event-store.ts) compares these normalized strings, so the mismatch made
// the watcher's copy look like a brand-new message instead of a duplicate.
//
// Sample scaffolding text below is copied verbatim from a real session
// transcript (~/.claude/projects/.../*.jsonl) for this exact command.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { normalizeUserMessageText, cleanUserBlocks } from "../src/shared/chat/chat-transforms.ts";

describe("normalizeUserMessageText - reconstructs the typed slash command", () => {
  it("matches the raw composer text for a real /commit pushnbump transcript", () => {
    const jsonlText =
      "<command-message>commit</command-message>\n" +
      "<command-name>/commit</command-name>\n" +
      "<command-args>pushnbump</command-args>";
    expect(normalizeUserMessageText(jsonlText)).toBe("/commit pushnbump");
  });

  it("matches the raw composer text for a no-arg command (/exit)", () => {
    const jsonlText =
      "<command-message>exit</command-message>\n" +
      "<command-name>/exit</command-name>\n" +
      "<command-args></command-args>";
    expect(normalizeUserMessageText(jsonlText)).toBe("/exit");
  });

  it("strips the appended SKILL.md body but keeps the reconstructed /name args", () => {
    const jsonlText =
      "<command-message>brainstorm</command-message>\n" +
      "<command-name>/brainstorm</command-name>\n" +
      "<command-args>a new widget</command-args>\n" +
      "Base directory for this skill: /skills/brainstorm\n\n" +
      "## Some skill markdown body\nlots of instructions here\n\n" +
      "ARGUMENTS: a new widget";
    expect(normalizeUserMessageText(jsonlText)).toBe("/brainstorm a new widget");
  });

  it("preserves multi-line args verbatim after the reconstructed name", () => {
    const jsonlText =
      "<command-message>character-creator</command-message>\n" +
      "<command-name>/character-creator</command-name>\n" +
      "<command-args>line one\nline two</command-args>";
    expect(normalizeUserMessageText(jsonlText)).toBe("/character-creator line one\nline two");
  });

  it("leaves plain (non-command) text untouched", () => {
    expect(normalizeUserMessageText("just a normal message")).toBe("just a normal message");
  });
});

describe("cleanUserBlocks - the JSONL-sourced bubble keeps the /name chip text", () => {
  it("renders the same text the composer's synthetic echo carried", () => {
    const jsonlText =
      "<command-message>commit</command-message>\n" +
      "<command-name>/commit</command-name>\n" +
      "<command-args>pushnbump</command-args>";
    const out = cleanUserBlocks([{ type: "text", text: jsonlText }]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("/commit pushnbump");
  });
});

// vi.hoisted, not a plain const: vi.mock is hoisted above this line, so a bare
// `const invokeMock` is still in its TDZ when the factory runs.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI__ = undefined;
});

const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

describe("SessionEventStore - skill command dedup across runner/watcher sources", () => {
  it("dedups the composer's raw echo against the JSONL-scaffolded watcher copy", () => {
    const sid = `sess-skill-dedup-${Math.random()}`;
    // Composer's optimistic echo: exactly what the user typed.
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [{ type: "text", text: "/commit pushnbump" }],
      timestamp: Date.now(),
    });
    // File-watcher delivery of the same turn from the authoritative JSONL.
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [
        {
          type: "text",
          text:
            "<command-message>commit</command-message>\n" +
            "<command-name>/commit</command-name>\n" +
            "<command-args>pushnbump</command-args>",
        },
      ],
      timestamp: Date.now(),
    });
    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });

  it("dedups regardless of which source arrives first", () => {
    const sid = `sess-skill-dedup-2-${Math.random()}`;
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [
        {
          type: "text",
          text:
            "<command-message>exit</command-message>\n" +
            "<command-name>/exit</command-name>\n" +
            "<command-args></command-args>",
        },
      ],
      timestamp: Date.now(),
    });
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: [{ type: "text", text: "/exit" }],
      timestamp: Date.now(),
    });
    const users = sessionEvents.events(sid).filter((e) => e.type === "user_message");
    expect(users).toHaveLength(1);
  });
});
