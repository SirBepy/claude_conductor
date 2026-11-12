//! `/hooks/sub-write-guard` (`PreToolUse`, Edit|Write|NotebookEdit|MultiEdit): the
//! writer slot's enforcement point (`subchats::writers`). Registered only in a
//! sub's hook settings (`claude_config::write_hook_settings`), so a chat that is
//! not a sub never pays for the extra round trip.
//!
//! A refusal is a `deny`. An allowed edit answers with an EMPTY object and not
//! `allow`: a hook's `allow` skips Claude Code's permission check, which would
//! hand every sub auto-accept for its edits and break the rule that a sub's
//! permission prompts reach Joe.

use super::decision::deny_decision;
use super::HookCtx;
use crate::daemon::subchats::writers::{self, WriteCheck};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

/// The tools that write a file by themselves. Bash is not here: a guard on shell
/// commands would be guessing, which is why the refusal calls this a guard and
/// not a sandbox.
const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

pub(super) fn decide(ctx: &HookCtx, body: &Value) -> Value {
    let tool = body.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !WRITE_TOOLS.contains(&tool) {
        return json!({});
    }
    // Unidentifiable callers pass: this guard never blocks a chat it cannot place.
    let Some(session_id) = body.get("session_id").and_then(Value::as_str) else { return json!({}) };
    match writers::check_write(&ctx.state, session_id) {
        WriteCheck::Allow => json!({}),
        WriteCheck::ReadOnly => deny_decision(writers::READ_ONLY_REFUSAL),
        WriteCheck::Wait { holder } => deny_decision(&writers::wait_refusal(&holder)),
    }
}

/// What a refused sub is told. A gate sub is the one sub allowed to publish work
/// (`subchats::is_gate`); everything else hands its commits to the main chat.
pub(super) const PUSH_REFUSAL: &str = "Only a push gate sub may run git push or gh pr merge, and you are not one. This is a guard on the command text, not a sandbox, and auto-accept does not lift it. Commit your work, call finish_subchat, and let your main chat start a gate (spawn_chat with gate: true) once Joe asks for the push.";

/// `Some(refusal)` when `tool` is a shell call by a sub that is not a gate and its
/// command publishes work (`git push`, `gh pr merge`). Runs in the permission
/// relay BEFORE the auto-accept shortcut, because subs inherit auto-accept (on by
/// default) and also reach the relay from projects other than the main chat's.
/// A chat that is not a sub, and a gate, are never refused here.
pub(super) fn push_refusal(state: &crate::daemon::state::DaemonState, session_id: &str, tool: &str, input: &Value) -> Option<&'static str> {
    if tool != "Bash" && tool != "PowerShell" {
        return None;
    }
    let command = input.get("command").and_then(Value::as_str)?;
    if !runs_publish_command(command, tool == "PowerShell") {
        return None;
    }
    let is_sub = state.registry.get(session_id).is_some_and(|i| crate::daemon::subchats::is_sub(&i));
    (is_sub && !crate::daemon::subchats::is_gate(session_id)).then_some(PUSH_REFUSAL)
}

/// Wrappers that run the next word as a command (`sudo git push`, `time git push`).
const WRAPPERS: [&str; 17] = [
    "sudo", "env", "command", "exec", "time", "nohup", "nice", "timeout", "xargs", "builtin", "then", "do", "else", "elif", "if", "while", "!",
];
/// A wrapper's flags that take their value as the NEXT word (`sudo -u root git push`).
fn wrapper_value_flags(name: &str) -> &'static [&'static str] {
    match name {
        "sudo" => &["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T"],
        "env" => &["-u", "-C", "-S"],
        "nice" => &["-n"],
        "timeout" => &["-s", "-k"],
        "xargs" => &["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a"],
        _ => &[],
    }
}
const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"];
/// Commands whose arguments ARE a command line (`eval "..."`).
const EVALS: [&str; 3] = ["eval", "iex", "invoke-expression"];
/// `git` options that take their value as the NEXT word.
const GIT_OPTS_WITH_VALUE: [&str; 7] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"];

/// Whether a shell command line runs `git push` or `gh pr merge` anywhere: after
/// `&&`, `;`, `|`, in `$(..)`, behind `git -C dir`, `sudo`, env assignments, or as
/// the argument of `bash -c`. A word that merely MENTIONS push (`echo git push`,
/// `git log --grep push`, `git commit -m "push"`) is one argument, not a command,
/// and so is the body of a heredoc or PowerShell here-string. `ps` says the text
/// is PowerShell, where a backtick escapes instead of substituting.
pub(super) fn runs_publish_command(command: &str, ps: bool) -> bool {
    runs_publish_command_at(command, 0, ps)
}

fn runs_publish_command_at(command: &str, depth: u8, ps: bool) -> bool {
    if depth > 4 {
        return false;
    }
    let (segments, nested) = split_segments(&strip_heredocs(command, ps), ps);
    nested.iter().any(|n| runs_publish_command_at(n, depth + 1, ps)) || segments.iter().any(|s| segment_publishes(s, depth, ps))
}

/// How a heredoc body ends: its delimiter as a whole line, the same with leading
/// tabs allowed (`<<-`), or a PowerShell here-string's `'@` at line start.
enum Terminator {
    Line(String),
    TabbedLine(String),
    HereStringEnd(String),
}

impl Terminator {
    fn closes(&self, line: &str) -> bool {
        let line = line.trim_end_matches('\r');
        match self {
            Terminator::Line(d) => line == d,
            Terminator::TabbedLine(d) => line.trim_start_matches('\t') == d,
            Terminator::HereStringEnd(d) => line.starts_with(d.as_str()),
        }
    }
}

/// The heredoc delimiters a line opens (`cat <<'EOF'`, `<<-EOF`; not `<<<`).
fn heredoc_terminators(line: &str, ps: bool) -> Vec<Terminator> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = vec![];
    if ps {
        let t = line.trim_end();
        if t.ends_with("@'") {
            out.push(Terminator::HereStringEnd("'@".into()));
        } else if t.ends_with("@\"") {
            out.push(Terminator::HereStringEnd("\"@".into()));
        }
        return out;
    }
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] != '<' || chars[i + 1] != '<' || (i > 0 && chars[i - 1] == '<') || chars.get(i + 2) == Some(&'<') {
            i += 1;
            continue;
        }
        i += 2;
        let dash = chars.get(i) == Some(&'-');
        if dash {
            i += 1;
        }
        while matches!(chars.get(i), Some(' ' | '\t')) {
            i += 1;
        }
        let delim: String = match chars.get(i) {
            Some(&q) if q == '\'' || q == '"' => {
                let body: String = chars[i + 1..].iter().take_while(|&&c| c != q).collect();
                i += body.chars().count() + 2;
                body
            }
            _ => {
                let word: String = chars[i.min(chars.len())..].iter().take_while(|c| c.is_alphanumeric() || **c == '_').collect();
                i += word.chars().count();
                word
            }
        };
        if !delim.is_empty() {
            out.push(if dash { Terminator::TabbedLine(delim) } else { Terminator::Line(delim) });
        }
    }
    out
}

/// Drops heredoc and here-string bodies: they are text handed to a program, and
/// a commit message or doc that has a line starting with the words of a publish
/// command is not a command. A body whose terminator never appears is kept, so
/// a stray `<<` cannot hide the lines after it.
fn strip_heredocs(command: &str, ps: bool) -> String {
    let lines: Vec<&str> = command.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        // A here-string's opener (`@'`) is dropped with its body, or the tokenizer
        // would read the quote as unterminated and swallow the lines after it.
        let t = lines[i].trim_end();
        out.push(if ps { t.strip_suffix("@'").or_else(|| t.strip_suffix("@\"")).unwrap_or(lines[i]) } else { lines[i] });
        i += 1;
        for term in heredoc_terminators(lines[i - 1], ps) {
            match lines[i..].iter().position(|l| term.closes(l)) {
                Some(p) => i += p + 1,
                None => break,
            }
        }
    }
    out.join("\n")
}

/// One shell word: its text and whether any part of it was quoted.
struct Word {
    text: String,
    quoted: bool,
}

/// Splits into command segments of words (quotes honored, backslashes literal so
/// Windows paths survive) plus the text of `$(..)` and backtick substitutions
/// found in double quotes or bare, which are commands of their own.
// The final `end_segment!` resets state nothing reads again.
#[allow(unused_assignments)]
fn split_segments(command: &str, ps: bool) -> (Vec<Vec<Word>>, Vec<String>) {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<Vec<Word>> = vec![];
    let mut nested: Vec<String> = vec![];
    let mut cur: Vec<Word> = vec![];
    let mut word = String::new();
    let mut has_word = false;
    let mut quoted = false;
    let mut i = 0;
    macro_rules! end_word {
        () => {{
            if has_word {
                cur.push(Word { text: std::mem::take(&mut word), quoted });
                has_word = false;
                quoted = false;
            }
        }};
    }
    macro_rules! end_segment {
        () => {{
            end_word!();
            if !cur.is_empty() {
                segments.push(std::mem::take(&mut cur));
            }
        }};
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                has_word = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                has_word = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if ps && chars[i] == '`' && i + 1 < chars.len() {
                        // PowerShell's escape character: the next char is literal text.
                        word.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if chars[i] == '\\' && i + 1 < chars.len() && matches!(chars[i + 1], '"' | '\\' | '$' | '`') {
                        i += 1;
                    } else if chars[i] == '`' || (chars[i] == '$' && chars.get(i + 1) == Some(&'(')) {
                        let (inner, next) = substitution(&chars, i);
                        nested.push(inner);
                        i = next;
                        continue;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
            }
            // Line continuation (`\` in sh, a backtick in PowerShell): the lines are one command.
            '\\' | '`' if (c == '`') == ps && matches!(chars.get(i + 1), Some('\n' | '\r')) => {
                end_word!();
                i += if chars.get(i + 1) == Some(&'\r') && chars.get(i + 2) == Some(&'\n') { 2 } else { 1 };
            }
            '`' if ps => {
                // PowerShell's escape character, not a substitution.
                has_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    word.push(next);
                    i += 1;
                }
            }
            '`' | '$' if c == '`' || chars.get(i + 1) == Some(&'(') => {
                end_word!();
                let (inner, next) = substitution(&chars, i);
                nested.push(inner);
                i = next;
                continue;
            }
            '&' | ';' | '|' | '\n' | '\r' | '(' | ')' | '{' | '}' => end_segment!(),
            c if c.is_whitespace() => end_word!(),
            c => {
                has_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_segment!();
    (segments, nested)
}

/// The text of a `$(..)` or backtick substitution starting at `at`, and the index
/// just past it. An unterminated one runs to the end.
fn substitution(chars: &[char], at: usize) -> (String, usize) {
    if chars[at] == '`' {
        let end = chars[at + 1..].iter().position(|&c| c == '`').map_or(chars.len(), |p| at + 1 + p);
        return (chars[at + 1..end].iter().collect(), (end + 1).min(chars.len()));
    }
    let mut depth = 0usize;
    let mut j = at + 1;
    while j < chars.len() {
        match chars[j] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return (chars[at + 2..j].iter().collect(), j + 1);
                }
            }
            _ => {}
        }
        j += 1;
    }
    (chars[(at + 2).min(chars.len())..].iter().collect(), chars.len())
}

/// The command name of a word: last path part, `.exe` dropped, lowercased.
fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

fn is_assignment(word: &Word) -> bool {
    !word.quoted && word.text.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_'))
}

fn segment_publishes(words: &[Word], depth: u8, ps: bool) -> bool {
    let mut i = 0;
    loop {
        // Skip env assignments, wrapper commands and their flags down to the real command.
        while i < words.len() && is_assignment(&words[i]) {
            i += 1;
        }
        let Some(first) = words.get(i) else { return false };
        let name = program_name(&first.text);
        if WRAPPERS.contains(&name.as_str()) {
            i += 1;
            let values = wrapper_value_flags(&name);
            while let Some(w) = words.get(i) {
                if values.contains(&w.text.as_str()) {
                    i += 2;
                } else if w.text.starts_with('-') || is_assignment(w) {
                    i += 1;
                } else {
                    break;
                }
            }
            // `timeout 5 git push`: the duration is the wrapper's, not the command.
            if name == "timeout" && words.get(i).is_some_and(|w| w.text.chars().next().is_some_and(|c| c.is_ascii_digit())) {
                i += 1;
            }
            continue;
        }
        let rest = &words[i + 1..];
        return match name.as_str() {
            "git" => git_subcommand(rest) == Some("push"),
            "gh" => {
                let mut plain = rest.iter().filter(|w| !w.text.starts_with('-')).map(|w| w.text.as_str());
                plain.next() == Some("pr") && plain.next() == Some("merge")
            }
            // The payload is every word after the flag: `cmd /c <command>` has no quotes.
            n if SHELLS.contains(&n) => rest
                .iter()
                .position(|w| matches!(w.text.to_lowercase().as_str(), "-c" | "-command" | "/c" | "-lc"))
                .is_some_and(|p| runs_publish_command_at(&join_words(&rest[p + 1..]), depth + 1, ps)),
            n if EVALS.contains(&n) => runs_publish_command_at(&join_words(rest), depth + 1, ps),
            _ => false,
        };
    }
}

fn join_words(words: &[Word]) -> String {
    words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

/// The git subcommand: the first word after the global options.
fn git_subcommand(rest: &[Word]) -> Option<&str> {
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        let t = w.text.as_str();
        if GIT_OPTS_WITH_VALUE.contains(&t) {
            i += 2;
        } else if t.starts_with('-') {
            i += 1;
        } else {
            return Some(t);
        }
    }
    None
}

pub(super) async fn on_sub_write_guard(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(decide(&ctx, &body)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::daemon::subchats::{git::test_repo, store_sub_brief, SubchatBrief, TempDataDir};
    use crate::types::Settings;

    fn ctx() -> HookCtx {
        HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) }
    }

    fn add_sub(c: &HookCtx, id: &str, cwd: &std::path::Path, writes: bool) {
        let parent = format!("{id}-main");
        c.state.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        c.state.registry.upsert_interactive(id, cwd, "proj", "2026-11-05T00:00:00Z");
        c.state.registry.set_subchat_of(id, Some(parent.clone()));
        store_sub_brief(id, &parent);
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.writes = writes;
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn call(c: &HookCtx, session: &str, tool: &str) -> Value {
        decide(c, &json!({"session_id": session, "tool_name": tool, "tool_input": {"file_path": "x"}}))
    }

    fn denied(v: &Value) -> Option<&str> {
        (v["hookSpecificOutput"]["permissionDecision"] == "deny")
            .then(|| v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap_or(""))
    }

    #[test]
    fn a_read_only_sub_has_edit_write_and_notebook_edit_refused_and_a_writer_does_not() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-reader", &root, false);
        add_sub(&c, "wg-writer", &root, true);
        for tool in ["Edit", "Write", "NotebookEdit"] {
            let answer = call(&c, "wg-reader", tool);
            let why = denied(&answer).unwrap_or_else(|| panic!("{tool} must be refused"));
            assert!(why.contains("guard, not a sandbox") && why.contains("writes: true"), "{why}");
        }
        for tool in ["Edit", "Write", "NotebookEdit"] {
            assert_eq!(call(&c, "wg-writer", tool), json!({}), "{tool}: an empty answer leaves the permission flow alone");
        }
    }

    #[test]
    fn other_tools_and_non_subs_are_never_touched() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-ro2", &root, false);
        for tool in ["Read", "Bash", "Grep"] {
            assert_eq!(call(&c, "wg-ro2", tool), json!({}), "{tool}");
        }
        // Mode off: an ordinary chat editing is none of this guard's business.
        c.state.registry.upsert_interactive("wg-plain", &root, "proj", "2026-11-05T00:00:00Z");
        assert_eq!(call(&c, "wg-plain", "Edit"), json!({}));
        assert_eq!(call(&c, "wg-ghost", "Write"), json!({}));
        assert_eq!(decide(&c, &json!({"tool_name": "Edit"})), json!({}), "no session id");
    }

    #[test]
    fn publish_commands_are_matched_in_every_shape_and_mentions_are_not() {
        for cmd in [
            "git push",
            "git push origin master",
            "git -C C:/repo push",
            "git -C \"C:\\My Repo\" push --force",
            "git -c core.x=1 --no-pager push",
            "git --git-dir=.git push",
            "cd repo && git push origin HEAD",
            "git add . ; git commit -m x; git push",
            "git status | cat\ngit push",
            "FOO=1 git push",
            "sudo git push",
            "timeout 30 git push",
            "\"C:\\Program Files\\Git\\bin\\git.exe\" push",
            "echo $(git push)",
            "echo \"done: $(git push)\"",
            "bash -c 'git fetch && git push'",
            "powershell -Command \"git push origin master\"",
            "(git push)",
            "gh pr merge 12 --squash",
            "gh pr merge",
            "cd x && gh pr merge --auto 12",
            "cmd /c git push origin master",
            "powershell -Command git push",
            "pwsh -c git push",
            "sudo -u root git push",
            "env -u FOO git push",
            "nice -n 10 git push",
            "timeout -s KILL 30 git push",
            "eval \"git push\"",
            "iex \"git push\"",
            "if true; then git push; fi",
            "! git push",
            "git \\\npush",
            "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && git push",
            "cat <<EOF >/dev/null\nunrelated\nEOF\ngit push",
            "cat <<'EOF'\ngit push with no terminator\n",
        ] {
            assert!(runs_publish_command(cmd, false), "must match: {cmd}");
        }
        for cmd in [
            "git status",
            "git log --grep push",
            "git commit -m \"push the button\"",
            "git commit -m 'git push is for gates'",
            "echo git push",
            "grep -rn \"git push\" src",
            "cat docs/gh-pr-merge.md",
            "gh pr view 12",
            "gh pr list --search merge",
            "git pull --rebase && cargo test push",
            "git diff origin/master...HEAD -- push.rs",
            "cargo test push",
            "",
            "git commit -F - <<'EOF'\ngit push is gated now\nEOF",
            "cat > docs/x.md <<'EOF'\ngit push origin master\nif git push fails\nEOF",
            "git commit -m \"$(cat <<'EOF'\nFIX: sub rule\n\nsudo git push is refused\nEOF\n)\"",
            "cat <<-EOF\n\tgit push\n\tEOF",
            "echo $((1 << 3)) && git status",
        ] {
            assert!(!runs_publish_command(cmd, false), "must not match: {cmd}");
        }
    }

    #[test]
    fn powershell_backticks_escape_and_here_strings_are_data() {
        for cmd in [
            "git commit -m \"a `$b\"; git push",
            "git commit -m \"say `\"hi`\"\"; git push",
            "Write-Host `\"hi`\"; git push",
            "git `\npush",
            "$m = @'\ntext\n'@\ngit push",
        ] {
            assert!(runs_publish_command(cmd, true), "must match: {cmd}");
        }
        for cmd in ["$m = @'\ngit push\n'@\ngit status", "git commit -m \"git `push`\"", "Write-Host `\"git push`\""] {
            assert!(!runs_publish_command(cmd, true), "must not match: {cmd}");
        }
    }

    fn shell(command: &str) -> Value {
        json!({"command": command})
    }

    #[test]
    fn a_non_gate_subs_push_is_refused_a_gate_and_a_plain_chat_are_not() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "pg-sub", &root, true);
        add_sub(&c, "pg-gate", &root, true);
        let mut gate: SubchatBrief = crate::sessions::chat_config::get("pg-gate").unwrap().subchat.unwrap();
        gate.gate = true;
        crate::sessions::chat_config::set_subchat("pg-gate", Some(gate));
        c.state.registry.upsert_interactive("pg-plain", &root, "proj", "2026-11-05T00:00:00Z");
        // Auto-accept on everywhere: the refusal must not depend on it.
        for sid in ["pg-sub", "pg-gate", "pg-plain"] {
            crate::sessions::chat_config::set_auto_accept(sid, true);
        }
        for cmd in ["git push", "git -C C:/repo push origin x", "cd a && git push", "gh pr merge 3"] {
            for tool in ["Bash", "PowerShell"] {
                let why = push_refusal(&c.state, "pg-sub", tool, &shell(cmd)).unwrap_or_else(|| panic!("{tool} {cmd} must be refused"));
                assert!(why.contains("finish_subchat") && why.contains("gate: true"), "{why}");
                assert_eq!(push_refusal(&c.state, "pg-gate", tool, &shell(cmd)), None, "a gate pushes: {cmd}");
                assert_eq!(push_refusal(&c.state, "pg-plain", tool, &shell(cmd)), None, "a plain chat is unaffected: {cmd}");
            }
        }
        // Harmless commands, other tools and unplaceable callers pass.
        assert_eq!(push_refusal(&c.state, "pg-sub", "Bash", &shell("git log --grep push")), None);
        assert_eq!(push_refusal(&c.state, "pg-sub", "Read", &shell("git push")), None);
        assert_eq!(push_refusal(&c.state, "pg-sub", "Bash", &json!({})), None);
        assert_eq!(push_refusal(&c.state, "pg-ghost", "Bash", &shell("git push")), None);
    }

    #[test]
    fn a_second_writer_is_refused_naming_the_first() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "wg-first", &root, true);
        add_sub(&c, "wg-second", &root, true);
        assert_eq!(call(&c, "wg-first", "Write"), json!({}));
        let why = denied(&call(&c, "wg-second", "Edit")).expect("refused").to_string();
        assert!(why.contains("holds this project's writer slot") && why.contains("queued"), "{why}");
    }
}
