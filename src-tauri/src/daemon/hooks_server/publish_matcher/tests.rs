use super::*;

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
        // `--shell-type <type>` takes a value, so `standard` is not the command.
        "wsl --shell-type standard git push",
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
        "wsl --shell-type login git status",
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

#[test]
fn a_quoted_wsl_command_line_and_bundled_rebase_flags_are_read() {
    let must = rows(&[
        "wsl 'git push'",
        "wsl \"git push origin master\"",
        "wsl -d Ubuntu -- 'cd x && git push'",
        "wsl.exe 'gh pr merge 3'",
        "git rebase -ix 'git push' main",
        "git rebase -ix \"git push\" main",
        "git rebase -i -x 'git push' main",
        "git rebase -ixgit\\ push main",
        "git rebase --exe 'git push' main",
        "git rebase --exe='git push' main",
        "git rebase --ex 'git push' main",
        "git rebase -vx 'git push' main",
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&[
        "wsl 'git status'",
        "wsl 'echo git push'",
        "wsl git commit -m 'a; git push'",
        "git rebase -ix 'cargo test' main",
        "git rebase -i main",
        "git rebase --no-exec main",
        "git rebase --onto x y",
        // `-s` takes a value, so what follows it is the strategy, never an exec.
        "git rebase -sx main",
        "git rebase --empty=drop main",
    ]);
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
}

#[test]
fn brace_expansion_ifs_and_ansi_c_quoting_do_not_hide_a_publish() {
    let must = rows(&[
        "git {push,status}",
        "git pu{s,}h origin",
        "git {push,} origin",
        "git {push,status}",
        "git ${IFS}push",
        "git${IFS}push",
        "git$IFS push",
        "$'g\\x69t' push",
        "git $'pu\\163h'",
        "git $'\\u0070ush'",
        "$\"git\" push",
        "{ git push; }",
        "f() { git push; }; f",
        "echo {a,b}; git push",
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&[
        "git {status,log}",
        // Brace expansion makes words, not a longer command: these run `git g push`,
        // `git echo push` and `git status push origin`.
        "g{it,} push",
        "{git,echo} push",
        "git {status,push} origin",
        "echo {push,pull}",
        "git commit -m {push,pull}",
        "git log --format={a,b} --grep x",
        "git status ${IFS}",
        "git $IFSx push",
        "git $'status'",
        "echo $'git push'",
        "git status; { echo ok; }",
        "curl -d '{\"a\":1,\"b\":2}' x",
    ]);
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
}

#[test]
fn gh_api_with_a_body_defaults_to_post_and_a_shell_rc_flag_does_not_hide_the_payload() {
    let must = rows(&[
        "gh api repos/o/r/merges -f base=master -f head=x",
        "gh api repos/o/r/pulls/3/merge -F merge_method=squash",
        "gh api repos/o/r/merges --field base=master",
        "gh api repos/o/r/merges --input body.json",
        "gh api repos/o/r/merges -fbase=master",
        "bash --rcfile f -c 'git push'",
        "bash --init-file f -c 'git push'",
        "bash -O extglob -c 'git push'",
        "env A.B=1 git push",
        "env -i A.B=1 'C D=2' git push",
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&[
        "gh api repos/o/r/merges",
        "gh api -X GET repos/o/r/merges -f base=master",
        "gh api repos/o/r/pulls -f state=open",
        "bash --rcfile f -c 'git status'",
        "bash --rcfile f script.sh",
        "env A.B=1 git status",
    ]);
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
}

#[test]
fn more_wrappers_runners_and_publishing_plumbing_are_refused() {
    let must = rows(&[
        "doas git push",
        "doas -u root git push",
        "setsid git push",
        "stdbuf -oL git push",
        "stdbuf -o L git push",
        "ionice -c 3 git push",
        "unbuffer git push",
        "watch -n 5 git push",
        "caffeinate -t 60 git push",
        "exec -a name git push",
        "time -p git push",
        "su -c 'git push' deploy",
        "su deploy -c 'git push'",
        "su --command='git push'",
        "runuser -u deploy -- git push",
        "runuser -c 'git push' deploy",
        "script -qc 'git push' /dev/null",
        "echo push | xargs git",
        "printf 'push\\n' | xargs -n1 git",
        "echo pr merge 3 | xargs gh",
        "git send-pack origin master",
        "git http-push http://h/r master",
        "git svn dcommit",
        "cmd /c start git push",
        "start /b git push",
        "start \"\" git push",
        "start \"title\" /wait git push",
        "call git push",
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&[
        "doas ls",
        "su -c 'git status'",
        "su deploy",
        "script -qc 'echo hi' /dev/null",
        "echo status | xargs git",
        "echo push | xargs echo",
        "git svn rebase",
        "start /b notepad",
        "git fetch send-pack",
    ]);
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
}

#[test]
fn review_findings_script_blocks_watch_heredoc_backslash_brace_blowup_and_wrapped_pipes() {
    let ps_must = rows(&["if ($ok) {git push}", "1 | % {git push}", "try{ git push }catch{}", "& {git push origin master}", "else{git push}"]);
    assert_eq!(mismatches(&ps_must, true, true), Vec::<String>::new(), "powershell script blocks");
    assert_eq!(mismatches(&rows(&["if ($ok) {git status}", "try{ git status }catch{}"]), true, false), Vec::<String>::new());

    let blowup = format!("{}; git push", "echo {a,b}".repeat(1) + &"{a,b}".repeat(40));
    let harmless = format!("{}; git status", "echo {a,b}".repeat(1) + &"{a,b}".repeat(40));
    let long_group = format!("git {{{},push}}", "--no-pager,".repeat(70));
    let split_verb = format!("git {{{}pu}}sh", "a,".repeat(70));
    let value_flag = format!("git {{{}-C,.,push}}", "--no-pager,".repeat(63));
    let must = rows(&[
        "watch -n 5 'git push'",
        "watch \"gh pr merge 5\"",
        "cat <<EOF\n$(date) \\\nmore\nEOF\ngit push",
        "cat <<EOF\nsay \"hi\\\" there $(date)\nEOF\ngit push",
        "cat <<EOF | sudo -u root bash\ngit push\nEOF",
        "cat <<EOF | timeout 5 bash\ngit push\nEOF",
        "cat <<EOF | env X=1 bash\ngit push\nEOF",
        "cat <<EOF | xargs -I{} sh -c '{}'\ngit push\nEOF",
        blowup.as_str(),
        long_group.as_str(),
        split_verb.as_str(),
        value_flag.as_str(),
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&["watch 'git status'", "watch -n 5 git status", "cat <<EOF | sudo -u root tee f\ngit push\nEOF", "echo {a,b}{a,b}{a,b}; git status"]);
    // An expansion of 64 words or more is refused whatever the command: its dropped words are unknown.
    assert!(runs_publish_command(&harmless, false), "a capped brace expansion fails closed");
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
}

#[test]
fn an_unquoted_heredoc_body_runs_its_substitutions_and_a_fake_heredoc_hides_nothing() {
    let must = rows(&[
        // The shell expands an unquoted body, so `$(..)` and backticks run.
        "cat <<EOF\n$(git push)\nEOF",
        "cat <<EOF\nnote: `git push`\nEOF",
        "cat <<-EOF\n\t$(git push)\n\tEOF",
        "cat > f <<EOF\nsay \"hi\" $(git push \"origin\")\nEOF",
        // A `<<` inside quotes opens nothing, so the lines after it are commands.
        "echo \"a <<EOF\"\ngit push\nEOF",
        "echo 'a <<EOF'\ngit push\nEOF",
        "echo $((1 << 3))\ngit push\n3",
        "echo \"multi\nline <<EOF\"\ngit push\nEOF",
        "git commit -m 'it'\"'\"'s <<EOF'\ngit push\nEOF",
        // A `$'..'` string escapes its quote with a backslash, so its `<<EOF` is still inside it.
        "echo $'a\\' <<EOF '\"'\"''\ngit push\nEOF",
    ]);
    assert_eq!(mismatches(&must, false, true), Vec::<String>::new(), "must match");
    let must_not = rows(&[
        "cat <<'EOF'\n$(git push)\nEOF",
        "cat <<\"EOF\"\n$(git push)\nEOF",
        "cat <<\\EOF\n$(git push)\nEOF",
        "cat <<EOF\nplain git push text\nEOF",
        "cat <<EOF\ncost $5 and `date`\nEOF",
        "cat <<EOF\n\\$(git push)\nEOF",
        "git commit -m \"$(cat <<'EOF'\nmsg $(git push)\nEOF\n)\"",
        "cat <<'A' <<B\n$(git push)\nA\nplain\nB",
    ]);
    assert_eq!(mismatches(&must_not, false, false), Vec::<String>::new(), "must not match");
    assert!(runs_publish_command("cat <<A <<'B'\n$(git push)\nA\nplain\nB", false), "the first of two bodies is unquoted");
    assert!(runs_publish_command("$m = @\"\n$(git push)\n\"@", true), "an expandable here-string runs its $(..)");
    assert!(!runs_publish_command("$m = @'\n$(git push)\n'@", true), "a literal here-string does not");
}
