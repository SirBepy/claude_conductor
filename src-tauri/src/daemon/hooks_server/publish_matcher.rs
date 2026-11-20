//! The push matcher behind `subchat_write_guard::push_refusal`. It reads the command text with a small tokenizer,
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
//! - Other runners of a command word: `env -S 'git push'`, `parallel`,
//!   `ssh host git push`, `docker run ... git push`,
//!   PowerShell `Start-Process git -ArgumentList push` and `Invoke-Command`.
//! - A PowerShell here-string piped to `iex` (`@'..'@ | iex`): here-string bodies
//!   are dropped as data.
//! - A command word built from a variable (`g=git; $g push`): variables are not
//!   expanded.
//! - A `<<` that the heredoc scan misreads: it follows quotes, `$(..)` and `$((..))` but
//!   not backtick substitutions, `case` patterns or a delimiter written with mixed quoting
//!   (`E"O"F`); a misread body is kept as commands (a false refusal) or dropped.
//! - `flock f -c '..'`, `chrt`, `taskset` (a runner whose own positional argument comes
//!   first) and `xargs -I{} git {}`: the command word is not found behind them.

mod heredoc;
mod words;
mod programs;
use heredoc::*;
use words::*;
use programs::*;

/// Wrappers that run the next word as a command (`sudo git push`, `time git push`).
const WRAPPERS: [&str; 29] = [
    "sudo", "env", "command", "exec", "time", "nohup", "nice", "timeout", "xargs", "builtin", "then", "do", "else", "elif", "if", "while", "until",
    "!", "doas", "pkexec", "setsid", "stdbuf", "ionice", "unbuffer", "caffeinate", "watch", "call", "start",
    "runuser",
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
        "doas" => &["-u", "-C"],
        "pkexec" => &["--user"],
        "runuser" => &["-u", "-g", "-G", "-l", "--user", "--group", "--supp-group", "--login"],
        "stdbuf" => &["-i", "-o", "-e", "--input", "--output", "--error"],
        "ionice" => &["-c", "-n", "-p", "-P", "-t", "--class", "--classdata"],
        "caffeinate" => &["-t", "-w"],
        "watch" => &["-n", "--interval"],
        "exec" => &["-a"],
        "time" => &["-f", "-o", "--format", "--output"],
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

#[cfg(test)]
mod tests;
