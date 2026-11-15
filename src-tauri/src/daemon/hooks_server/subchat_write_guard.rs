//! `/hooks/sub-write-guard` (`PreToolUse`, Edit|Write|NotebookEdit|MultiEdit, plus
//! Bash|PowerShell for the push guard): the writer slot's enforcement point
//! (`subchats::writers`). Registered only in a
//! sub's hook settings (`claude_config::write_hook_settings`), so a chat that is
//! not a sub never pays for the extra round trip.
//!
//! A refusal is a `deny`. An allowed edit answers with an EMPTY object and not
//! `allow`: a hook's `allow` skips Claude Code's permission check, which would
//! hand every sub auto-accept for its edits and break the rule that a sub's
//! permission prompts reach Joe.
//!
//! The push guard (`push_refusal`) reads the command text with a small tokenizer,
//! not a shell, so it is a guard and not a sandbox. It refuses a command word that
//! publishes (`git push`, `gh pr merge`, a mutating `gh api` to a merge endpoint),
//! however it is wrapped, and never a bare mention of one.
//!
//! # Known gaps
//!
//! Each of these runs a publish command past the guard; closing one needs a real
//! shell parser or reading files the guard cannot see.
//!
//! - A program that runs git itself (`python -c`, `node -e`, `make push`, a script
//!   file, `bash script.sh`, `source f`, `. f`): the command text names only the
//!   program, and the guard does not open files.
//! - A pipe into a shell whose fed text is not in the command (`cat f | bash`,
//!   `curl ... | sh`, `bash < f`) and process substitution (`bash <(echo ...)`):
//!   refused only when the visible fed text holds a publish command.
//! - A git alias that lives in a config file (`git config alias.p push`, then
//!   `git p` in a later command, or `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` env
//!   variables) and a `gh alias` that maps to `pr merge`: the alias is defined
//!   outside the command being read.
//! - `gh api graphql` carrying a `mergePullRequest` mutation, and a `gh api` call
//!   that pushes through a git refs endpoint: only the REST merge endpoints are read.
//! - Other runners of a command word: `env -S 'git push'`, `su -c`, `watch`,
//!   `parallel`, `script -c`, `ssh host git push`, `docker run ... git push`,
//!   PowerShell `Start-Process git -ArgumentList push` and `Invoke-Command`.
//! - A PowerShell here-string piped to `iex` (`@'..'@ | iex`): here-string bodies
//!   are dropped as data.
//! - A command word built from a variable (`g=git; $g push`): variables are not
//!   expanded.
//! - A `<<` that opens a fake heredoc inside a quoted string, and a `$(..)` inside an
//!   unquoted heredoc body: the heredoc scan is line based and does not parse quotes.

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
/// The shell tools the push guard reads (`push_refusal`).
const SHELL_TOOLS: [&str; 2] = ["Bash", "PowerShell"];

pub(super) fn decide(ctx: &HookCtx, body: &Value) -> Value {
    let tool = body.get("tool_name").and_then(Value::as_str).unwrap_or("");
    // Unidentifiable callers pass: this guard never blocks a chat it cannot place.
    let Some(session_id) = body.get("session_id").and_then(Value::as_str) else { return json!({}) };
    // A shell call is checked for a publish command here as well as in the permission
    // relay: with the user's own allow rule (`Bash(git push*)`) or auto mode, Claude
    // Code never asks the relay, but a PreToolUse hook always runs.
    if SHELL_TOOLS.contains(&tool) {
        let input = body.get("tool_input").unwrap_or(&Value::Null);
        return match push_refusal(&ctx.state, session_id, tool, input) {
            Some(refusal) => deny_decision(refusal),
            None => json!({}),
        };
    }
    if !WRITE_TOOLS.contains(&tool) {
        return json!({});
    }
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
const WRAPPERS: [&str; 18] = [
    "sudo", "env", "command", "exec", "time", "nohup", "nice", "timeout", "xargs", "builtin", "then", "do", "else", "elif", "if", "while", "until",
    "!",
];
/// A wrapper's flags that take their value as the NEXT word (`sudo -u root git push`).
fn wrapper_value_flags(name: &str) -> &'static [&'static str] {
    match name {
        "sudo" => &[
            "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--chroot", "--role", "--type",
            "--close-from", "--command-timeout",
        ],
        "env" => &["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
        "nice" => &["-n", "--adjustment"],
        "timeout" => &["-s", "-k", "--signal", "--kill-after"],
        "xargs" => &["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--replace", "--arg-file"],
        _ => &[],
    }
}

/// Whether `flag` takes the NEXT word as its value. A short flag cluster counts too:
/// `-Eu root` consumes `root`, while `-uroot` and `-n10` carry their value attached.
fn flag_consumes_next(values: &[&str], flag: &str) -> bool {
    if values.contains(&flag) {
        return true;
    }
    let body = match flag.strip_prefix('-') {
        Some(b) if !b.starts_with('-') && b.chars().count() > 1 => b,
        _ => return false,
    };
    let count = body.chars().count();
    body.chars().enumerate().find(|(_, c)| values.contains(&format!("-{c}").as_str())).is_some_and(|(k, _)| k + 1 == count)
}
const SHELLS: [&str; 9] = ["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"];
/// Commands whose arguments ARE a command line (`eval "..."`).
const EVALS: [&str; 3] = ["eval", "iex", "invoke-expression"];
/// `git` options that take their value as the NEXT word.
const GIT_OPTS_WITH_VALUE: [&str; 7] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"];
/// How many levels of nested command text (`$(..)`, `bash -c`, `eval`, a piped
/// feed) are read. Text nested deeper is refused when it names a publish verb at
/// all, because the tokenizer stops being asked to prove it harmless.
const MAX_DEPTH: u8 = 8;

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
    if depth > MAX_DEPTH {
        let lower = command.to_lowercase();
        return lower.contains("push") || lower.contains("merge");
    }
    let (segments, nested, piped) = split_segments(&strip_heredocs(command, ps), ps);
    if nested.iter().any(|n| runs_publish_command_at(n, depth + 1, ps)) {
        return true;
    }
    segments.iter().enumerate().any(|(idx, seg)| {
        // The segments feeding this one through a pipe, nearest first: what
        // `echo 'git push' | bash` hands to the shell.
        let mut fed: Vec<&[Word]> = vec![];
        let mut at = idx;
        while at > 0 && piped[at] {
            at -= 1;
            fed.push(&segments[at]);
        }
        segment_publishes(seg, depth, ps, &fed)
    })
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

/// Whether a stage after a `|` on this line is a shell (`cat <<EOF | bash`), possibly
/// behind a wrapper (`| sudo bash`).
fn line_pipes_into_shell(line: &str) -> bool {
    line.split('|').skip(1).any(|stage| {
        let first = stage.split_whitespace().find(|w| !w.starts_with('-') && !WRAPPERS.contains(&program_name(w).as_str()) && *w != "&");
        first.is_some_and(|w| SHELLS.contains(&program_name(w).as_str()))
    })
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
        let line = lines[i];
        i += 1;
        let mut kept = line;
        // A shell reads its heredoc as commands (`bash <<EOF`, `cat <<EOF | bash`),
        // so that body stays.
        let feeds_a_shell = line.split("<<").next().unwrap_or("").split_whitespace().any(|w| SHELLS.contains(&program_name(w).as_str()))
            || line_pipes_into_shell(line);
        if !feeds_a_shell {
            for term in heredoc_terminators(line, ps) {
                match lines[i..].iter().position(|l| term.closes(l)) {
                    Some(p) => {
                        i += p + 1;
                        // A here-string's opener (`@'`) goes with its body, or the
                        // tokenizer reads its quote as unterminated and swallows the
                        // lines after it. Only when the body really ends.
                        let t = line.trim_end();
                        if ps {
                            kept = t.strip_suffix("@'").or_else(|| t.strip_suffix("@\"")).unwrap_or(line);
                        }
                    }
                    None => break,
                }
            }
        }
        out.push(kept);
    }
    out.join("\n")
}

/// Stands in a word for a substitution whose output is unknown.
const SUBSTITUTED: char = '\u{1}';

/// One shell word: its text, the byte offset in `text` where its first quote
/// opened, and whether it starts with an unquoted redirection operator (`>log`,
/// `2>&1`, `<in`, `<<EOF`).
#[derive(Clone)]
struct Word {
    text: String,
    first_quote: Option<usize>,
    op: bool,
}

/// Splits into command segments of words (quotes honored, backslashes literal so
/// Windows paths survive) plus the text of `$(..)` and backtick substitutions
/// found in double quotes or bare, which are commands of their own. The third
/// value says, per segment, whether a single `|` (or `|&`) feeds it.
// The final `end_segment!` resets state nothing reads again.
#[allow(unused_assignments)]
fn split_segments(command: &str, ps: bool) -> (Vec<Vec<Word>>, Vec<String>, Vec<bool>) {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<Vec<Word>> = vec![];
    let mut piped: Vec<bool> = vec![];
    let mut nested: Vec<String> = vec![];
    let mut cur: Vec<Word> = vec![];
    let mut word = String::new();
    let mut has_word = false;
    let mut first_quote: Option<usize> = None;
    let mut op = false;
    // Set by a `|`, consumed by the segment that follows it.
    let mut pending_pipe = false;
    let mut i = 0;
    macro_rules! end_word {
        () => {{
            if has_word {
                cur.push(Word { text: std::mem::take(&mut word), first_quote, op });
                has_word = false;
                first_quote = None;
                op = false;
            }
        }};
    }
    macro_rules! end_segment {
        () => {{
            end_word!();
            if !cur.is_empty() {
                segments.push(std::mem::take(&mut cur));
                piped.push(pending_pipe);
                pending_pipe = false;
            }
        }};
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                has_word = true;
                first_quote.get_or_insert(word.len());
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                has_word = true;
                first_quote.get_or_insert(word.len());
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if ps && chars[i] == '`' && i + 1 < chars.len() {
                        // PowerShell's escape character: the next char is literal text.
                        word.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if !ps && chars[i] == '\\' && i + 1 < chars.len() && matches!(chars[i + 1], '"' | '\\' | '$' | '`') {
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
            // A comment runs to the end of the line; its apostrophes open no quote.
            '#' if !has_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            // Line continuation (`\` in sh, a backtick in PowerShell): the lines are one command.
            '\\' | '`' if (c == '`') == ps && matches!(chars.get(i + 1), Some('\n' | '\r')) => {
                end_word!();
                i += if chars.get(i + 1) == Some(&'\r') && chars.get(i + 2) == Some(&'\n') { 2 } else { 1 };
            }
            // sh: a backslash outside quotes makes the next char literal (`it\'s`).
            '\\' if !ps => {
                has_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    word.push(next);
                    i += 1;
                }
            }
            '`' if ps => {
                // PowerShell's escape character, not a substitution.
                has_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    word.push(next);
                    i += 1;
                }
            }
            // `${VAR}` is one argument, not three segments split at the braces.
            '$' if chars.get(i + 1) == Some(&'{') => {
                let end = chars[i..].iter().position(|&c| c == '}').map_or(chars.len(), |p| i + p + 1);
                // A command inside (`${X:-$(git push)}`) still runs.
                nested.push(chars[i + 2..end.saturating_sub(1).max(i + 2)].iter().collect());
                has_word = true;
                word.push(SUBSTITUTED);
                i = end;
                continue;
            }
            '`' | '$' if c == '`' || chars.get(i + 1) == Some(&'(') => {
                let (inner, next) = substitution(&chars, i);
                nested.push(inner);
                // The substitution stands for part of ONE argument, glued to what is
                // around it: `git -C $(pwd) push` keeps `-C`'s value out of the
                // subcommand, and `FOO=$(pwd) git push` stays an assignment.
                has_word = true;
                word.push(SUBSTITUTED);
                i = next;
                continue;
            }
            // `||` is a list operator, `|` and `|&` a pipe: what comes out of the left
            // side is the right side's input.
            '|' => {
                end_segment!();
                if chars.get(i + 1) == Some(&'|') {
                    pending_pipe = false;
                    i += 1;
                } else {
                    pending_pipe = true;
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                }
            }
            // The `&` of `2>&1` / `<&3` belongs to the redirection, not a new command.
            '&' if i > 0 && matches!(chars[i - 1], '>' | '<') => {
                has_word = true;
                word.push(c);
            }
            // A redirection ends the word before it (`git push>log`); a digits-only word
            // is its file descriptor (`2>x`).
            '>' | '<' => {
                // `>>`, `<<<` and `>&` are one operator, not three words.
                let in_operator = op && word.chars().all(|d| d.is_ascii_digit() || matches!(d, '<' | '>' | '&'));
                if has_word && !in_operator && !word.chars().all(|d| d.is_ascii_digit()) {
                    end_word!();
                }
                if !has_word || word.chars().all(|d| d.is_ascii_digit()) {
                    op = true;
                }
                has_word = true;
                word.push(c);
            }
            '&' | ';' => {
                end_segment!();
                pending_pipe = false;
            }
            '\n' | '\r' | '(' | ')' | '{' | '}' => end_segment!(),
            c if c.is_whitespace() => end_word!(),
            c => {
                has_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_segment!();
    (segments, nested, piped)
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

/// `NAME=value`. Only a quote inside the NAME makes the word a command name instead, so
/// a quoted VALUE (`GIT_SSH_COMMAND="ssh -i k" git push`) is still an assignment.
fn is_assignment(word: &Word) -> bool {
    word.text.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_') && word.first_quote.is_none_or(|q| q > k.len())
    })
}

/// A wrapper's own argument `NAME=value`, quoted or not: `env "A=b" git push` sets A,
/// while the same word LEADING a command is a command name (`is_assignment`).
fn is_wrapper_assignment(word: &Word) -> bool {
    word.text.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_'))
}

/// Drops redirections (`>log`, `2>&1`, `< in`, `<<EOF`) from a segment, so one can
/// neither stand in the command position (`>log git push`) nor sit between a command
/// and its subcommand (`git >log push`). A here-string's text (`<<< 'git push'`) is
/// returned apart, because a shell reads it as commands.
fn strip_redirects(words: &[Word]) -> (Vec<Word>, Vec<String>) {
    let mut out = vec![];
    let mut here = vec![];
    let mut i = 0;
    while let Some(w) = words.get(i) {
        i += 1;
        if !w.op {
            out.push(w.clone());
            continue;
        }
        let body = w.text.trim_start_matches(|c: char| c.is_ascii_digit());
        let here_string = body.starts_with("<<<");
        let operand = if here_string { body.trim_start_matches('<') } else { body.trim_start_matches(['<', '>', '&', '|']) };
        // An operator on its own (`> log`) takes the next word as its target.
        let operand = if operand.is_empty() {
            let next = words.get(i).map(|n| n.text.as_str()).unwrap_or("");
            i += 1;
            next
        } else {
            operand
        };
        if here_string {
            here.push(operand.to_string());
        }
    }
    (out, here)
}

fn segment_publishes(raw: &[Word], depth: u8, ps: bool, fed: &[&[Word]]) -> bool {
    let (mut words, here) = strip_redirects(raw);
    let mut i = 0;
    loop {
        // Skip env assignments, wrapper commands and their flags down to the real command.
        while i < words.len() && is_assignment(&words[i]) {
            i += 1;
        }
        // PowerShell `$out = git ...`, `$null = git ...`, `$x=git ...`: the command follows
        // the assignment, whether or not spaces surround the `=`.
        if ps {
            if let Some(w) = words.get(i).filter(|w| w.text.starts_with('$') && w.first_quote.is_none()) {
                if let Some((_, after)) = w.text.split_once('=') {
                    let after = after.to_string();
                    if after.is_empty() {
                        i += 1;
                    } else {
                        words[i].text = after;
                    }
                    continue;
                }
                let after = words.get(i + 1).and_then(|n| n.text.strip_prefix("+=").or_else(|| n.text.strip_prefix('='))).map(str::to_string);
                if let Some(after) = after {
                    if after.is_empty() {
                        i += 2;
                    } else {
                        words[i + 1].text = after;
                        i += 1;
                    }
                    continue;
                }
            }
        }
        let Some(first) = words.get(i) else { return false };
        let name = program_name(&first.text);
        if WRAPPERS.contains(&name.as_str()) {
            i += 1;
            let values = wrapper_value_flags(&name);
            while let Some(w) = words.get(i) {
                if flag_consumes_next(values, &w.text) {
                    i += 2;
                } else if w.text.starts_with('-') || is_wrapper_assignment(w) {
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
            "git" => git_publishes(rest, depth, ps),
            "gh" => gh_publishes(rest),
            "find" => find_exec_publishes(rest, depth, ps),
            "wsl" => wsl_publishes(rest, depth, ps),
            n if SHELLS.contains(&n) => shell_publishes(n, rest, &here, fed, depth, ps),
            // A bare `iex` / `eval` runs what is piped into it.
            n if EVALS.contains(&n) && rest.is_empty() => fed_publishes(fed, depth, ps),
            n if EVALS.contains(&n) => runs_publish_command_at(&join_words(rest), depth + 1, ps),
            _ => false,
        };
    }
}

/// A shell's payload: the command text of `-c` (`bash -ec 'git push'`, `sh -xc ..`),
/// of PowerShell's `-Command` / `-EncodedCommand` (any unambiguous abbreviation) and
/// of `cmd /c`, or, with none, the here-string and the piped text it reads.
fn shell_publishes(name: &str, rest: &[Word], here: &[String], fed: &[&[Word]], depth: u8, ps: bool) -> bool {
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        let flag = w.text.to_lowercase();
        i += 1;
        match name {
            "cmd" => {
                // `cmd /c <command>` has no quotes of its own: the payload is every word after it.
                if matches!(flag.as_str(), "/c" | "/k" | "/r") {
                    return runs_publish_command_at(&join_words(&rest[i..]), depth + 1, false);
                }
            }
            // PowerShell joins every word after `-Command` into one command line.
            "pwsh" | "powershell" => {
                let Some(f) = flag.strip_prefix(['-', '/']).filter(|f| !f.is_empty()) else { continue };
                if "command".starts_with(f) {
                    let payload = join_words(&rest[i..]);
                    if payload.trim() == "-" {
                        break;
                    }
                    return runs_publish_command_at(&payload, depth + 1, true);
                }
                if "encodedcommand".starts_with(f) || f == "ec" {
                    return rest.get(i).and_then(|p| decode_encoded_command(&p.text)).is_some_and(|c| runs_publish_command_at(&c, depth + 1, true));
                }
            }
            // sh-family: the command string is the ONE word after the flag cluster
            // containing `c`; any later words are `$0`, `$1` for it, never commands.
            _ => {
                let option = w.text.starts_with('-') || w.text.starts_with('+');
                let long = w.text.starts_with("--");
                if matches!(flag.as_str(), "-o" | "+o") {
                    // `-o pipefail`: the option's name is its value, not a script.
                    i += 1;
                } else if !long && w.text.starts_with('-') && w.text[1..].chars().all(|c| c.is_ascii_alphabetic()) && w.text.contains('c') {
                    return rest.get(i).is_some_and(|p| runs_publish_command_at(&p.text, depth + 1, false));
                } else if !option {
                    // A script file: the shell reads that file, not a command text.
                    break;
                }
            }
        }
    }
    here.iter().any(|h| runs_publish_command_at(h, depth + 1, false)) || fed_publishes(fed, depth, ps)
}

/// `powershell -EncodedCommand <base64 of UTF-16LE text>`, decoded. `None` when it is not.
fn decode_encoded_command(b64: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64.trim().trim_end_matches('=')).ok()?;
    let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
    Some(String::from_utf16_lossy(&units))
}

/// Whether text visibly piped into a shell is a publish command: the arguments of the
/// segments in front of it (`echo 'git push' | bash`). What a file or another command
/// prints is not in the command text, so it never counts.
fn fed_publishes(fed: &[&[Word]], depth: u8, ps: bool) -> bool {
    // `printf 'git fetch\ngit push\n'` prints real newlines.
    let publishes = |text: &str| runs_publish_command_at(&text.replace("\\n", "\n"), depth + 1, ps);
    fed.iter().any(|seg| {
        let args = seg.get(1..).unwrap_or(&[]);
        // A bare quoted string is the text itself in PowerShell (`'git push' | iex`).
        let literal = seg.first().filter(|w| w.first_quote.is_some()).is_some_and(|w| publishes(&w.text));
        literal || (0..args.len()).any(|k| publishes(&join_words(&args[k..]))) || args.iter().filter(|w| w.first_quote.is_some()).any(|w| publishes(&w.text))
    })
}

/// `find ... -exec git push \;` (also `-execdir`, `-ok`, `-okdir`): the words after
/// the flag are a command.
fn find_exec_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
    rest.iter()
        .enumerate()
        .filter(|(_, w)| matches!(w.text.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))
        .any(|(p, _)| segment_publishes(&rest[p + 1..], depth + 1, ps, &[]))
}

/// `gh`'s flags that take their value as the NEXT word before the subcommand.
const GH_VALUE_FLAGS: [&str; 3] = ["-R", "--repo", "--hostname"];
/// The same for `gh api`.
const GH_API_VALUE_FLAGS: [&str; 16] =
    ["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"];

/// `gh pr merge` (flags with a value allowed before the leaf: `-R owner/repo`,
/// `--hostname h`) and `gh api -X PUT repos/o/r/pulls/N/merge`, a mutating call to a
/// merge endpoint. A GET on that path only asks whether the pull request is merged.
fn gh_publishes(rest: &[Word]) -> bool {
    let mut plain: Vec<&str> = vec![];
    let mut method: Option<&str> = None;
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        let t = w.text.as_str();
        i += 1;
        let api = plain.first() == Some(&"api");
        if GH_VALUE_FLAGS.contains(&t) || (api && GH_API_VALUE_FLAGS.contains(&t)) {
            if api && matches!(t, "-X" | "--method") {
                method = rest.get(i).map(|n| n.text.as_str());
            }
            i += 1;
        } else if api && t.starts_with("--method=") {
            method = t.strip_prefix("--method=");
        } else if api && t.starts_with("-X") && !t.starts_with("--") {
            method = Some(&t[2..]);
        } else if !t.starts_with('-') {
            plain.push(t);
        }
    }
    if plain.starts_with(&["pr", "merge"]) {
        return true;
    }
    let mutating = method.is_some_and(|m| matches!(m.to_ascii_uppercase().as_str(), "PUT" | "POST" | "PATCH" | "DELETE"));
    let endpoint = plain.get(1).map(|e| e.split('?').next().unwrap_or(e).trim_end_matches('/'));
    plain.first() == Some(&"api") && mutating && endpoint.is_some_and(|e| e.ends_with("/merge") || e.ends_with("/merges"))
}

fn join_words(words: &[Word]) -> String {
    words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

/// The git subcommand (the first word after the global options) and the aliases the
/// same command line defines (`-c alias.p=push`).
fn git_scan<'a>(args: &[&'a str]) -> (Option<&'a str>, Vec<(&'a str, &'a str)>) {
    let mut aliases = vec![];
    let mut i = 0;
    while let Some(&t) = args.get(i) {
        if t == "-c" {
            if let Some((key, value)) = args.get(i + 1).copied().and_then(|kv| kv.split_once('=')) {
                if key.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("alias.")) {
                    aliases.push((&key[6..], value));
                }
            }
            i += 2;
        } else if GIT_OPTS_WITH_VALUE.contains(&t) {
            i += 2;
        } else if t.starts_with('-') {
            i += 1;
        } else {
            return (Some(t), aliases);
        }
    }
    (None, aliases)
}

/// Git subcommands that publish or run a command line of their own: `git subtree push`,
/// `git submodule foreach '<cmd>'` and `git rebase -x '<cmd>'` (`--exec`, `--exec=<cmd>`,
/// `-x<cmd>`). `args` are the words after the subcommand; each command line is read
/// as a shell command.
fn git_subcommand_runs_publish(sub: &str, args: &[&str], depth: u8, ps: bool) -> bool {
    match sub {
        "subtree" => args.contains(&"push"),
        "submodule" => args.iter().position(|a| *a == "foreach").is_some_and(|p| {
            let payload = args[p + 1..].iter().filter(|a| **a != "--recursive").copied().collect::<Vec<_>>().join(" ");
            runs_publish_command_at(&payload, depth + 1, ps)
        }),
        "rebase" => args.iter().enumerate().any(|(k, a)| {
            let cmd = if matches!(*a, "-x" | "--exec") {
                args.get(k + 1).copied()
            } else if let Some(v) = a.strip_prefix("--exec=") {
                Some(v)
            } else if a.starts_with("-x") && !a.starts_with("--") {
                Some(&a[2..])
            } else {
                None
            };
            cmd.is_some_and(|c| runs_publish_command_at(c, depth + 1, ps))
        }),
        _ => false,
    }
}

/// `wsl [options] [--] <command>`: the Windows-side launcher of a Linux command. Its
/// value flags (`-d <distro>`, `-u <user>`, `--cd <dir>`) are skipped, the rest is a command.
fn wsl_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        match w.text.as_str() {
            "-d" | "--distribution" | "-u" | "--user" | "--cd" => i += 2,
            t if t.starts_with('-') => i += 1,
            _ => break,
        }
    }
    segment_publishes(rest.get(i..).unwrap_or(&[]), depth + 1, ps, &[])
}

/// Whether the git subcommand is `push`, directly or through an alias defined on the
/// same line (`git -c alias.p=push p`, `-c alias.p='!git push'`).
fn git_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
    let args: Vec<&str> = rest.iter().map(|w| w.text.as_str()).collect();
    let (sub, aliases) = git_scan(&args);
    if let Some(name) = sub {
        // The words after the subcommand; `sub` is one of `args`, so pointer equality finds it.
        let at = args.iter().position(|a| std::ptr::eq(*a, name)).map_or(args.len(), |p| p + 1);
        if git_subcommand_runs_publish(name, &args[at..], depth, ps) {
            return true;
        }
    }
    let mut cur = sub;
    // An alias may name another alias; git stops a loop, so this walk is bounded.
    for _ in 0..8 {
        let Some(name) = cur else { return false };
        // A built-in wins over an alias of the same name.
        if name == "push" {
            return true;
        }
        let Some(&(_, value)) = aliases.iter().find(|(n, _)| *n == name) else { return false };
        if let Some(shell) = value.strip_prefix('!') {
            return runs_publish_command_at(shell, depth + 1, ps);
        }
        let tokens: Vec<&str> = value.split_whitespace().collect();
        cur = git_scan(&tokens).0;
    }
    false
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
            "# don't push yet\ngit commit -m x\ngit push",
            "bash <<'EOF'\ngit push\nEOF",
            "until git push; do sleep 2; done",
            "git -C $(git rev-parse --show-toplevel) push",
            "git -C `pwd` push origin x",
            "git -C ${REPO} push",
            "git push origin ${BRANCH}",
            "FOO=$(pwd) git push",
            "git -c user.name=$(whoami) push",
            "git --git-dir=$(pwd) push",
            "gh --repo=$(pwd) pr merge 3",
            "echo ${X:-$(git push)}",
            "gh pr -R owner/repo merge 3",
            "gh pr --repo owner/repo merge 3 --squash",
            "echo it\\'s; git push",
            "FOO=\"x\" git push",
            "GIT_SSH_COMMAND=\"ssh -i k\" git push",
            "FOO='bar baz' git push origin x",
            "env GIT_SSH_COMMAND=\"ssh -i k\" git push",
            "env \"GIT_SSH_COMMAND=ssh -i k\" git push",
            "env 'A=b' git push",
            "A=1 B=\"two words\" git push",
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
            "# commit locally only; git push is for the gate\ngit commit -m x",
            "echo a#b && git status",
            "gh pr list --search merge",
            "echo ${UNCLOSED",
            "echo ${A}${B} && git status",
            "FOO=\"x\" git status",
            "GIT_SSH_COMMAND=\"ssh -i k\" git fetch",
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
            "$out = git push origin master 2>&1",
            "$null = git push",
            "cd \"C:\\repo\\\"; git push",
            "Write-Host 'me@'; git push",
        ] {
            assert!(runs_publish_command(cmd, true), "must match: {cmd}");
        }
        for cmd in ["$m = @'\ngit push\n'@\ngit status", "git commit -m \"git `push`\"", "Write-Host `\"git push`\""] {
            assert!(!runs_publish_command(cmd, true), "must not match: {cmd}");
        }
    }

    /// `text` as `powershell -EncodedCommand` wants it: UTF-16LE, base64.
    fn encoded(text: &str) -> String {
        use base64::Engine;
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// `git push` wrapped in `levels` command substitutions.
    fn nested(levels: usize, inner: &str) -> String {
        (0..levels).fold(inner.to_string(), |acc, _| format!("echo $({acc})"))
    }

    /// Every row is checked before the test fails, so one run names every shape a
    /// matcher misses (a red run lists them all instead of stopping at the first).
    fn mismatches(rows: &[String], ps: bool, want: bool) -> Vec<String> {
        rows.iter().filter(|c| runs_publish_command(c, ps) != want).cloned().collect()
    }

    fn rows(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn combined_shell_flags_and_wrapper_long_flags_are_recursed_into() {
        let must = rows(&[
            "bash -ec 'git push'",
            "sh -xc 'git push'",
            "bash -euc 'git push origin x'",
            "zsh -ec \"git push\"",
            "dash -ec 'git push'",
            "bash -o pipefail -c 'git push'",
            "bash --norc -c 'git push'",
            "bash -ic 'cd x && git push'",
            "ksh -c 'git push'",
            "fish -c 'git push'",
            "sudo --user root git push",
            "sudo --user=root git push",
            "sudo -Hu root git push",
            "sudo --preserve-env --user root -- git push",
            "env --chdir /x git push",
            "timeout --signal KILL 30 git push",
            "gh --hostname h pr merge 3",
            "gh --hostname h.example.com pr merge",
            "gh -R o/r --hostname h pr merge",
        ]);
        assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
        let must_not = rows(&[
            "bash -c 'git status'",
            "bash -ec 'git status'",
            "sh -xc 'echo git push'",
            "sudo --user root git status",
            "gh --hostname h pr view 3",
            "bash -c \"git commit -m 'a; git push'\"",
            "bash -c \"git commit -m \\\"a; git push\\\"\"",
            "sh -xc 'git commit -m \"x && git push\"'",
            // The payload is the one word after -c; the rest are $0, $1 for it.
            "bash -c 'echo $0' git push",
            "bash -c sudo git push",
            "bash script.sh",
        ]);
        assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
    }

    #[test]
    fn gh_api_calls_that_merge_a_pull_request_are_refused() {
        let must = rows(&[
            "gh api -X PUT repos/o/r/pulls/12/merge",
            "gh api --method PUT repos/o/r/pulls/12/merge -f merge_method=squash",
            "gh api -XPUT repos/o/r/pulls/3/merge",
            "gh api --method=PUT /repos/o/r/pulls/3/merge",
            "gh api -X POST repos/o/r/pulls/1/merge",
            "gh api repos/o/r/pulls/1/merge -X PUT",
            "gh api -X put \"repos/o/r/pulls/1/merge\"",
            "gh --hostname h api -X PUT repos/o/r/pulls/1/merge",
            "gh api -X POST repos/o/r/merges -f base=master -f head=x",
            "cd x && gh api -X PUT repos/o/r/pulls/9/merge --jq .merged",
        ]);
        assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
        let must_not = rows(&[
            // A GET on the merge path only asks whether the pull request is merged.
            "gh api repos/o/r/pulls/1/merge",
            "gh api -X GET repos/o/r/pulls/1/merge",
            "gh api -X PUT repos/o/r/issues/1/labels",
            "gh api repos/o/r/pulls/1",
            "gh api -H 'Accept: x' repos/o/r/pulls/1/files",
            "gh api -X PUT repos/o/r/pulls/1/merge-queue-note",
            "echo gh api -X PUT repos/o/r/pulls/1/merge",
        ]);
        assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
    }

    // Git runs a command line of its own for these, and `wsl` hands its words to a Linux shell.
    #[test]
    fn git_and_wsl_wrappers_that_run_a_publish_are_refused() {
        let must = rows(&[
            "git submodule foreach 'git push'",
            "git submodule foreach --recursive 'git push origin HEAD'",
            "git submodule foreach \"git -C . push\"",
            "git subtree push --prefix=lib lib master",
            "git -C x subtree push -P lib remote main",
            "git rebase -x 'git push' HEAD~3",
            "git rebase -i --exec 'git push' main",
            "git rebase --exec='git push' main",
            "git rebase -x'git push' main",
            "wsl git push",
            "wsl.exe git push origin master",
            "wsl -d Ubuntu git push",
            "wsl -d Ubuntu -u root -- git push",
            "wsl bash -c 'git push'",
            "cd x && wsl gh pr merge 3",
        ]);
        assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
        let must_not = rows(&[
            "git submodule foreach 'git status'",
            "git submodule update --init",
            "git subtree pull --prefix=lib lib master",
            "git subtree split --prefix=lib",
            "git rebase -x 'cargo test' main",
            "git rebase --exec='make check' main",
            "git rebase main",
            "wsl git status",
            "wsl -d Ubuntu ls",
            "wsl --list",
            "echo wsl git push",
        ]);
        assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
    }

    #[test]
    fn redirects_assignments_and_encoded_commands_do_not_hide_a_publish() {
        let must = rows(&[
            ">log git push",
            "> log git push",
            "2>&1 git push",
            "git >log push",
            "git push>log",
            "git push 2>&1 | tail -1",
            ">\"my log\" git push",
            "<in git push",
            "FOO=1 >log git push",
        ]);
        assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "bash must match");
        let must_not = rows(&[">log git status", "> log git status", "2>&1 git log", "echo a>b && git status", "git log >push"]);
        assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "bash must not match");

        let ps_must = vec![
            "$x = git push".to_string(),
            "$x=git push".to_string(),
            "$x= git push".to_string(),
            "$x =git push".to_string(),
            "$x += git push".to_string(),
            "$env:X=git push".to_string(),
            format!("powershell -EncodedCommand {}", encoded("git push origin master")),
            format!("pwsh -enc {}", encoded("git status; git push")),
            format!("pwsh -NoProfile -ec {}", encoded("git push")),
            format!("powershell.exe -e {}", encoded("gh pr merge 3")),
            format!("bash -c 'powershell -EncodedCommand {}'", encoded("git push")),
        ];
        assert_eq!(mismatches(&ps_must, true, true), Vec::<String>::new(), "powershell must match");
        let ps_must_not = vec![
            "$x = git status".to_string(),
            "$x=git status".to_string(),
            "$x='git push'".to_string(),
            "$x = 'git push'".to_string(),
            format!("powershell -EncodedCommand {}", encoded("git status")),
            "powershell -EncodedCommand !!!notbase64".to_string(),
            "powershell -EncodedCommand".to_string(),
        ];
        assert_eq!(mismatches(&ps_must_not, true, false), Vec::<String>::new(), "powershell must not match");
    }

    #[test]
    fn nesting_past_the_depth_cap_is_refused_when_it_holds_a_publish_verb() {
        let deep_push = vec![nested(3, "git push"), nested(7, "git push"), nested(12, "git push"), nested(40, "git push")];
        assert_eq!(mismatches(&deep_push, false, true), Vec::<String>::new(), "a publish at any depth is refused");
        let deep_harmless = vec![nested(3, "git status"), nested(12, "git status"), nested(40, "date")];
        assert_eq!(mismatches(&deep_harmless, false, false), Vec::<String>::new(), "deep nesting alone is not refused");
        let shells = rows(&["bash -c \"bash -c 'git push'\"", "bash -c \"bash -c \\\"bash -c 'git push'\\\"\""]);
        assert_eq!(mismatches(&shells, false, true), Vec::<String>::new(), "nested shells");
    }

    #[test]
    fn text_piped_or_aliased_into_a_publish_is_refused_when_it_is_visible() {
        let must = rows(&[
            "echo 'git push' | bash",
            "echo git push | sh",
            "printf 'git push\\n' | bash -s",
            "printf '%s\\n' 'git fetch' 'git push' | bash",
            "echo 'git push' | tee x | bash",
            "echo 'git push' | sudo bash",
            "cat <<EOF | bash\ngit push\nEOF",
            "cat <<'EOF' | sh -s\ngit push origin x\nEOF",
            "bash <<< 'git push'",
            "bash <<<'git push'",
            "echo 'git push' |& bash",
            "echo 'git push' |\n bash",
            "find . -name x -exec git push \\;",
            "find . -exec git -C x push {} +",
            "find . -execdir git push \\; -quit",
            "git -c alias.p=push p",
            "git -c alias.p='!git push' p",
            "git -c alias.ps=\"push --force\" ps origin",
            "git -c alias.a=p -c alias.p=push a",
            "git -C x -c alias.p=push --no-pager p",
        ]);
        assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
        let must_not = rows(&[
            "echo 'git status' | bash",
            "echo hi | bash",
            "cat x | bash",
            "echo 'git push' | cat",
            "echo 'git push' | grep push",
            "echo git push > notes.txt",
            "cat <<EOF | grep x\ngit push\nEOF",
            "cat <<EOF | tee notes.txt\ngit push\nEOF",
            "bash <<< 'git status'",
            "echo a || bash\ngit status",
            "find . -name push",
            "find . -exec grep push {} \\;",
            "git -c alias.p=status p",
            "git -c alias.p='!echo hi' p",
            "git -c user.name=x status",
            "git -c alias.a=b -c alias.b=a a",
            "git p",
        ]);
        assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
        let ps_must = rows(&["'git push' | iex", "\"git push\" | Invoke-Expression", "Write-Output 'git push' | iex", "echo 'git push' | pwsh"]);
        assert_eq!(mismatches(&ps_must, true, true), Vec::<String>::new(), "powershell must match");
        let ps_must_not = rows(&["'git status' | iex", "Get-Content x | iex", "'git push' | Out-File x"]);
        assert_eq!(mismatches(&ps_must_not, true, false), Vec::<String>::new(), "powershell must not match");
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

    // The hook path: with an allow rule on `git push` Claude Code never asks the
    // permission relay, so the PreToolUse hook is the only place the guard can run.
    #[test]
    fn the_pre_tool_use_hook_denies_a_non_gate_subs_push_and_leaves_the_rest() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let c = ctx();
        add_sub(&c, "ph-sub", &root, true);
        c.state.registry.upsert_interactive("ph-plain", &root, "proj", "2026-11-05T00:00:00Z");
        let run = |sid: &str, tool: &str, cmd: &str| decide(&c, &json!({"session_id": sid, "tool_name": tool, "tool_input": {"command": cmd}}));
        for tool in ["Bash", "PowerShell"] {
            let why = denied(&run("ph-sub", tool, "git push origin x")).unwrap_or_else(|| panic!("{tool} push must be denied")).to_string();
            assert!(why.contains("gate: true"), "{why}");
            assert_eq!(run("ph-sub", tool, "git status"), json!({}), "a non-push shell call passes");
            assert_eq!(run("ph-plain", tool, "git push"), json!({}), "a plain chat is untouched");
        }
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
