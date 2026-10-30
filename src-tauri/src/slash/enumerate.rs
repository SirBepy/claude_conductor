use std::fs;
use std::path::Path;

use super::parse::{extract_args, parse_frontmatter};
use super::{builtins, SlashEntry, SlashSource};

pub fn scan_all(project_dir: Option<&Path>) -> Vec<SlashEntry> {
    let projects: Vec<&Path> = project_dir.into_iter().collect();
    scan_all_multi(&projects)
}

/// What the composer's slash menu offers for a project: `scan_all`, with
/// `/pickup` marked `menu_hidden` while the project's PLAN.md has nothing for
/// it to pick up. It stays in the list, so the chat still highlights a
/// `/pickup` mention and /help still lists it; only the popup leaves it out.
/// With no project there is no PLAN.md to judge by, so nothing is marked.
/// Also marks per-project skill scopes (`scope::mark_entries`) from `settings`.
pub fn scan_menu(project_dir: Option<&Path>, settings: &crate::types::Settings) -> Vec<SlashEntry> {
    let mut entries = scan_all(project_dir);
    let project = super::scope::project_id(settings, project_dir);
    super::scope::mark_entries(
        &mut entries,
        &super::scope::scopes(settings),
        project.as_deref(),
        &super::scope::user_enabled_plugins(),
    );
    match project_dir {
        Some(dir) => hide_idle_pickup(entries, &crate::project_dashboard::todo_stats::todos_dir(dir)),
        None => entries,
    }
}

pub fn hide_idle_pickup(mut entries: Vec<SlashEntry>, todos_dir: &Path) -> Vec<SlashEntry> {
    if !crate::project_dashboard::plan::has_pickable(todos_dir) {
        for e in entries.iter_mut().filter(|e| e.name == "pickup") {
            e.menu_hidden = true;
        }
    }
    entries
}

/// Variant of `scan_all` that accepts multiple project dirs. Used by the
/// global Skills view to merge project skills from every known project.
// multi-account audit: stays valid - `commands/`/`skills/`/`plugins/` are
// junctioned into every profile dir, so scanning the shared `~/.claude` tree
// returns the same set regardless of which account is active.
pub fn scan_all_multi(project_dirs: &[&Path]) -> Vec<SlashEntry> {
    let Some(home) = dirs::home_dir() else {
        return builtins::all();
    };
    scan_dirs(&home.join(".claude"), project_dirs)
}

pub fn scan_dirs(home_claude: &Path, project_dirs: &[&Path]) -> Vec<SlashEntry> {
    let mut out = builtins::all();
    scan_commands(&home_claude.join("commands"), &SlashSource::UserCommand, &mut out);
    scan_skills(&home_claude.join("skills"), &SlashSource::UserSkill, &mut out);
    scan_plugins(&home_claude.join("plugins/cache"), &mut out);
    scan_synced_plugins(&home_claude.join("plugins/synced"), &mut out);
    for p in project_dirs {
        scan_commands(&p.join(".claude/commands"), &SlashSource::ProjectCommand, &mut out);
        let project_name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let skill_src = SlashSource::ProjectSkill { project: project_name };
        scan_skills(&p.join(".claude/skills"), &skill_src, &mut out);
    }
    out
}

fn scan_commands(dir: &Path, src: &SlashSource, out: &mut Vec<SlashEntry>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for ent in entries.flatten() {
        let p = ent.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        let Ok(body) = fs::read_to_string(&p) else {
            log::warn!("[slash] unreadable: {}", p.display());
            continue;
        };
        let fm = parse_frontmatter(&body);
        let description = fm.description.unwrap_or_else(|| first_nonempty_line(&body));
        out.push(SlashEntry {
            name: fm.name.unwrap_or_else(|| stem.to_string()),
            args: extract_args(&body),
            description,
            source: src.clone(),
            path: Some(p.to_string_lossy().into_owned()),
            menu_hidden: false,
            scope_key: None,
            off_here: false,
        });
    }
}

fn scan_skills(dir: &Path, src: &SlashSource, out: &mut Vec<SlashEntry>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for ent in entries.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        let skill_file = p.join("SKILL.md");
        let Ok(body) = fs::read_to_string(&skill_file) else { continue };
        let fm = parse_frontmatter(&body);
        let Some(name) = fm
            .name
            .clone()
            .or_else(|| p.file_name().and_then(|s| s.to_str()).map(String::from))
        else {
            continue;
        };
        // Only user skills scope by name; a plugin's whole set gets the
        // plugin's key in `scan_plugins`, and project skills are already local.
        let scope_key = matches!(src, SlashSource::UserSkill).then(|| name.clone());
        out.push(SlashEntry {
            name,
            args: extract_args(&body),
            description: fm.description.unwrap_or_default(),
            source: src.clone(),
            path: Some(skill_file.to_string_lossy().into_owned()),
            menu_hidden: false,
            scope_key,
            off_here: false,
        });
    }
}

fn scan_plugins(dir: &Path, out: &mut Vec<SlashEntry>) {
    // Structure: cache/<publisher>/<plugin>/<version>/skills/
    let Ok(publishers) = fs::read_dir(dir) else { return };
    for pub_ent in publishers.flatten() {
        let pub_root = pub_ent.path();
        if !pub_root.is_dir() {
            continue;
        }
        let Ok(plugins) = fs::read_dir(&pub_root) else { continue };
        for plugin_ent in plugins.flatten() {
            let plugin_root = plugin_ent.path();
            if !plugin_root.is_dir() {
                continue;
            }
            let plugin_name = match plugin_ent.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let Ok(versions) = fs::read_dir(&plugin_root) else { continue };
            let mut version_dirs: Vec<_> =
                versions.flatten().filter(|e| e.path().is_dir()).collect();
            version_dirs.sort_by_key(|e| e.file_name());
            if let Some(latest) = version_dirs.last() {
                // The cache's publisher dir is the marketplace name, so this is
                // the plugin's `enabledPlugins` key.
                let key = format!("{plugin_name}@{}", pub_ent.file_name().to_string_lossy());
                scan_plugin_root(&latest.path(), &plugin_name, &key, out);
            }
        }
    }
}

/// Plugins synced from the claude.ai account. Unlike the cache they have no
/// marketplace/version dirs: `synced/<account>_<org>/<plugin uuid>/` holds the
/// plugin directly, and the dir name is a uuid, so the real name (the one
/// `enabledPlugins` knows it by, always under the `synced` marketplace) comes
/// from `.claude-plugin/plugin.json`. A plugin without a readable name is
/// skipped: it could not be scoped or toggled under any key.
fn scan_synced_plugins(dir: &Path, out: &mut Vec<SlashEntry>) {
    let Ok(accounts) = fs::read_dir(dir) else { return };
    for account in accounts.flatten() {
        let account_root = account.path();
        // `.bucket-*` siblings are sync bookkeeping, not plugin containers.
        if !account_root.is_dir() || account.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(plugins) = fs::read_dir(&account_root) else { continue };
        for plugin in plugins.flatten() {
            let plugin_root = plugin.path();
            if !plugin_root.is_dir() {
                continue;
            }
            let Some(name) = synced_plugin_name(&plugin_root) else { continue };
            let key = format!("{name}@synced");
            scan_plugin_root(&plugin_root, &name, &key, out);
        }
    }
}

fn synced_plugin_name(plugin_root: &Path) -> Option<String> {
    let body = fs::read_to_string(plugin_root.join(".claude-plugin/plugin.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let name = json.get("name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// One plugin directory's skills and commands, all keyed to the plugin's
/// `enabledPlugins` key so they scope as a unit.
fn scan_plugin_root(root: &Path, plugin_name: &str, key: &str, out: &mut Vec<SlashEntry>) {
    let skill_src = SlashSource::PluginSkill { plugin: plugin_name.to_string() };
    let cmd_src = SlashSource::PluginCommand { plugin: plugin_name.to_string() };
    let first = out.len();
    scan_skills(&root.join("skills"), &skill_src, out);
    scan_commands(&root.join("commands"), &cmd_src, out);
    for e in &mut out[first..] {
        e.scope_key = Some(key.to_string());
    }
}

fn first_nonempty_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(dir: &Path, name: &str) {
        let d = dir.join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), format!("---
name: {name}
description: d
---
")).unwrap();
    }

    #[test]
    fn scope_keys_are_the_skill_name_or_the_plugins_enabled_plugins_key() {
        let home = tempfile::tempdir().unwrap();
        skill(&home.path().join("skills"), "figma-tiles");
        skill(&home.path().join("plugins/cache/claude-plugins-official/figma/2.0.0/skills"), "figma-use");
        let project = tempfile::tempdir().unwrap();
        skill(&project.path().join(".claude/skills"), "local-only");

        let entries = scan_dirs(home.path(), &[project.path()]);
        let key = |n: &str| entries.iter().find(|e| e.name == n).unwrap().scope_key.clone();
        assert_eq!(key("figma-tiles").as_deref(), Some("figma-tiles"));
        assert_eq!(key("figma-use").as_deref(), Some("figma@claude-plugins-official"));
        assert_eq!(key("local-only"), None);
        assert_eq!(key("help"), None);
    }

    fn synced_plugin(home: &Path, account: &str, dir: &str, plugin_json: Option<&str>) -> std::path::PathBuf {
        let root = home.join("plugins/synced").join(account).join(dir);
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        if let Some(json) = plugin_json {
            fs::write(root.join(".claude-plugin/plugin.json"), json).unwrap();
        }
        root
    }

    #[test]
    fn a_synced_plugins_skills_and_commands_are_keyed_name_at_synced() {
        let home = tempfile::tempdir().unwrap();
        let root = synced_plugin(home.path(), "acct_org", "afe29730", Some(r#"{"name":"design","version":"1.2.0"}"#));
        skill(&root.join("skills"), "ux-copy");
        fs::create_dir_all(root.join("commands")).unwrap();
        fs::write(root.join("commands/critique.md"), "---\ndescription: c\n---\n").unwrap();
        // Sync bookkeeping next to the account dirs must not be walked as one.
        let bucket = home.path().join("plugins/synced/.bucket-acct_org/stray");
        skill(&bucket.join("skills"), "stray-skill");

        let entries = scan_dirs(home.path(), &[]);
        let find = |n: &str| entries.iter().find(|e| e.name == n);
        let skill_entry = find("ux-copy").expect("synced skill listed");
        assert_eq!(skill_entry.scope_key.as_deref(), Some("design@synced"));
        assert!(matches!(&skill_entry.source, SlashSource::PluginSkill { plugin } if plugin == "design"));
        let cmd_entry = find("critique").expect("synced command listed");
        assert_eq!(cmd_entry.scope_key.as_deref(), Some("design@synced"));
        assert!(matches!(&cmd_entry.source, SlashSource::PluginCommand { plugin } if plugin == "design"));
        assert!(find("stray-skill").is_none());
    }

    #[test]
    fn a_synced_plugin_with_a_missing_or_malformed_manifest_is_skipped() {
        let home = tempfile::tempdir().unwrap();
        for (dir, json) in [
            ("missing", None),
            ("garbage", Some("{not json")),
            ("no-name", Some(r#"{"version":"1"}"#)),
            ("blank-name", Some(r#"{"name":"  "}"#)),
            ("numeric-name", Some(r#"{"name":7}"#)),
        ] {
            let root = synced_plugin(home.path(), "acct_org", dir, json);
            skill(&root.join("skills"), &format!("skill-{dir}"));
        }
        // A stray file where an account dir is expected is not a container.
        fs::write(home.path().join("plugins/synced/manifest.json"), "{}").unwrap();

        let entries = scan_dirs(home.path(), &[]);
        assert!(entries.iter().all(|e| !e.name.starts_with("skill-")));
    }
}
