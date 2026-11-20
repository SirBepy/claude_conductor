use super::*;

pub(super) fn segment_publishes(raw: &[Word], depth: u8, ps: bool, fed: &[&[Word]]) -> bool {
    if raw.iter().any(|w| w.text == EXPANSION_CAPPED) {
        return true;
    }
    let (mut words, here) = strip_redirects(raw);
    let mut i = 0;
    let mut via_xargs = false;
    let mut via_watch = false;
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
        // `su -c '<cmd>'` and `script -c '<cmd>'` hand a command line to a shell.
        if matches!(name.as_str(), "su" | "runuser" | "script") && command_flag_publishes(&words[i + 1..], depth) {
            return true;
        }
        if WRAPPERS.contains(&name.as_str()) {
            i += 1;
            via_xargs |= name == "xargs";
            // `watch` runs its argument through `sh -c`: `watch 'git push'` is one command line.
            via_watch |= name == "watch";
            let values = wrapper_value_flags(&name);
            // cmd.exe's `start` and `call` take `/b`-style flags, and `start` a window title.
            let cmd_exe = matches!(name.as_str(), "start" | "call");
            let mut titled = false;
            while let Some(w) = words.get(i) {
                let cmd_flag = cmd_exe && w.text.starts_with('/') && !w.text[1..].contains(['/', '\\']);
                if flag_consumes_next(values, &w.text) {
                    i += 2;
                } else if w.text.starts_with('-') || is_wrapper_assignment(w) || cmd_flag {
                    i += 1;
                } else if name == "start" && w.first_quote.is_some() && !titled {
                    titled = true;
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
        if via_watch && first.first_quote.is_some() && first.text.contains(char::is_whitespace) {
            return runs_publish_command_at(&first.text, depth + 1, false);
        }
        let rest = &words[i + 1..];
        // `echo push | xargs git` runs `git push`: the piped words are git's arguments.
        let with_piped: Vec<Word>;
        let rest = if via_xargs && matches!(name.as_str(), "git" | "gh") {
            with_piped = rest.iter().cloned().chain(piped_words(fed)).collect();
            &with_piped[..]
        } else {
            rest
        };
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
pub(super) fn shell_publishes(name: &str, rest: &[Word], here: &[String], fed: &[&[Word]], depth: u8, ps: bool) -> bool {
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
                if matches!(flag.as_str(), "-o" | "+o" | "--rcfile" | "--init-file") {
                    // `-o pipefail`, `-O extglob`, `--rcfile f`: the next word is the option's value, not a script.
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
pub(super) fn decode_encoded_command(b64: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64.trim().trim_end_matches('=')).ok()?;
    let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
    Some(String::from_utf16_lossy(&units))
}

/// Whether text visibly piped into a shell is a publish command: the arguments of the
/// segments in front of it (`echo 'git push' | bash`). What a file or another command
/// prints is not in the command text, so it never counts.
pub(super) fn fed_publishes(fed: &[&[Word]], depth: u8, ps: bool) -> bool {
    // `printf 'git fetch\ngit push\n'` prints real newlines.
    let publishes = |text: &str| runs_publish_command_at(&text.replace("\\n", "\n"), depth + 1, ps);
    fed.iter().any(|seg| {
        let args = seg.get(1..).unwrap_or(&[]);
        // A bare quoted string is the text itself in PowerShell (`'git push' | iex`).
        let literal = seg.first().filter(|w| w.first_quote.is_some()).is_some_and(|w| publishes(&w.text));
        literal || (0..args.len()).any(|k| publishes(&join_words(&args[k..]))) || args.iter().filter(|w| w.first_quote.is_some()).any(|w| publishes(&w.text))
    })
}

/// The words that the segments in front of an `xargs` print: their arguments, split on
/// whitespace (`echo push`, `printf 'push\n'`).
pub(super) fn piped_words(fed: &[&[Word]]) -> Vec<Word> {
    fed.iter()
        .flat_map(|seg| seg.get(1..).unwrap_or(&[]))
        .flat_map(|w| w.text.replace("\\n", " ").split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .map(|text| Word { text, first_quote: None, op: false })
        .collect()
}

/// `su -c '<cmd>'`, `runuser -c`, `script -qc '<cmd>' file`: the word after the flag
/// that ends in `c` (or `--command`) is a command line for a shell.
pub(super) fn command_flag_publishes(rest: &[Word], depth: u8) -> bool {
    rest.iter().enumerate().any(|(k, w)| {
        let t = w.text.as_str();
        let next = || rest.get(k + 1).map(|n| n.text.as_str());
        let payload = if t == "--command" || (t.len() > 1 && !t.starts_with("--") && t.starts_with('-') && t[1..].chars().all(|c| c.is_ascii_alphabetic()) && t.ends_with('c')) {
            next()
        } else {
            t.strip_prefix("--command=")
        };
        payload.is_some_and(|p| runs_publish_command_at(p, depth + 1, false))
    })
}

/// `find ... -exec git push \;` (also `-execdir`, `-ok`, `-okdir`): the words after
/// the flag are a command.
pub(super) fn find_exec_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
    rest.iter()
        .enumerate()
        .filter(|(_, w)| matches!(w.text.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))
        .any(|(p, _)| segment_publishes(&rest[p + 1..], depth + 1, ps, &[]))
}

/// `gh`'s flags that take their value as the NEXT word before the subcommand.
pub(super) const GH_VALUE_FLAGS: [&str; 3] = ["-R", "--repo", "--hostname"];
/// The same for `gh api`.
pub(super) const GH_API_VALUE_FLAGS: [&str; 16] =
    ["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"];

/// `gh pr merge` (flags with a value allowed before the leaf: `-R owner/repo`,
/// `--hostname h`) and `gh api -X PUT repos/o/r/pulls/N/merge`, a mutating call to a
/// merge endpoint. A GET on that path only asks whether the pull request is merged.
pub(super) fn gh_publishes(rest: &[Word]) -> bool {
    let mut plain: Vec<&str> = vec![];
    let mut method: Option<&str> = None;
    // `gh api` sends a POST when it has parameters or a body and no `--method`.
    let mut has_body = false;
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        let t = w.text.as_str();
        i += 1;
        let api = plain.first() == Some(&"api");
        if GH_VALUE_FLAGS.contains(&t) || (api && GH_API_VALUE_FLAGS.contains(&t)) {
            if api && matches!(t, "-X" | "--method") {
                method = rest.get(i).map(|n| n.text.as_str());
            }
            has_body |= api && matches!(t, "-f" | "-F" | "--field" | "--raw-field" | "--input");
            i += 1;
        } else if api && t.starts_with("--method=") {
            method = t.strip_prefix("--method=");
        } else if api && t.starts_with("-X") && !t.starts_with("--") {
            method = Some(&t[2..]);
        } else if api && (t.starts_with("--field=") || t.starts_with("--raw-field=") || t.starts_with("--input=") || (t.len() > 2 && (t.starts_with("-f") || t.starts_with("-F")))) {
            has_body = true;
        } else if !t.starts_with('-') {
            plain.push(t);
        }
    }
    if plain.starts_with(&["pr", "merge"]) {
        return true;
    }
    let mutating = match method {
        Some(m) => matches!(m.to_ascii_uppercase().as_str(), "PUT" | "POST" | "PATCH" | "DELETE"),
        None => has_body,
    };
    let endpoint = plain.get(1).map(|e| e.split('?').next().unwrap_or(e).trim_end_matches('/'));
    plain.first() == Some(&"api") && mutating && endpoint.is_some_and(|e| e.ends_with("/merge") || e.ends_with("/merges"))
}

pub(super) fn join_words(words: &[Word]) -> String {
    words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

/// The git subcommand (the first word after the global options) and the aliases the
/// same command line defines (`-c alias.p=push`).
pub(super) fn git_scan<'a>(args: &[&'a str]) -> (Option<&'a str>, Vec<(&'a str, &'a str)>) {
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
pub(super) fn git_subcommand_runs_publish(sub: &str, args: &[&str], depth: u8, ps: bool) -> bool {
    match sub {
        "subtree" => args.contains(&"push"),
        // Plumbing that publishes without being called `push`.
        "send-pack" | "http-push" => true,
        "svn" => args.contains(&"dcommit"),
        "submodule" => args.iter().position(|a| *a == "foreach").is_some_and(|p| {
            let payload = args[p + 1..].iter().filter(|a| **a != "--recursive").copied().collect::<Vec<_>>().join(" ");
            runs_publish_command_at(&payload, depth + 1, ps)
        }),
        "rebase" => args
            .iter()
            .enumerate()
            .any(|(k, a)| rebase_exec_command(a, args.get(k + 1).copied()).is_some_and(|c| runs_publish_command_at(c, depth + 1, ps))),
        _ => false,
    }
}

/// The command line `git rebase` runs for one of its words: `-x <cmd>`, `-x<cmd>`,
/// `--exec <cmd>`, `--exec=<cmd>`, an abbreviation of `--exec` (git takes any unambiguous
/// one, so `--exe`) and a short cluster that holds `x` (`-ix <cmd>`; `-xi` is `-x` with the
/// value `i`). `next` is the word after `arg`.
pub(super) fn rebase_exec_command<'a>(arg: &'a str, next: Option<&'a str>) -> Option<&'a str> {
    if let Some(long) = arg.strip_prefix("--") {
        let (name, value) = long.split_once('=').map_or((long, None), |(n, v)| (n, Some(v)));
        // `--no-exec` is another name, and `ex` is only ever `--exec`.
        return if name.len() >= 2 && "exec".starts_with(name) { value.or(next) } else { None };
    }
    let cluster = arg.strip_prefix('-')?;
    for (at, c) in cluster.char_indices() {
        match c {
            'x' => {
                let attached = &cluster[at + 1..];
                return if attached.is_empty() { next } else { Some(attached) };
            }
            // These take a value: the rest of the word, or the next word, is theirs.
            's' | 'X' | 'C' | 'S' => return None,
            _ => {}
        }
    }
    None
}

/// `wsl [options] [--] <command>`: the Windows-side launcher of a Linux command. Its
/// value flags (`-d <distro>`, `--distribution-id <guid>`, `-u <user>`, `--cd <dir>`,
/// `--shell-type <type>`, and the long forms of the first and third) are skipped, the rest is a command.
pub(super) fn wsl_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        match w.text.as_str() {
            "-d" | "--distribution" | "--distribution-id" | "-u" | "--user" | "--cd" | "--shell-type" => i += 2,
            t if t.starts_with('-') => i += 1,
            _ => break,
        }
    }
    let command = rest.get(i..).unwrap_or(&[]);
    // wsl hands its words to the Linux shell as one command line, so a single quoted word
    // with spaces in it is a whole command line (`wsl 'git push'`).
    if let [only] = command {
        if only.first_quote.is_some() && only.text.contains(char::is_whitespace) {
            return runs_publish_command_at(&only.text, depth + 1, false);
        }
    }
    segment_publishes(command, depth + 1, ps, &[])
}

/// Whether the git subcommand is `push`, directly or through an alias defined on the
/// same line (`git -c alias.p=push p`, `-c alias.p='!git push'`).
pub(super) fn git_publishes(rest: &[Word], depth: u8, ps: bool) -> bool {
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
