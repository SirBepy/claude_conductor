use claude_conductor_lib::slash::enumerate::{hide_idle_pickup, scan_dirs};
use claude_conductor_lib::slash::SlashSource;
use std::fs;

#[test]
fn scans_user_commands_skills_and_project_commands() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();

    fs::create_dir_all(home.path().join("commands")).unwrap();
    fs::write(
        home.path().join("commands/commit.md"),
        "---\ndescription: stage + commit\n---\nARGUMENTS: <flag>\nbody\n",
    )
    .unwrap();

    fs::create_dir_all(home.path().join("skills/foo")).unwrap();
    fs::write(
        home.path().join("skills/foo/SKILL.md"),
        "---\nname: foo\ndescription: do the foo thing\n---\nbody\n",
    )
    .unwrap();

    fs::create_dir_all(proj.path().join(".claude/commands")).unwrap();
    fs::write(
        proj.path().join(".claude/commands/local.md"),
        "---\ndescription: project-scoped\n---\nbody\n",
    )
    .unwrap();

    let out = scan_dirs(home.path(), &[proj.path()]);

    let has = |name: &str, want_source: &dyn Fn(&SlashSource) -> bool| {
        out.iter().any(|e| e.name == name && want_source(&e.source))
    };

    assert!(has("commit", &|s| matches!(s, SlashSource::UserCommand)));
    assert!(has("foo", &|s| matches!(s, SlashSource::UserSkill)));
    assert!(has("local", &|s| matches!(s, SlashSource::ProjectCommand)));

    let commit = out.iter().find(|e| e.name == "commit").unwrap();
    assert_eq!(commit.description, "stage + commit");
    assert_eq!(commit.args.as_deref(), Some("<flag>"));
}

#[test]
fn scans_project_skills_tagged_with_project_basename() {
    let home = tempfile::tempdir().unwrap();
    let proj_root = tempfile::tempdir().unwrap();
    let proj = proj_root.path().join("my_app");
    fs::create_dir_all(&proj).unwrap();

    fs::create_dir_all(proj.join(".claude/skills/local-thing")).unwrap();
    fs::write(
        proj.join(".claude/skills/local-thing/SKILL.md"),
        "---\nname: local-thing\ndescription: project-scoped skill\n---\nbody\n",
    )
    .unwrap();

    let out = scan_dirs(home.path(), &[proj.as_path()]);

    let entry = out.iter().find(|e| e.name == "local-thing").unwrap();
    match &entry.source {
        SlashSource::ProjectSkill { project } => assert_eq!(project, "my_app"),
        other => panic!("expected ProjectSkill, got {other:?}"),
    }
    assert_eq!(entry.description, "project-scoped skill");
}

#[test]
fn scans_plugin_skills_and_commands() {
    let home = tempfile::tempdir().unwrap();

    let plugin_skill_dir = home.path().join("plugins/cache/publisher/myplugin/abc123/skills/foo");
    fs::create_dir_all(&plugin_skill_dir).unwrap();
    fs::write(
        plugin_skill_dir.join("SKILL.md"),
        "---\nname: foo\ndescription: plugin skill\n---\n",
    )
    .unwrap();

    let plugin_cmd_dir = home.path().join("plugins/cache/publisher/myplugin/abc123/commands");
    fs::create_dir_all(&plugin_cmd_dir).unwrap();
    fs::write(
        plugin_cmd_dir.join("bar.md"),
        "---\ndescription: plugin command\n---\nbody\n",
    )
    .unwrap();

    let out = scan_dirs(home.path(), &[]);

    let plugin_skill = out.iter().find(|e| e.name == "foo").unwrap();
    match &plugin_skill.source {
        SlashSource::PluginSkill { plugin } => assert_eq!(plugin, "myplugin"),
        _ => panic!("expected PluginSkill, got {:?}", plugin_skill.source),
    }

    let plugin_cmd = out.iter().find(|e| e.name == "bar").unwrap();
    match &plugin_cmd.source {
        SlashSource::PluginCommand { plugin } => assert_eq!(plugin, "myplugin"),
        _ => panic!("expected PluginCommand, got {:?}", plugin_cmd.source),
    }
}

#[test]
fn includes_builtins() {
    let home = tempfile::tempdir().unwrap();
    let out = scan_dirs(home.path(), &[]);
    assert!(out.iter().any(|e| e.name == "help" && matches!(e.source, SlashSource::Builtin)));
    assert!(out.iter().any(|e| e.name == "clear"));
}

#[test]
fn missing_dirs_are_swallowed() {
    let home = tempfile::tempdir().unwrap();
    let out = scan_dirs(home.path(), &[]);
    assert!(!out.is_empty(), "should at least return builtins");
}

#[test]
fn the_menu_offers_pickup_only_while_plan_md_has_something_to_pick() {
    let home = tempfile::tempdir().unwrap();
    for name in ["pickup", "handoff"] {
        fs::create_dir_all(home.path().join("skills").join(name)).unwrap();
        let skill = format!("---\nname: {name}\ndescription: x\n---\n");
        fs::write(home.path().join("skills").join(name).join("SKILL.md"), skill).unwrap();
    }
    let todos = tempfile::tempdir().unwrap();
    // The names the popup offers; a hidden entry stays in the list, just marked.
    let names = |todos_dir: &std::path::Path| -> Vec<String> {
        let all = hide_idle_pickup(scan_dirs(home.path(), &[]), todos_dir);
        assert!(all.iter().any(|e| e.name == "pickup"), "pickup is marked, never dropped");
        all.into_iter().filter(|e| !e.menu_hidden).map(|e| e.name).collect()
    };

    fs::write(todos.path().join("PLAN.md"), "## Now\n- [x] 1 - done\n").unwrap();
    let idle = names(todos.path());
    assert!(!idle.contains(&"pickup".to_string()));
    assert!(idle.contains(&"handoff".to_string()));

    fs::write(todos.path().join("2-next.md"), "x").unwrap();
    fs::write(todos.path().join("PLAN.md"), "## Now\n- [ ] 2 - next\n").unwrap();
    assert!(names(todos.path()).contains(&"pickup".to_string()));
}
