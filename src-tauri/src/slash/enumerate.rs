use std::fs;
use std::path::Path;

use super::parse::{extract_args, parse_frontmatter};
use super::{builtins, SlashEntry, SlashSource};

pub fn scan_all(project_dir: Option<&Path>) -> Vec<SlashEntry> {
    let projects: Vec<&Path> = project_dir.into_iter().collect();
    scan_all_multi(&projects)
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
        out.push(SlashEntry {
            name,
            args: extract_args(&body),
            description: fm.description.unwrap_or_default(),
            source: src.clone(),
            path: Some(skill_file.to_string_lossy().into_owned()),
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
            let skill_src = SlashSource::PluginSkill { plugin: plugin_name.clone() };
            let cmd_src = SlashSource::PluginCommand { plugin: plugin_name.clone() };
            let Ok(versions) = fs::read_dir(&plugin_root) else { continue };
            let mut version_dirs: Vec<_> =
                versions.flatten().filter(|e| e.path().is_dir()).collect();
            version_dirs.sort_by_key(|e| e.file_name());
            if let Some(latest) = version_dirs.last() {
                let vp = latest.path();
                scan_skills(&vp.join("skills"), &skill_src, out);
                scan_commands(&vp.join("commands"), &cmd_src, out);
            }
        }
    }
}

fn first_nonempty_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}
