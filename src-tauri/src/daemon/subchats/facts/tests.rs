use super::git::test_repo::{
    fixture_transcript, git as run, init, landed_edit, transcript, BACKGROUND_REVIEWER_FIXTURE, REFUSED_EDIT_FIXTURE,
};
use super::scan::looks_like_push;
use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn write_transcript(dir: &Path, lines: &[Value]) -> PathBuf {
    let path = dir.join("t.jsonl");
    std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    path
}

fn assistant(blocks: Value) -> Value {
    json!({"type": "assistant", "message": {"content": blocks}})
}

fn user(blocks: Value) -> Value {
    json!({"type": "user", "message": {"content": blocks}})
}

fn edit(id: &str, path: &Path) -> Value {
    assistant(json!([{"type": "tool_use", "id": id, "name": "Edit", "input": {"file_path": path.to_string_lossy()}}]))
}

fn shell(id: &str, cmd: &str) -> Value {
    assistant(json!([{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": cmd}}]))
}

fn result(id: &str, is_error: bool, text: &str) -> Value {
    user(json!([{"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": text}]))
}

fn commit_file(root: &Path, name: &str, body: &str) {
    std::fs::write(root.join(name), body).unwrap();
    run(root, &["add", name]);
    run(root, &["commit", "-q", "-m", name]);
}

fn inputs<'a>(root: &'a Path, tp: Option<&'a Path>, base: Option<&'a str>) -> Inputs<'a> {
    Inputs { cwd: root, transcript: tp, base, since: SINCE_SPAWN, reviewer_tool_use_id: None, review_required: true, gate: None }
}

#[test]
fn commits_and_diffstat_come_from_git_since_the_base() {
    let (dir, root) = init();
    let base = git::head(&root).unwrap();
    commit_file(&root, "a.txt", "one\ntwo\n");
    commit_file(&root, "b.txt", "x\n");
    let tp = transcript(dir.path(), &[("Write", &root.join("a.txt")), ("Write", &root.join("b.txt"))]);
    let f = compute(&inputs(&root, Some(&tp), Some(&base)));
    assert_eq!(f.commits, Some(2));
    assert_eq!(f.files_changed, Some(2));
    assert_eq!(f.insertions, Some(3));
    assert_eq!(f.deletions, Some(0));
    assert_eq!(f.since, SINCE_SPAWN);
    assert_eq!(f.head, git::head(&root));
}

#[test]
fn a_peers_commit_does_not_count_when_the_sub_edited_known_files() {
    let (dir, root) = init();
    let base = git::head(&root).unwrap();
    commit_file(&root, "mine.txt", "m\n");
    commit_file(&root, "peers.txt", "p\n");
    let tp = transcript(dir.path(), &[("Write", &root.join("mine.txt"))]);
    let f = compute(&inputs(&root, Some(&tp), Some(&base)));
    assert!(f.scoped);
    assert_eq!(f.commits, Some(1), "only the commit touching the sub's own file");
    assert_eq!(f.files_changed, Some(1));
}

#[test]
fn uncommitted_counts_only_the_subs_own_files_never_a_peers() {
    let (dir, root) = init();
    std::fs::write(root.join("mine.txt"), "m").unwrap();
    std::fs::write(root.join("peers.txt"), "p").unwrap();
    std::fs::write(root.join("base.txt"), "peer edit\n").unwrap();
    let tp = transcript(dir.path(), &[("Write", &root.join("mine.txt"))]);
    let f = compute(&inputs(&root, Some(&tp), None));
    assert_eq!(f.uncommitted, Some(1));
    assert_eq!(f.uncommitted_files, ["mine.txt"]);
}

#[test]
fn nothing_is_claimed_outside_a_repo_or_without_a_base() {
    let dir = tempfile::tempdir().unwrap();
    let f = compute(&inputs(dir.path(), None, None));
    assert_eq!(f.commits, None);
    assert_eq!(f.files_changed, None);
    assert_eq!(f.uncommitted, None, "unknown, not zero");
    assert_eq!(f.test.state, "unknown");
    assert_eq!(f.reviewer.state, "unknown", "no transcript to read");
    assert_eq!(f.pushed, None);
}

#[test]
fn a_pushed_commit_and_an_unpushed_one_are_told_apart() {
    let (dir, root) = init();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare"]);
    run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    let base = git::head(&root).unwrap();
    commit_file(&root, "a.txt", "a\n");
    let tp = transcript(dir.path(), &[("Write", &root.join("a.txt"))]);
    assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(false));
    run(&root, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(true));
}

/// A repo whose branch tracks a bare remote it has pushed once.
fn tracked_repo() -> (tempfile::TempDir, PathBuf, tempfile::TempDir) {
    let (dir, root) = init();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare"]);
    run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    run(&root, &["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);
    (dir, root, remote)
}

fn gate_inputs<'a>(root: &'a Path, before: Option<&'a str>) -> Inputs<'a> {
    Inputs { gate: Some(GateBase { upstream_before: before }), ..inputs(root, None, None) }
}

#[test]
fn a_gate_that_pushed_says_pushed_even_though_it_made_no_commit_of_its_own() {
    let (_dir, root, _remote) = tracked_repo();
    commit_file(&root, "a.txt", "work the main chat left unpushed\n");
    let before = git::upstream(&root).unwrap();
    let f = compute(&gate_inputs(&root, Some(&before)));
    assert_eq!(f.pushed, Some(false), "the upstream has not moved: it did not push");
    run(&root, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    let f = compute(&gate_inputs(&root, Some(&before)));
    assert_eq!(f.pushed, Some(true), "the upstream moved and holds HEAD");
    assert_eq!(f.commits, None, "no spawn base was given, and the count is not what makes the chip");
}

#[test]
fn a_gate_pushed_chip_is_unknown_when_neither_the_upstream_nor_the_remote_can_say() {
    let (_d2, bare_root) = init();
    let any = git::head(&bare_root).unwrap();
    assert_eq!(compute(&gate_inputs(&bare_root, None)).pushed, None, "no upstream and no remote");
    assert_eq!(compute(&gate_inputs(&bare_root, Some(&any))).pushed, None, "no upstream now and no remote: a guess would mislead");
}

/// The first real run: the gate pushed `HEAD:refs/heads/<branch>` without `-u`, so
/// no tracking ref ever existed and the chip read "unknown".
#[test]
fn a_gate_that_pushed_without_an_upstream_is_found_by_asking_the_remote() {
    let (_dir, root) = init();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare"]);
    run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    let branch = git::run_git(&root, &["symbolic-ref", "--short", "HEAD"]).map(|(_, o)| String::from_utf8_lossy(&o).trim().to_string()).unwrap();
    assert_eq!(git::upstream(&root), None, "the premise: nothing tracks the remote");
    let tp = write_transcript(_dir.path(), &[shell("p1", "git push origin HEAD:main"), result("p1", false, "done")]);
    let with_push = || Inputs { transcript: Some(&tp), ..gate_inputs(&root, None) };
    assert_eq!(compute(&with_push()).pushed, None, "nothing pushed yet: the remote has no such branch");
    run(&root, &["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")]);
    assert_eq!(git::upstream(&root), None, "pushing without -u sets no upstream");
    assert_eq!(compute(&with_push()).pushed, Some(true));
    commit_file(&root, "later.txt", "unpushed\n");
    assert_eq!(compute(&with_push()).pushed, None, "the remote holds an older tip: not a claim of either");
}

/// The remote held `HEAD` before the gate started and the gate pushed nothing:
/// the tip matching `HEAD` is not the gate's doing.
#[test]
fn a_remote_that_already_held_head_is_not_a_push_by_a_gate_that_ran_none() {
    let (_dir, root) = init();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare"]);
    run(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    let branch = git::run_git(&root, &["symbolic-ref", "--short", "HEAD"]).map(|(_, o)| String::from_utf8_lossy(&o).trim().to_string()).unwrap();
    run(&root, &["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")]);
    assert_eq!(compute(&gate_inputs(&root, None)).pushed, None, "no transcript, no push of the gate's own");
    let quiet = write_transcript(_dir.path(), &[shell("t0", "git status"), result("t0", false, "clean")]);
    assert_eq!(compute(&Inputs { transcript: Some(&quiet), ..gate_inputs(&root, None) }).pushed, None);
    let dry = write_transcript(_dir.path(), &[shell("d0", "git push --dry-run origin HEAD"), result("d0", false, "")]);
    assert_eq!(compute(&Inputs { transcript: Some(&dry), ..gate_inputs(&root, None) }).pushed, None, "a dry run pushes nothing");
    let failed = write_transcript(_dir.path(), &[shell("f0", "git push origin HEAD"), result("f0", true, "rejected")]);
    assert_eq!(compute(&Inputs { transcript: Some(&failed), ..gate_inputs(&root, None) }).pushed, None, "a failed push is not one");
}

#[test]
fn a_push_command_is_told_from_one_that_only_mentions_push() {
    assert!(looks_like_push("git push origin HEAD:main"));
    assert!(looks_like_push("cd app && git -C ../x push -u origin main"));
    assert!(looks_like_push("GIT_TERMINAL_PROMPT=0 git push"));
    assert!(!looks_like_push("git commit -m \"push the thing\""));
    assert!(!looks_like_push("git push -n origin main"));
    assert!(!looks_like_push("git pull && echo push"));
}

#[test]
fn an_unreachable_remote_leaves_a_gates_pushed_chip_unknown() {
    let (_dir, root) = init();
    let gone = tempfile::tempdir().unwrap();
    let path = gone.path().join("not-a-repo");
    run(&root, &["remote", "add", "origin", &path.to_string_lossy()]);
    assert_eq!(compute(&gate_inputs(&root, None)).pushed, None);
}

#[test]
fn a_gate_that_moved_the_upstream_without_holding_head_did_not_push_this_head() {
    let (_dir, root, remote) = tracked_repo();
    let before = git::upstream(&root).unwrap();
    // Someone else pushed a commit this clone never had, then this clone fetched it
    // and went on to commit locally on a diverged line.
    let other = tempfile::tempdir().unwrap();
    run(other.path(), &["clone", "-q", "-b", "main", &remote.path().to_string_lossy(), "."]);
    run(other.path(), &["config", "user.email", "t@example.com"]);
    run(other.path(), &["config", "user.name", "t"]);
    run(other.path(), &["config", "commit.gpgsign", "false"]);
    commit_file(other.path(), "theirs.txt", "t\n");
    run(other.path(), &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    commit_file(&root, "mine.txt", "m\n");
    run(&root, &["fetch", "-q"]);
    assert_eq!(compute(&gate_inputs(&root, Some(&before))).pushed, Some(false));
}

#[test]
fn a_plain_sub_keeps_the_commit_based_reading_and_never_gets_the_gate_one() {
    let (dir, root, _remote) = tracked_repo();
    let base = git::head(&root).unwrap();
    // No commits of its own: nothing to say about pushing.
    assert_eq!(compute(&inputs(&root, None, Some(&base))).pushed, None);
    commit_file(&root, "a.txt", "a\n");
    let tp = transcript(dir.path(), &[("Write", &root.join("a.txt"))]);
    assert_eq!(compute(&inputs(&root, Some(&tp), Some(&base))).pushed, Some(false), "a plain sub that committed says not pushed");
}

#[test]
fn the_last_test_run_reports_its_exit_status_and_is_unknown_when_there_was_none() {
    let (dir, root) = init();
    let none = write_transcript(dir.path(), &[shell("t0", "ls"), result("t0", false, "a b")]);
    assert_eq!(compute(&inputs(&root, Some(&none), None)).test.state, "unknown");

    let tp = write_transcript(
        dir.path(),
        &[
            shell("t1", "cargo test --lib"),
            result("t1", true, "error\ntest result: FAILED. 3 passed; 1 failed"),
            shell("t2", "cd src-tauri && cargo test --lib x"),
            result("t2", false, "running 4 tests\ntest result: ok. 4 passed; 0 failed"),
        ],
    );
    let t = compute(&inputs(&root, Some(&tp), None)).test;
    assert_eq!(t.state, "passed");
    assert!(t.summary.as_deref().unwrap().contains("4 passed"), "{t:?}");
    assert!(!t.stale);
}

#[test]
fn a_failed_run_and_a_run_that_never_returned_are_not_passes() {
    let (dir, root) = init();
    let failed = write_transcript(dir.path(), &[shell("t1", "pnpm vitest run"), result("t1", true, "1 failed")]);
    assert_eq!(compute(&inputs(&root, Some(&failed), None)).test.state, "failed");
    let pending = write_transcript(dir.path(), &[shell("t1", "pnpm vitest run")]);
    assert_eq!(compute(&inputs(&root, Some(&pending), None)).test.state, "unknown");
}

#[test]
fn a_test_run_before_the_last_edit_is_marked_stale() {
    let (dir, root) = init();
    let tp = write_transcript(
        dir.path(),
        &[shell("t1", "cargo test"), result("t1", false, "ok"), edit("e1", &root.join("base.txt"))],
    );
    let t = compute(&inputs(&root, Some(&tp), None)).test;
    assert_eq!(t.state, "passed");
    assert!(t.stale, "the code changed after this run");
}

#[test]
fn a_command_that_merely_mentions_a_runner_is_not_a_test_run() {
    assert!(!looks_like_test("git commit -m \"fix vitest flake\""));
    assert!(!looks_like_test("echo cargo test"));
    assert!(looks_like_test("cd src-tauri && cargo test --lib"));
    assert!(looks_like_test("$env:CARGO_TARGET_DIR='x'; cargo test --lib"));
    assert!(looks_like_test("CI=1 pnpm vitest run"));
    assert!(looks_like_test("pnpm exec playwright test foo"));
}

#[test]
fn a_reviewer_result_after_the_last_edit_is_read_from_the_transcript() {
    let (dir, root) = init();
    let tp = write_transcript(
        dir.path(),
        &[
            edit("e1", &root.join("base.txt")),
            assistant(json!([{"type": "tool_use", "id": "rev1", "name": "Task", "input": {}}])),
            result("rev1", false, "Found 1 problem:\n  the loop never exits. Fixed."),
        ],
    );
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("rev1");
    let r = compute(&i).reviewer;
    assert_eq!(r.state, "ran");
    assert!(r.text.unwrap().starts_with("Found 1 problem: the loop never exits"));
}

#[test]
fn a_reviewer_that_ran_before_the_last_edit_counts_as_no_reviewer() {
    let (dir, root) = init();
    let tp = write_transcript(
        dir.path(),
        &[
            assistant(json!([{"type": "tool_use", "id": "rev1", "name": "Task", "input": {}}])),
            result("rev1", false, "all fine"),
            edit("e1", &root.join("base.txt")),
        ],
    );
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("rev1");
    let r = compute(&i).reviewer;
    assert_eq!(r.state, "none");
    assert!(r.note.unwrap().contains("before a material edit"));
}

#[test]
fn a_claimed_reviewer_id_that_is_not_in_the_transcript_is_no_reviewer() {
    let (dir, root) = init();
    let tp = write_transcript(dir.path(), &[edit("e1", &root.join("base.txt"))]);
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("ghost");
    assert_eq!(compute(&i).reviewer.state, "none");
    i.reviewer_tool_use_id = None;
    assert_eq!(compute(&i).reviewer.state, "none");
}

#[test]
fn the_chip_and_the_finish_rule_agree_on_what_counts_as_a_review() {
    let (dir, root) = init();
    let edit_then = |rest: Vec<Value>| {
        let mut lines = vec![edit("e1", &root.join("base.txt"))];
        lines.extend(rest);
        write_transcript(dir.path(), &lines)
    };
    let subagent = |id: &str, tool: &str| assistant(json!([{"type": "tool_use", "id": id, "name": tool, "input": {}}]));
    // A Read call named as the reviewer is neither a chip's "ran" nor a gate pass.
    let tp = edit_then(vec![subagent("r", "Read"), result("r", false, "text")]);
    assert_eq!(review_gap(&tp, Some("r")), Some(ReviewGap::NotASubagent("Read".into())));
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("r");
    assert_eq!(compute(&i).reviewer.state, "none");
    // A subagent after the edit with a result passes both.
    let tp = edit_then(vec![subagent("r", "Agent"), result("r", false, "ok")]);
    assert_eq!(review_gap(&tp, Some("r")), None);
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("r");
    assert_eq!(compute(&i).reviewer.state, "ran");
    assert_eq!(review_gap(&tp, None), None, "no id passed: the daemon finds the Agent call after the edit itself");
    let no_agent = edit_then(vec![subagent("r", "Read"), result("r", false, "text")]);
    assert_eq!(review_gap(&no_agent, None), Some(ReviewGap::NotNamed), "a Read is not a reviewer");
    // No edit at all: nothing is owed, named or not.
    let no_edit = write_transcript(dir.path(), &[shell("b", "ls")]);
    assert_eq!(review_gap(&no_edit, None), None);
    // An edit in the same message as the review cannot have been reviewed.
    let same = write_transcript(
        dir.path(),
        &[
            assistant(json!([
                {"type": "tool_use", "id": "e", "name": "Edit", "input": {"file_path": root.join("base.txt").to_string_lossy()}},
                {"type": "tool_use", "id": "r", "name": "Agent", "input": {}}
            ])),
            result("r", false, "ok"),
        ],
    );
    assert_eq!(review_gap(&same, Some("r")), Some(ReviewGap::BeforeLastEdit));
}

/// An Edit whose text is in the transcript, so the review-diet rule can size it.
fn sized_edit(id: &str, path: &Path, old: &str, new: &str) -> Value {
    assistant(json!([{"type": "tool_use", "id": id, "name": "Edit", "input": {"file_path": path.to_string_lossy(), "old_string": old, "new_string": new}}]))
}

fn lines_of(n: usize) -> String {
    (0..n).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n")
}

/// A transcript of: one real edit of `base.txt`, one reviewer that returned, then `after`.
fn reviewed_then(dir: &Path, root: &Path, after: Vec<Value>) -> PathBuf {
    let mut lines = vec![
        sized_edit("e1", &root.join("base.txt"), "a", &lines_of(30)),
        assistant(json!([{"type": "tool_use", "id": "rev", "name": "Agent", "input": {}}])),
        result("rev", false, "No problems."),
    ];
    lines.extend(after);
    write_transcript(dir, &lines)
}

/// The review diet: a small fix after the review does not buy a second one.
/// Without it any edit after the reviewer started was `BeforeLastEdit`.
#[test]
fn a_small_fix_to_a_reviewed_file_after_the_review_leaves_the_review_standing() {
    let (dir, root) = init();
    let base = root.join("base.txt");
    let tp = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &base, "line 1", "line one")]);
    assert_eq!(review_gap(&tp, None), None, "one changed line is no reason for a second reviewer");
    assert_eq!(review_gap(&tp, Some("rev")), None, "an id that is passed is judged by the same rule");
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("rev");
    assert_eq!(compute(&i).reviewer.state, "ran", "the chip and the finish rule agree");
    assert_eq!(reviewer_fact_from_transcript(&tp, None).state, "ran");
}

#[test]
fn an_edit_that_is_more_than_a_small_fix_still_needs_a_new_review() {
    let (dir, root) = init();
    let base = root.join("base.txt");
    let more = TRIVIAL_EDIT_LINES + 1;
    // Over the line total in one edit.
    let big = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &base, "", &lines_of(more))]);
    assert_eq!(review_gap(&big, None), Some(ReviewGap::BeforeLastEdit));
    // Each edit is small, the total is not.
    let many: Vec<Value> = (0..more).map(|n| sized_edit(&format!("s{n}"), &base, "", &format!("x{n}"))).collect();
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, many), None), Some(ReviewGap::BeforeLastEdit));
    // A file the reviewer had not seen is new code.
    let fresh = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &root.join("other.txt"), "a", "b")]);
    assert_eq!(review_gap(&fresh, None), Some(ReviewGap::BeforeLastEdit));
    // An edit whose size the transcript does not show is not assumed small.
    let unsized_edit = reviewed_then(dir.path(), &root, vec![edit("e2", &base)]);
    assert_eq!(review_gap(&unsized_edit, None), Some(ReviewGap::BeforeLastEdit));
    // A notebook is never sized.
    let nb = assistant(json!([{"type": "tool_use", "id": "n", "name": "NotebookEdit", "input": {"notebook_path": base.to_string_lossy()}}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![nb]), None), Some(ReviewGap::BeforeLastEdit));
    // Exactly the limit still stands.
    let at_limit = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &base, "", &lines_of(TRIVIAL_EDIT_LINES))]);
    assert_eq!(review_gap(&at_limit, None), None);
}

#[test]
fn a_documentation_edit_never_needs_a_new_review_whatever_its_size() {
    let (dir, root) = init();
    let doc = root.join("docs").join("architecture").join("notes.md");
    let tp = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &doc, "", &lines_of(200))]);
    assert_eq!(review_gap(&tp, None), None, "a new 200-line doc is not code");
    let readme = reviewed_then(dir.path(), &root, vec![sized_edit("e2", &root.join("README.MD"), "", &lines_of(60))]);
    assert_eq!(review_gap(&readme, None), None, "the extension is read case-insensitively");
    // A doc edit does not use up the allowance of the code edits beside it.
    let both = reviewed_then(
        dir.path(),
        &root,
        vec![sized_edit("e2", &doc, "", &lines_of(200)), sized_edit("e3", &root.join("base.txt"), "a", "b")],
    );
    assert_eq!(review_gap(&both, None), None);
}

/// Holes a reviewer found in the first cut: sizes the transcript cannot bound are
/// material, and `docs/` does not make code a document.
#[test]
fn edits_whose_size_cannot_be_bounded_or_that_are_code_in_a_docs_folder_stay_material() {
    let (dir, root) = init();
    let base = root.join("base.txt");
    // A Write over a reviewed file: its old size is not in the transcript.
    let write = assistant(json!([{"type": "tool_use", "id": "w", "name": "Write", "input": {"file_path": base.to_string_lossy(), "content": "x"}}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![write]), None), Some(ReviewGap::BeforeLastEdit));
    // `replace_all` rewrites every site.
    let all = assistant(json!([{"type": "tool_use", "id": "ra", "name": "Edit", "input": {"file_path": base.to_string_lossy(), "old_string": "==", "new_string": "!=", "replace_all": true}}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![all]), None), Some(ReviewGap::BeforeLastEdit));
    // A script under docs/ is code (and a new file besides, so check one the reviewer saw too).
    let script = root.join("docs").join("design").join("mock.ts");
    let seen = write_transcript(
        dir.path(),
        &[
            sized_edit("e1", &script, "a", &lines_of(60)),
            assistant(json!([{"type": "tool_use", "id": "rev", "name": "Agent", "input": {}}])),
            result("rev", false, "No problems."),
            sized_edit("e2", &script, "", &lines_of(TRIVIAL_EDIT_LINES + 1)),
        ],
    );
    assert_eq!(review_gap(&seen, None), Some(ReviewGap::BeforeLastEdit), "a .ts under docs/ is code, so the total applies");
    // MultiEdit is sized from its parts; one with no parts is not.
    let multi = |edits: Value| assistant(json!([{"type": "tool_use", "id": "m", "name": "MultiEdit", "input": {"file_path": base.to_string_lossy(), "edits": edits}}]));
    let small = multi(json!([{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "d"}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![small]), None), None);
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![multi(json!([]))]), None), Some(ReviewGap::BeforeLastEdit));
    let every_site = multi(json!([{"old_string": "foo", "new_string": "bar", "replace_all": true}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![every_site]), None), Some(ReviewGap::BeforeLastEdit));
    let part_without_text = multi(json!([{}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![part_without_text]), None), Some(ReviewGap::BeforeLastEdit));
    let large = multi(json!([{"old_string": "", "new_string": lines_of(TRIVIAL_EDIT_LINES + 1)}]));
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, vec![large]), None), Some(ReviewGap::BeforeLastEdit));
    // An edit that was refused changed nothing, so it neither forces a review nor counts.
    let refused_new = vec![sized_edit("e2", &root.join("other.txt"), "a", "b"), result("e2", true, "String to replace not found")];
    assert_eq!(review_gap(&reviewed_then(dir.path(), &root, refused_new), None), None);
}

/// A small edit in the same assistant message as the reviewer call cannot have been seen by it.
#[test]
fn a_small_edit_in_the_reviewers_own_message_is_material() {
    let (dir, root) = init();
    let base = root.join("base.txt");
    let tp = write_transcript(
        dir.path(),
        &[
            sized_edit("e1", &base, "a", &lines_of(30)),
            assistant(json!([
                {"type": "tool_use", "id": "e2", "name": "Edit", "input": {"file_path": base.to_string_lossy(), "old_string": "line 1", "new_string": "line one"}},
                {"type": "tool_use", "id": "rev", "name": "Agent", "input": {}}
            ])),
            result("rev", false, "ok"),
        ],
    );
    assert_eq!(review_gap(&tp, Some("rev")), Some(ReviewGap::BeforeLastEdit));
}

/// The reviewer the daemon picks is the last one whose review still stands, so a
/// second review after a trivial edit is neither required nor mistaken for the first.
#[test]
fn the_reviewer_found_without_an_id_is_the_last_one_that_still_stands() {
    let (dir, root) = init();
    let base = root.join("base.txt");
    let agent = |id: &str| assistant(json!([{"type": "tool_use", "id": id, "name": "Agent", "input": {}}]));
    // review 1, a material edit, review 2, a trivial edit: review 2 stands.
    let tp = write_transcript(
        dir.path(),
        &[
            sized_edit("e1", &base, "a", &lines_of(30)),
            agent("r1"),
            result("r1", false, "first"),
            sized_edit("e2", &base, "", &lines_of(40)),
            agent("r2"),
            result("r2", false, "Found 1 problem: second"),
            sized_edit("e3", &base, "line 1", "line one"),
        ],
    );
    assert_eq!(review_gap(&tp, None), None);
    assert!(reviewer_fact_from_transcript(&tp, None).text.unwrap().starts_with("Found 1 problem: second"));
    // The first review does not stand: the 40-line edit after it was material.
    assert_eq!(review_gap(&tp, Some("r1")), Some(ReviewGap::BeforeLastEdit));
}

#[test]
fn a_job_that_opted_out_of_a_reviewer_says_so() {
    let (dir, root) = init();
    let tp = write_transcript(dir.path(), &[edit("e1", &root.join("base.txt"))]);
    let mut i = inputs(&root, Some(&tp), None);
    i.review_required = false;
    let r = compute(&i).reviewer;
    assert_eq!((r.state.as_str(), r.note.as_deref()), ("none", Some("not required for this job")));
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": input}]))
}

fn reviewer_with(tool: &str, command_or_empty: &str) -> ReviewerFact {
    let (dir, root) = init();
    let input = if command_or_empty.is_empty() { json!({}) } else { json!({"command": command_or_empty}) };
    let tp = write_transcript(
        dir.path(),
        &[edit("e1", &root.join("base.txt")), tool_use("rev1", tool, input), result("rev1", false, "all fine, nothing found")],
    );
    let mut i = inputs(&root, Some(&tp), None);
    i.reviewer_tool_use_id = Some("rev1");
    compute(&i).reviewer
}

#[test]
fn a_shell_call_named_as_the_reviewer_is_not_a_reviewer() {
    // `echo ok` has an id, comes after the last edit and returns text, which was
    // all the old check asked. A reviewer is a fresh subagent.
    for tool in ["Bash", "PowerShell", "Read", "Edit"] {
        let r = reviewer_with(tool, "echo ok");
        assert_eq!(r.state, "none", "{tool} is not a subagent: {r:?}");
        assert!(r.note.unwrap().contains("not a subagent"), "the chip says why");
    }
    assert_eq!(reviewer_with("Agent", "").state, "ran", "the Agent tool is a subagent");
    assert_eq!(reviewer_with("Task", "").state, "ran", "an older CLI calls it Task");
}

#[test]
fn the_shared_reviewer_check_reads_the_transcript_the_same_way() {
    let (dir, root) = init();
    let tp = write_transcript(
        dir.path(),
        &[
            edit("e1", &root.join("base.txt")),
            tool_use("sh", "Bash", json!({"command": "echo ok"})),
            result("sh", false, "ok"),
            tool_use("ag", "Agent", json!({"prompt": "review"})),
            result("ag", false, "No problems."),
        ],
    );
    assert_eq!(reviewer_fact_from_transcript(&tp, Some("sh")).state, "none");
    assert_eq!(reviewer_fact_from_transcript(&tp, Some("ag")).state, "ran");
    assert_eq!(reviewer_fact_from_transcript(&tp, None).state, "ran", "the Agent call after the edit is found without an id");
    assert_eq!(reviewer_fact_from_transcript(&dir.path().join("missing.jsonl"), Some("ag")).state, "unknown");
}

/// First real run: a read-only sub's only Edit was refused by the write guard,
/// and the finish gate still said "you changed files". A refused edit is not one.
#[test]
fn a_refused_edit_is_not_the_last_edit_so_no_review_is_owed() {
    let (dir, root) = init();
    // The file exists and is untracked, as it would be had the Edit landed.
    std::fs::write(root.join("index.html"), "x").unwrap();
    // The fixture's first two lines: the Edit and the guard's refusal.
    let tp = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &root.join("index.html"), 2, &[], false);
    assert_eq!(review_gap(&tp, None), None, "nothing was changed, so nothing is owed");
    let f = compute(&inputs(&root, Some(&tp), None));
    assert_eq!(f.uncommitted, Some(0), "the refused file is not the sub's uncommitted work");
    assert_eq!(f.reviewer.note.as_deref(), Some("no reviewer ran"));
    // The same Edit with a landed result is an edit, and then a review is owed.
    let landed = write_transcript(dir.path(), &landed_edit("e1", &root.join("index.html")));
    assert_eq!(review_gap(&landed, None), Some(ReviewGap::NotNamed));
}

/// An edit that failed for any reason (a stale `old_string`) changed nothing either.
#[test]
fn an_edit_that_errored_does_not_move_the_last_edit_line() {
    let (dir, root) = init();
    let tp = write_transcript(
        dir.path(),
        &[
            assistant(json!([{"type": "tool_use", "id": "rev", "name": "Agent", "input": {}}])),
            result("rev", false, "No problems."),
            edit("e1", &root.join("base.txt")),
            result("e1", true, "String to replace not found in file"),
        ],
    );
    // The review came before the only edit attempt, which did not land.
    assert_eq!(review_gap(&tp, None), None);
}

/// The model cannot see its own tool_use ids, so the daemon takes the last
/// subagent call after the last edit, and a later call a dispatch hook refused
/// does not hide an earlier good one.
#[test]
fn the_reviewer_is_the_last_subagent_call_after_the_last_edit_without_any_id() {
    let (dir, root) = init();
    let agent = |id: &str| assistant(json!([{"type": "tool_use", "id": id, "name": "Agent", "input": {}}]));
    let tp = write_transcript(
        dir.path(),
        &[
            agent("before"),
            result("before", false, "old review of old code"),
            edit("e1", &root.join("base.txt")),
            agent("good"),
            result("good", false, "Found 1 problem: the loop never exits."),
            agent("refused"),
            result("refused", true, "PreToolUse:Agent hook error: dispatch-preamble-guard"),
        ],
    );
    assert_eq!(review_gap(&tp, None), None);
    let r = reviewer_fact_from_transcript(&tp, None);
    assert_eq!(r.state, "ran");
    assert!(r.text.unwrap().starts_with("Found 1 problem"), "the good call after the edit, not the refused one");
    // An id that is passed is still checked.
    assert_eq!(review_gap(&tp, Some("ghost")), Some(ReviewGap::NotInTranscript));
    assert_eq!(review_gap(&tp, Some("before")), Some(ReviewGap::BeforeLastEdit));
    // Only a refused call after the edit: not a review.
    let only_refused = write_transcript(
        dir.path(),
        &[edit("e1", &root.join("base.txt")), agent("refused"), result("refused", true, "PreToolUse:Agent hook error: x")],
    );
    assert_eq!(review_gap(&only_refused, None), Some(ReviewGap::NoResult));
    // Subagents ran, but all before the last edit.
    let early = write_transcript(dir.path(), &[agent("a"), result("a", false, "ok"), edit("e1", &root.join("base.txt"))]);
    assert_eq!(review_gap(&early, None), Some(ReviewGap::BeforeLastEdit));
}

/// First real run: a foreground subagent's tool_result is "This agent's report was
/// delivered to you as a message from ...", and the chip showed that as the
/// reviewer's words. The words are the hand-back entry; the stub is never shown.
#[test]
fn a_reviewer_chip_shows_the_handed_back_report_never_the_delivery_stub() {
    let (dir, root) = init();
    let file = root.join("index.html");
    let tp = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &file, 8, &landed_edit("e0", &file), false);
    let r = reviewer_fact_from_transcript(&tp, None);
    assert_eq!(r.state, "ran");
    let text = r.text.expect("the hand-back words");
    assert!(text.contains("git status --short") && text.contains("printed nothing"), "{text}");
    assert!(!text.contains("delivered to you") && !text.contains("Read it there"), "the stub is noise: {text}");
    // The report entry is missing from the transcript: still a run (the stub says it
    // was delivered), with no words rather than the stub's.
    let stub_only = fixture_transcript(dir.path(), REFUSED_EDIT_FIXTURE, &file, 8, &landed_edit("e0", &file), true);
    let r = reviewer_fact_from_transcript(&stub_only, None);
    assert_eq!((r.state.as_str(), r.text), ("ran", None));
    assert_eq!(review_gap(&stub_only, None), None);
}

/// A background reviewer's report arrives after its launch note. Until then it has
/// not run: counting it would let a sub finish on a review nobody has read.
#[test]
fn a_background_reviewer_counts_only_once_its_report_came_back() {
    let (dir, root) = init();
    let file = root.join("index.html");
    let done = fixture_transcript(dir.path(), BACKGROUND_REVIEWER_FIXTURE, &file, 4, &landed_edit("e0", &file), false);
    let r = reviewer_fact_from_transcript(&done, None);
    assert_eq!(r.state, "ran");
    let text = r.text.unwrap();
    assert!(text.starts_with("None found. Commit 1e739f2"), "{text}");
    assert!(!text.contains("Async agent launched"), "{text}");
    assert_eq!(review_gap(&done, None), None);
    // Only the launch: no hand-back yet.
    let pending = fixture_transcript(dir.path(), BACKGROUND_REVIEWER_FIXTURE, &file, 2, &landed_edit("e0", &file), false);
    let r = reviewer_fact_from_transcript(&pending, None);
    assert_eq!(r.state, "none", "a launch is not a review");
    assert!(r.text.is_none() && r.note.as_deref().unwrap().contains("has not returned"), "{r:?}");
    assert_eq!(review_gap(&pending, None), Some(ReviewGap::NoResult));
    // The same through the explicit id.
    assert_eq!(review_gap(&pending, Some("toolu_012WiDJwoK5rsMK59Ka8xWLR")), Some(ReviewGap::NoResult));
}

fn test_state_of(cmd: &str, is_error: bool, output: &str) -> TestFact {
    let (dir, root) = init();
    let tp = write_transcript(dir.path(), &[shell("t1", cmd), result("t1", is_error, output)]);
    compute(&inputs(&root, Some(&tp), None)).test
}

#[test]
fn a_failing_suite_run_through_a_pipe_is_failed_not_passed() {
    let t = test_state_of(
        "cargo test --lib 2>&1 | tail -5",
        false,
        "running 12 tests\ntest result: FAILED. 11 passed; 1 failed; 0 ignored",
    );
    assert_eq!(t.state, "failed", "the exit status was tail's, the summary line is the truth: {t:?}");
    assert!(t.summary.unwrap().contains("FAILED"));
    for output in [
        "Test Files  1 failed | 4 passed (5)\n      Tests  2 failed | 30 passed (32)",
        " FAIL  tests/a.test.mjs > it works\nAssertionError",
        "failures:\n    a::b\n",
        "error: could not compile `app` due to 2 previous errors",
        "thread 'x' panicked at src/lib.rs:1:1",
        "Process finished with exit code 1",
    ] {
        assert_eq!(test_state_of("pnpm vitest run | tail -20", false, output).state, "failed", "{output}");
    }
}

#[test]
fn passed_needs_a_pass_marker_or_a_clean_unpiped_exit() {
    let ok = "running 4 tests\ntest result: ok. 4 passed; 0 failed; 0 ignored";
    assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, ok).state, "passed", "a pass marker, even through a pipe");
    assert_eq!(test_state_of("pnpm vitest run | tail", false, "Tests  31 passed (31)").state, "passed");
    assert_eq!(test_state_of("cargo test --lib", false, "").state, "passed", "unpiped, exit 0");
    assert_eq!(test_state_of("cd app && cargo test", false, "").state, "passed", "&& keeps the test's own status");
    // The exit status was some other command's, or no output says anything.
    assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, "").state, "unknown");
    assert_eq!(test_state_of("cargo test --lib 2>&1 | tail -5", false, "Finished dev profile").state, "unknown");
    assert_eq!(test_state_of("cargo test --lib; echo done", false, "done").state, "unknown", "echo's status, not the suite's");
    assert_eq!(test_state_of("cargo test --lib || true", false, "").state, "unknown");
    // A zero failure count is not a failure.
    assert_eq!(test_state_of("cargo test", false, "test result: ok. 12 passed; 0 failed").state, "passed");
    assert_eq!(test_state_of("cargo test", true, "test result: ok. 12 passed").state, "failed", "the tool's own error flag still wins");
}

#[test]
fn a_sub_that_edited_nothing_is_not_credited_with_a_peers_commit() {
    let (dir, root) = init();
    let base = git::head(&root).unwrap();
    commit_file(&root, "peers.txt", "p\n");
    // Only reads and a shell call: no Edit or Write to scope the range by.
    let tp = write_transcript(dir.path(), &[shell("s1", "ls"), result("s1", false, "a b")]);
    let f = compute(&inputs(&root, Some(&tp), Some(&base)));
    assert_eq!((f.commits, f.files_changed, f.insertions, f.deletions), (None, None, None, None));
    assert!(!f.scoped);
    assert!(f.commits_note.as_deref().unwrap().contains("another chat"), "{:?}", f.commits_note);
    // No transcript at all is the same: nothing says which commits were its own.
    let f = compute(&inputs(&root, None, Some(&base)));
    assert_eq!(f.commits, None);
    assert!(f.commits_note.is_some());
}

#[test]
fn a_shell_only_sub_shows_uncommitted_as_unknown_not_a_green_zero() {
    let (dir, root) = init();
    std::fs::write(root.join("by-shell.txt"), "written by sed -i or a redirect").unwrap();
    let tp = write_transcript(dir.path(), &[shell("s1", "echo x > by-shell.txt"), result("s1", false, "")]);
    let f = compute(&inputs(&root, Some(&tp), None));
    assert_eq!(f.uncommitted, None);
    assert!(f.uncommitted_note.as_deref().unwrap().contains("only used the shell"), "{:?}", f.uncommitted_note);
    // A sub that ran no shell and edited nothing is a plain zero.
    let tp = write_transcript(dir.path(), &[tool_use("r1", "Read", json!({"file_path": "x"})), result("r1", false, "x")]);
    assert_eq!(compute(&inputs(&root, Some(&tp), None)).uncommitted, Some(0));
    // Edit-tool edits make the count trustworthy even when the sub also used the shell.
    let tp = write_transcript(dir.path(), &[shell("s1", "ls"), result("s1", false, ""), edit("e1", &root.join("by-shell.txt"))]);
    assert_eq!(compute(&inputs(&root, Some(&tp), None)).uncommitted, Some(1));
}

#[test]
fn sum_adds_what_is_known_and_counts_the_unknown_apart() {
    let known = Facts {
        commits: Some(2),
        files_changed: Some(3),
        uncommitted: Some(1),
        pushed: Some(false),
        test: TestFact { state: "passed".into(), ..TestFact::default() },
        reviewer: ReviewerFact { state: "ran".into(), ..ReviewerFact::default() },
        ..Facts::default()
    };
    let git_unknown = Facts { test: TestFact::unknown(), reviewer: ReviewerFact::none("x"), ..Facts::default() };
    let s = sum(&[Some(&known), Some(&known), Some(&git_unknown), None]);
    assert_eq!(s.subs, 4);
    assert_eq!((s.commits, s.files_changed), (4, 6));
    assert_eq!(s.uncommitted, 2);
    assert_eq!(s.unpushed, 2);
    assert_eq!((s.tests_passed, s.tests_failed, s.tests_unknown), (2, 0, 2));
    assert_eq!((s.reviewed, s.unreviewed), (2, 1));
    assert_eq!(s.unknown_subs, 2, "the git-unknown sub and the sub with no stored facts");
}
