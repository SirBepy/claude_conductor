import { describe, it, expect } from "vitest";
import { renderBlocks, renderMessage, cleanUserBlocks, base64ToUtf8, detectStatusToken, highlightComposerInput, highlightSlashMentions, eventToRenderedMessage } from "../src/shared/chat/chat-transforms.ts";
import { setSlashEntries } from "../src/shared/chat/slash-registry.ts";

// Chip conversion is a USER-message-only concern (third arg = fileChips). The
// tokens are composer sentinels; only user blocks legitimately carry them.
const userBlocks = (blocks) => renderBlocks(blocks, false, true);

describe("renderBlocks — file token handling", () => {
  it("converts a standalone <file:path::name> token to an attachment-chip", () => {
    const html = userBlocks([{ type: "text", text: "<file:/data/uuid.pdf::report.pdf>" }]);
    expect(html).not.toContain("&lt;file:");
    expect(html).toContain("attachment-chip");
    expect(html).toContain('data-attachment-path="/data/uuid.pdf"');
    expect(html).toContain("report.pdf");
  });

  it("preserves text before and after a file token", () => {
    const html = userBlocks([{ type: "text", text: "here is a file <file:/data/img.png::photo.png> and some text after" }]);
    expect(html).toContain("here is a file");
    expect(html).toContain("and some text after");
    expect(html).toContain("attachment-chip");
  });

  it("handles a file token without a display name", () => {
    const html = userBlocks([{ type: "text", text: "<file:/data/uuid.png>" }]);
    expect(html).toContain("attachment-chip");
    expect(html).toContain("uuid.png");
  });

  it("handles multiple file tokens in one block", () => {
    const html = userBlocks([
      { type: "text", text: "<file:/a.pdf::a.pdf> and <file:/b.txt::b.txt>" },
    ]);
    const matches = (html.match(/attachment-chip/g) ?? []).length;
    expect(matches).toBe(2);
  });

  it("does not affect text blocks without file tokens", () => {
    const html = userBlocks([{ type: "text", text: "just regular text" }]);
    expect(html).not.toContain("attachment-chip");
    expect(html).toContain("just regular text");
  });

  it("handles Windows absolute paths with drive letter colon", () => {
    const html = userBlocks([{ type: "text", text: "<file:C:\\Users\\data\\uuid.pdf::report.pdf>" }]);
    expect(html).toContain("attachment-chip");
    expect(html).toContain('data-attachment-path="C:\\Users\\data\\uuid.pdf"');
    expect(html).toContain("report.pdf");
  });
});

describe("renderBlocks — file tokens are chipped ONLY in user messages (todo 140)", () => {
  // Regression: Claude writing example text like "sent as <file:PATH>" was being
  // turned into a broken ⚠️ chip. Chip conversion must be gated to user messages.
  const exampleText = "they get sent as <file:/some/path.png::displayname> mentions";

  it("does NOT chip a file token in the default (assistant/tool) render path", () => {
    const html = renderBlocks([{ type: "text", text: exampleText }]);
    expect(html).not.toContain("attachment-chip");
    expect(html).toContain("displayname");
  });

  it("renderMessage(assistant) leaves <file:> example text as plain markdown", () => {
    const html = renderMessage({ kind: "assistant", content: [{ type: "text", text: exampleText }], ts: 0 });
    expect(html).not.toContain("attachment-chip");
    expect(html).toContain("displayname");
  });

  it("renderMessage(user) still converts a real <file:> attachment to a chip", () => {
    const html = renderMessage({ kind: "user", content: [{ type: "text", text: "<file:/data/uuid.pdf::report.pdf>" }], ts: 0 });
    expect(html).toContain("attachment-chip");
    expect(html).toContain("report.pdf");
  });

  it("tool_result text with a <file:> token is not chipped", () => {
    const html = renderMessage({ kind: "tool_result", tool_use_id: "y", output: { type: "text", text: exampleText }, is_error: false, ts: 0 });
    expect(html).not.toContain("attachment-chip");
  });
});

describe("renderMessage — tool_use branches to edit-window for file mutations", () => {
  it("renders Edit tool_use as <details class='edit-window'>", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Edit",
      input: { file_path: "/a/b/foo.ts", old_string: "a", new_string: "b" },
      id: "x",
      ts: 0,
    });
    expect(html).toContain("edit-window");
    expect(html).toContain("foo.ts");
    expect(html).not.toContain("<pre>{");
  });

  it("renders Write tool_use as edit-window", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Write",
      input: { file_path: "/x.ts", content: "hi" },
      id: "x",
      ts: 0,
    });
    expect(html).toContain("edit-window");
    expect(html).toContain("data-kind=\"write\"");
  });

  it("falls back to generic <pre> rendering for non-file tools", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Bash",
      input: { command: "ls" },
      id: "x",
      ts: 0,
    });
    expect(html).not.toContain("edit-window");
    expect(html).toContain("<pre>");
    expect(html).toContain("Bash");
  });

  it("falls back to generic for Edit with malformed input", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Edit",
      input: null,
      id: "x",
      ts: 0,
    });
    expect(html).not.toContain("edit-window");
    expect(html).toContain("<pre>");
  });
});

describe("renderMessage - meta-turn chips replace the old wall-of-text label", () => {
  it("renders a peer wake as a chip carrying the label only, payload in the tooltip", () => {
    const html = renderMessage({
      kind: "system",
      text: "Peer message",
      metaKind: "peer",
      metaDetail: "[repo-channel] someone: " + "a".repeat(400),
      ts: 0,
    });
    expect(html).toContain('class="msg system meta-marker"');
    expect(html).toContain("Peer message");
    expect(html).toContain('title="[repo-channel] someone:');
    // The payload rides in the tooltip only - never as inline visible text,
    // which is the wall-of-text being removed.
    const visible = html.replace(/title="[^"]*"/g, "");
    expect(visible).not.toContain("aaaa");
  });

  it("renders a retracted message as a struck placeholder, not the bubble", () => {
    const html = renderMessage({ kind: "message", text: "tests failing", retracted: true, ts: 0 });
    expect(html).toContain("retracted-chip");
    expect(html).toContain("Retracted");
    expect(html).not.toContain('class="msg assistant');
  });

  it("dims a message from an interrupted turn but keeps it readable", () => {
    const html = renderMessage({ kind: "message", text: "committing now", dimmed: true, ts: 0 });
    expect(html).toContain('class="msg assistant dimmed"');
    expect(html).toContain("committing now");
  });
});

describe("renderMessage - system notes (long-note collapse)", () => {
  it("renders a short system note as the plain centered caption, not collapsed", () => {
    const html = renderMessage({ kind: "system", text: "Continuing session…", ts: 0 });
    expect(html).toBe('<div class="msg system">Continuing session…</div>');
  });

  it("renders a long system note (e.g. relayed repo-channel text) as a collapsed <details>", () => {
    const longText = "Relayed: " + "a".repeat(500);
    const html = renderMessage({ kind: "system", text: longText, ts: 0 });
    expect(html).toMatch(/^<details class="msg system system-long">/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // Full text is preserved (not silently dropped), just tucked behind the toggle.
    expect(html).toContain(longText);
    expect(html).toContain("system-note-full");
  });
});

describe("renderMessage — non-file tool_use renders a collapsed details row", () => {
  it("renders a <details> tool-row with name + target, NOT open by default", () => {
    const html = renderMessage({
      kind: "tool_use",
      tool: "Grep",
      input: { pattern: "foo.*bar" },
      id: "x",
      ts: 0,
    });
    expect(html).toMatch(/^<details class="msg tool-use tool-row"/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("tool-row-summary");
    expect(html).toContain("ph-magnifying-glass");
    expect(html).toContain("Grep");
    expect(html).toContain("foo.*bar");
    expect(html).toContain("<pre>");
  });

  it("renders tool_result as a collapsed details row keeping error class", () => {
    const ok = renderMessage({ kind: "tool_result", tool_use_id: "y", output: { type: "text", text: "out" }, is_error: false, ts: 0 });
    expect(ok).toMatch(/^<details class="msg tool-result tool-row"/);
    expect(ok).not.toMatch(/<details[^>]*\sopen/);
    expect(ok).toContain("ph-arrow-bend-down-right");

    const err = renderMessage({ kind: "tool_result", tool_use_id: "y", output: { type: "text", text: "boom" }, is_error: true, ts: 0 });
    expect(err).toContain("tool-result tool-row error");
  });
});

describe("renderBlocks — pasted-log chip", () => {
  const body = "Hello 世界\nsecond line\nthird line";

  it("collapses a <pasted-log> wrapper into a chip, not raw text", () => {
    const html = userBlocks([{ type: "text", text: `<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    expect(html).toContain("pasted-log-chip");
    expect(html).toContain("pasted_log.txt");
    // the body must NOT render as visible text
    expect(html).not.toContain("second line");
    expect(html).not.toContain("世界");
  });

  it("stashes the full body (base64, utf8-safe) for the lightbox", () => {
    const html = userBlocks([{ type: "text", text: `<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    const m = html.match(/data-pasted-text="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(base64ToUtf8(m[1])).toBe(body);
  });

  it("renders typed text around the chip normally", () => {
    const html = userBlocks([{ type: "text", text: `look at this\n\n<pasted-log name="pasted_log.txt">\n${body}\n</pasted-log>` }]);
    expect(html).toContain("look at this");
    expect(html).toContain("pasted-log-chip");
  });
});

describe("renderBlocks — inline-code URL linkify", () => {
  it("makes a URL-only inline-code span clickable", () => {
    const html = renderBlocks([{ type: "text", text: "Open: `http://localhost:57217`" }]);
    expect(html).toContain('<code><a href="http://localhost:57217">http://localhost:57217</a></code>');
  });

  it("leaves a non-URL inline-code span untouched", () => {
    const html = renderBlocks([{ type: "text", text: "run `cargo build` now" }]);
    expect(html).toContain("<code>cargo build</code>");
    expect(html).not.toContain("<a href");
  });

  it("does not linkify a URL embedded in a larger command snippet", () => {
    const html = renderBlocks([{ type: "text", text: "run `curl https://example.com -o x` now" }]);
    expect(html).not.toContain("<a href");
  });

  it("still linkifies a bare URL in plain text", () => {
    const html = renderBlocks([{ type: "text", text: "see http://localhost:57217 now" }]);
    expect(html).toContain('href="http://localhost:57217"');
  });
});

describe("status marker", () => {
  it("strips the status marker from rendered text", () => {
    const html = renderBlocks([{ type: "text", text: "All done here.\n<cc-status:done>" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("All done here");
  });
  it("detectStatusToken reads the last marker", () => {
    expect(detectStatusToken("blah <cc-status:question>")).toBe("question");
    expect(detectStatusToken("nope")).toBe(null);
  });
  it("detects and strips the waiting marker", () => {
    expect(detectStatusToken("Kicked off CI. <cc-status:waiting>")).toBe("waiting");
    const html = renderBlocks([{ type: "text", text: "Watching the build.\n<cc-status:waiting>" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("Watching the build");
  });
  it("never leaks a partial waiting marker mid-stream", () => {
    const html = renderBlocks([{ type: "text", text: "Watching the build.\n<cc-status:wait" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("Watching the build");
  });
  it("detects and strips the working marker (background subagents running)", () => {
    expect(detectStatusToken("3 agents fanned out. <cc-status:working>")).toBe("working");
    const html = renderBlocks([{ type: "text", text: "3 agents fanned out.\n<cc-status:working>" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("3 agents fanned out");
  });
  it("never leaks a partial working marker mid-stream", () => {
    // "wo" diverges from "waiting" after the shared "w" - the tail regex must
    // absorb both branches.
    const html = renderBlocks([{ type: "text", text: "Fanning out.\n<cc-status:work" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("Fanning out");
  });
  it("detects XML-form and hybrid working markers", () => {
    expect(detectStatusToken("done for now <cc-status>working</cc-status>")).toBe("working");
    expect(detectStatusToken("done for now <cc-status:working</cc-status>")).toBe("working");
  });
  it("strips a malformed hybrid marker (colon-opened, XML-closed) and detects it", () => {
    const html = renderBlocks([{ type: "text", text: "All done here.\n<cc-status:question</cc-status>" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("All done here");
    expect(detectStatusToken("All done here.\n<cc-status:question</cc-status>")).toBe("question");
  });
  it("never leaks a partial hybrid marker mid-stream", () => {
    const html = renderBlocks([{ type: "text", text: "Watching the build.\n<cc-status:question<" }]);
    expect(html).not.toContain("cc-status");
    expect(html).toContain("Watching the build");
  });
});

describe("title marker — XML form", () => {
  it("strips XML-form <cc-title>...</cc-title> from rendered text", () => {
    const html = renderBlocks([{ type: "text", text: "Hello world\n<cc-title>Casual greeting exchange</cc-title>\n<cc-status:done>" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("Hello world");
  });
  it("strips XML-form title without status marker", () => {
    const html = renderBlocks([{ type: "text", text: "Some response\n<cc-title>Chat About Foo</cc-title>" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("Some response");
  });
  it("strips partial XML-form tail during streaming", () => {
    const html = renderBlocks([{ type: "text", text: "text\n<cc-title>partial content still streaming" }]);
    expect(html).not.toContain("cc-title");
    expect(html).toContain("text");
  });
});

describe("cleanUserBlocks — strips background-task notifications", () => {
  it("drops a user message containing only a task-notification block", () => {
    const out = cleanUserBlocks([{ type: "text", text: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>did the thing</summary>\n</task-notification>" }]);
    expect(out).toEqual([]);
  });

  it("strips task-notification but preserves surrounding user text", () => {
    const out = cleanUserBlocks([{ type: "text", text: "hey before\n<task-notification><status>done</status></task-notification>\nhey after" }]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("hey before");
    expect(out[0].text).toContain("hey after");
    expect(out[0].text).not.toContain("task-notification");
    expect(out[0].text).not.toContain("status");
  });
});

describe("renderMessage — user newlines render as hard breaks", () => {
  it("turns single newlines in a user message into <br> (preserves multi-line input)", () => {
    const html = renderMessage({ kind: "user", content: [{ type: "text", text: "line one\nline two\nline three" }], ts: 0 });
    expect((html.match(/<br\s*\/?>/g) ?? []).length).toBe(2);
    expect(html).toContain("line one");
    expect(html).toContain("line three");
  });

  it("does NOT hard-break assistant messages (Claude's own paragraphing wins)", () => {
    const html = renderMessage({ kind: "assistant", content: [{ type: "text", text: "line one\nline two" }], ts: 0 });
    expect(html).not.toContain("<br");
  });
});

describe("highlightComposerInput — live /slash coloring", () => {
  it("wraps a known skill in a color-only span, leaves unknown plain", () => {
    setSlashEntries([{ name: "commit", source: { kind: "user-skill" } }]);
    const known = highlightComposerInput("/commit go");
    expect(known).toContain('<span class="cm-slash cm-slash-user-skill">/commit</span>');
    const unknown = highlightComposerInput("/asdasdasd nope");
    expect(unknown).not.toContain("cm-slash");
    expect(unknown).toContain("/asdasdasd");
  });

  it("gives project-local kinds a distinct class from every other kind (two-colour split)", () => {
    setSlashEntries([
      { name: "deploy", source: { kind: "project-command" } },
      { name: "clear", source: { kind: "builtin" } },
    ]);
    const out = highlightComposerInput("/deploy then /clear");
    expect(out).toContain('<span class="cm-slash cm-slash-project-command">/deploy</span>');
    expect(out).toContain('<span class="cm-slash cm-slash-builtin">/clear</span>');
  });

  it("escapes HTML so raw input can't inject markup", () => {
    setSlashEntries([]);
    const out = highlightComposerInput("<b>hi</b> & stuff");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<b>");
  });

  it("pads a trailing newline so backdrop height tracks the textarea", () => {
    setSlashEntries([]);
    expect(highlightComposerInput("hello\n")).toBe("hello\n ");
  });

  it("tints an @ file path with a background wash, unconditionally", () => {
    setSlashEntries([]);
    const out = highlightComposerInput("check @src/main.ts please");
    expect(out).toContain('<span class="cm-at-path">@src/main.ts</span>');
  });

  it("handles a line with both a /slash mention and an @ path without corrupting either", () => {
    setSlashEntries([{ name: "commit", source: { kind: "user-skill" } }]);
    const out = highlightComposerInput("/commit @src/main.ts now");
    expect(out).toContain('<span class="cm-slash cm-slash-user-skill">/commit</span>');
    expect(out).toContain('<span class="cm-at-path">@src/main.ts</span>');
    // Neither span's markup should leak into the other's text content.
    expect(out).not.toContain("cm-at-path\">/commit");
    expect(out).not.toContain("cm-slash-user-skill\">@src");
  });
});

describe("highlightSlashMentions — sent-message colour swatch (todo 489)", () => {
  it("wraps a hex literal in a swatch span, keeping the hex text intact", () => {
    const out = highlightSlashMentions("try <p>#9aa4b2</p>");
    expect(out).toContain('<span class="colour-swatch" style="--swatch:#9aa4b2">#9aa4b2</span>');
  });

  it("handles a known /slash mention and a colour literal together without corrupting either", () => {
    setSlashEntries([{ name: "commit", source: { kind: "user-skill" } }]);
    const out = highlightSlashMentions("<p>/commit with #f09ab8 please</p>");
    expect(out).toContain('class="slash-mention slash-user-skill" data-slash="commit"');
    expect(out).toContain('<span class="colour-swatch" style="--swatch:#f09ab8">#f09ab8</span>');
  });

  it("skips colour literals inside <code>/<pre>/<a>", () => {
    const out = highlightSlashMentions('<p><code>#abc123</code></p>');
    expect(out).not.toContain("colour-swatch");
  });
});

describe("eventToRenderedMessage — isMeta user turns", () => {
  // Claude Code marks a self-injected turn (a fired ScheduleWakeup prompt, an
  // autopilot loop tick, etc.) with isMeta:true instead of wrapping it in a
  // sentinel. It must render as a system note, never a real user bubble -
  // Joe should never see what looks like a message he didn't send.
  it("renders an untagged isMeta:true user turn as a Scheduled wake chip", () => {
    const msg = eventToRenderedMessage({
      type: "user_message",
      content: [{ type: "text", text: "Check on the research agent and continue once it reports back." }],
      timestamp: 1n,
      remote_echo: false,
      is_meta: true,
    });
    expect(msg.kind).toBe("system");
    expect(msg.text).toBe("Scheduled wake");
    expect(msg.metaKind).toBe("wake");
    // Payload is kept for the tooltip, but no longer part of the label.
    expect(msg.metaDetail).toContain("Check on the research agent");
  });

  it("tags a daemon-relayed peer wake as a peer chip", () => {
    const msg = eventToRenderedMessage({
      type: "user_message",
      content: [{ type: "text", text: "[repo-channel] session-b: heads up, touching pump.rs" }],
      timestamp: 1n,
      remote_echo: false,
      is_meta: true,
    });
    expect(msg.metaKind).toBe("peer");
    expect(msg.text).toBe("Peer message");
  });

  it("still renders a plain (isMeta:false) user turn as a user bubble", () => {
    const msg = eventToRenderedMessage({
      type: "user_message",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1n,
      remote_echo: false,
      is_meta: false,
    });
    expect(msg.kind).toBe("user");
  });
});

describe("renderBlocks — AUQ answer chip", () => {
  it("peels the <auq-answer/> marker into an answer chip and hides the framed body (already shown by the resolved question card)", () => {
    const html = userBlocks([
      { type: "text", text: "<auq-answer/>User answered the question(s):\nQ: Tabs or spaces?\nA: Tabs" },
    ]);
    expect(html).toContain("auq-answer-chip");
    expect(html).not.toContain("&lt;auq-answer");
    expect(html).not.toContain("<auq-answer/>");
    // the framed Q/A text must NOT render as visible text - it's stashed for the chip's lightbox
    expect(html).not.toContain("Tabs or spaces");
  });

  it("stashes the full framed body (base64, utf8-safe) for the lightbox", () => {
    const html = userBlocks([
      { type: "text", text: "<auq-answer/>User answered the question(s):\nQ: Tabs or spaces?\nA: Tabs" },
    ]);
    const m = html.match(/data-auq-answer-text="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(base64ToUtf8(m[1])).toBe("User answered the question(s):\nQ: Tabs or spaces?\nA: Tabs");
  });

  it("does not chip-convert an <auq-answer/> marker an assistant wrote as example text", () => {
    const html = renderMessage({
      kind: "assistant",
      content: [{ type: "text", text: "emit <auq-answer/> to mark it" }],
      ts: 0,
    });
    expect(html).not.toContain("auq-answer-chip");
  });

  it("renders both a voice and an answer chip when both markers are present", () => {
    const html = userBlocks([
      { type: "text", text: "<voice-input/><auq-answer/>User answered the question(s):\nQ: x\nA: y" },
    ]);
    expect(html).toContain("auq-answer-chip");
    expect(html).toContain("voice-input-chip");
  });
});
