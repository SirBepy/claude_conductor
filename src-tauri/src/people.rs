//! The user's people, read from the `People/` folder of their Obsidian vault.
//! One `.md` file per person, frontmatter per the vault's own
//! `Templates/Person.md` (`name`, `aliases`, `relationship`). The vault is the
//! single source of truth: the app never keeps its own copy of the list, so a
//! person added or renamed in Obsidian shows up on the next read.
//!
//! A person's identity is the file stem, because that is what Obsidian links
//! by (`[[Bruno Kecman]]`); `name` is only a display override and the
//! template ships it empty.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

const PEOPLE_DIR: &str = "People";
const TEMPLATE: &str = "Templates/Person.md";

/// Mirrors the vault's `Templates/Person.md`, used only when that file is gone.
const FALLBACK_TEMPLATE: &str = "---\nname: \"\"\naliases: []\nbirthday: \nrelationship: \"\"\nlast_seen: \ntags: [person]\n---\n\n# {{title}}\n\n## Notes\n\n";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Person {
    /// File stem under `People/`. The stable key drafts store.
    pub id: String,
    /// Frontmatter `name`, or the stem when that is empty.
    pub name: String,
    pub aliases: Vec<String>,
    pub relationship: String,
}

/// `CC_VAULT_DIR` wins; otherwise the vault Obsidian itself last had open,
/// read from its own `obsidian.json`. `None` means drafts run without people.
pub fn vault_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CC_VAULT_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let config = dirs::config_dir()?.join("obsidian").join("obsidian.json");
    vault_from_obsidian_json(&fs::read_to_string(config).ok()?)
}

fn vault_from_obsidian_json(text: &str) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let vaults = v.get("vaults")?.as_object()?;
    let mut entries: Vec<&serde_json::Value> = vaults.values().collect();
    // The open vault first, then the most recently used one.
    entries.sort_by_key(|e| {
        let open = e.get("open").and_then(|o| o.as_bool()).unwrap_or(false);
        let ts = e.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
        (std::cmp::Reverse(open), std::cmp::Reverse(ts))
    });
    let path = entries.first()?.get("path")?.as_str()?;
    Some(PathBuf::from(path))
}

/// Everyone under `<vault>/People/`, sorted by id. Unreadable files are
/// skipped, never an error: a half-synced vault must not break drafting.
pub fn list_at(vault: &Path) -> Vec<Person> {
    let Ok(entries) = fs::read_dir(vault.join(PEOPLE_DIR)) else { return Vec::new() };
    let mut people: Vec<Person> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let text = fs::read_to_string(&path).unwrap_or_default();
            Some(person_from(id, &text))
        })
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    people
}

fn person_from(id: String, text: &str) -> Person {
    let fm = Frontmatter::parse(text);
    let name = if fm.name.is_empty() { id.clone() } else { fm.name };
    Person { id, name, aliases: fm.aliases, relationship: fm.relationship }
}

#[derive(Default)]
struct Frontmatter {
    name: String,
    aliases: Vec<String>,
    relationship: String,
}

impl Frontmatter {
    /// The YAML subset the Person template uses: `key: value`, an inline
    /// `[a, "b"]` list, or a block list of `- a` lines under an empty key.
    fn parse(text: &str) -> Self {
        let mut out = Frontmatter::default();
        let mut lines = text.lines();
        if lines.next().map(str::trim) != Some("---") {
            return out;
        }
        let mut in_aliases_block = false;
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            if in_aliases_block {
                if let Some(item) = line.trim().strip_prefix("- ") {
                    push_nonempty(&mut out.aliases, item);
                    continue;
                }
                in_aliases_block = false;
            }
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            match key.trim() {
                "name" => out.name = unquote(value),
                "relationship" => out.relationship = unquote(value),
                "aliases" if value.is_empty() => in_aliases_block = true,
                "aliases" => {
                    let inner = value.trim_start_matches('[').trim_end_matches(']');
                    for item in inner.split(',') {
                        push_nonempty(&mut out.aliases, item);
                    }
                }
                _ => {}
            }
        }
        out
    }
}

fn push_nonempty(list: &mut Vec<String>, raw: &str) {
    let v = unquote(raw.trim());
    if !v.is_empty() {
        list.push(v);
    }
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let stripped = v
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')));
    stripped.unwrap_or(v).trim().to_string()
}

/// Lowercased, a trailing `(...)` dropped: "Tajana (Linear comment on REV-7345)"
/// is still Tajana.
fn norm(text: &str) -> String {
    let t = text.trim();
    let t = match (t.rfind('('), t.ends_with(')')) {
        (Some(i), true) if i > 0 => &t[..i],
        _ => t,
    };
    t.trim().to_lowercase()
}

fn first_word(text: &str) -> &str {
    text.split_whitespace().next().unwrap_or("")
}

#[derive(Debug, PartialEq)]
pub enum Resolved<'a> {
    One(&'a Person),
    Ambiguous(Vec<&'a Person>),
    None,
}

/// Matches `text` against every id, name and alias. An exact hit wins; a bare
/// first name ("Johanna") falls back to a first-word match, and only counts
/// when exactly one person has that first word.
pub fn resolve<'a>(people: &'a [Person], text: &str) -> Resolved<'a> {
    let wanted = norm(text);
    if wanted.is_empty() {
        return Resolved::None;
    }
    let names = |p: &'a Person| {
        std::iter::once(p.id.as_str()).chain(std::iter::once(p.name.as_str())).chain(p.aliases.iter().map(String::as_str))
    };
    let exact: Vec<&Person> = people.iter().filter(|p| names(p).any(|n| norm(n) == wanted)).collect();
    if let [one] = exact.as_slice() {
        return Resolved::One(one);
    }
    if exact.len() > 1 {
        return Resolved::Ambiguous(exact);
    }
    if wanted.split_whitespace().count() != 1 {
        return Resolved::None;
    }
    let by_first: Vec<&Person> =
        people.iter().filter(|p| names(p).any(|n| first_word(&norm(n)) == wanted)).collect();
    match by_first.len() {
        0 => Resolved::None,
        1 => Resolved::One(by_first[0]),
        _ => Resolved::Ambiguous(by_first),
    }
}

/// Creates `<vault>/People/<name>.md` from the vault's Person template, with
/// name, aliases and relationship filled in. Never overwrites: a file that
/// already exists is read back and returned as-is.
pub fn create_stub_at(vault: &Path, name: &str, aliases: &[String], relationship: &str) -> Result<Person, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.starts_with('.') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("not a usable file name for a person: {name:?}"));
    }
    let dir = vault.join(PEOPLE_DIR);
    if !dir.is_dir() {
        return Err(format!("no People folder in the vault at {}", vault.display()));
    }
    let path = dir.join(format!("{name}.md"));
    let template = fs::read_to_string(vault.join(TEMPLATE)).unwrap_or_else(|_| FALLBACK_TEMPLATE.to_string());
    let text = fill_template(&template, name, aliases, relationship);
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(text.as_bytes()).map_err(|e| format!("writing {}: {e}", path.display()))?;
            Ok(person_from(name.to_string(), &text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(person_from(name.to_string(), &fs::read_to_string(&path).unwrap_or_default()))
        }
        Err(e) => Err(format!("creating {}: {e}", path.display())),
    }
}

fn yaml_str(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Rewrites only the three frontmatter keys this knows, line by line, so
/// whatever else the user's template carries survives untouched.
fn fill_template(template: &str, name: &str, aliases: &[String], relationship: &str) -> String {
    let mut in_frontmatter = false;
    let mut seen_open = false;
    let mut out = String::with_capacity(template.len() + 64);
    for line in template.lines() {
        if line.trim() == "---" {
            in_frontmatter = !seen_open;
            seen_open = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let key = line.split_once(':').map(|(k, _)| k.trim());
        let replaced = match (in_frontmatter, key) {
            (true, Some("name")) => Some(format!("name: {}", yaml_str(name))),
            (true, Some("aliases")) => {
                let list: Vec<String> = aliases.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(yaml_str).collect();
                Some(format!("aliases: [{}]", list.join(", ")))
            }
            (true, Some("relationship")) if !relationship.trim().is_empty() => {
                Some(format!("relationship: {}", yaml_str(relationship.trim())))
            }
            _ => None,
        };
        out.push_str(&replaced.unwrap_or_else(|| line.replace("{{title}}", name)));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: &str, aliases: &[&str]) -> Person {
        Person { id: id.into(), name: id.into(), aliases: aliases.iter().map(|a| a.to_string()).collect(), relationship: String::new() }
    }

    fn vault_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(PEOPLE_DIR)).unwrap();
        for (name, body) in files {
            fs::write(dir.path().join(PEOPLE_DIR).join(format!("{name}.md")), body).unwrap();
        }
        dir
    }

    #[test]
    fn frontmatter_reads_inline_and_block_alias_lists() {
        let inline = Frontmatter::parse("---\nname: Bruno Kecman\naliases: [Bruno, \"Nuno\"]\nrelationship: friend\n---\n# x");
        assert_eq!(inline.name, "Bruno Kecman");
        assert_eq!(inline.aliases, vec!["Bruno", "Nuno"]);
        assert_eq!(inline.relationship, "friend");
        let block = Frontmatter::parse("---\naliases:\n  - Dani\n  - 'Donna'\nrelationship: \"\"\n---\n");
        assert_eq!(block.aliases, vec!["Dani", "Donna"]);
        assert_eq!(block.relationship, "");
    }

    #[test]
    fn an_empty_template_name_falls_back_to_the_file_stem() {
        let vault = vault_with(&[("Lenar Rakhmatulin", "---\nname: \"\"\naliases: []\n---\n")]);
        let people = list_at(vault.path());
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].id, "Lenar Rakhmatulin");
        assert_eq!(people[0].name, "Lenar Rakhmatulin");
    }

    #[test]
    fn resolve_matches_alias_and_strips_a_trailing_parenthetical() {
        let people = vec![person("Bruno Kecman", &["Nuno"]), person("Tajana", &[])];
        assert_eq!(resolve(&people, "nuno"), Resolved::One(&people[0]));
        assert_eq!(resolve(&people, "Tajana (Linear comment on REV-7345)"), Resolved::One(&people[1]));
    }

    #[test]
    fn a_bare_first_name_resolves_only_when_unique() {
        let people = vec![person("Johanna Chen", &[]), person("Storm Theobald", &[]), person("Storm's Mom", &[])];
        assert_eq!(resolve(&people, "Johanna"), Resolved::One(&people[0]));
        assert_eq!(resolve(&people, "Bruno"), Resolved::None);
        let two = vec![person("Jon Kojakovic", &[]), person("Jon Snow", &[])];
        assert!(matches!(resolve(&two, "Jon"), Resolved::Ambiguous(v) if v.len() == 2));
    }

    #[test]
    fn stub_fills_the_users_template_and_never_overwrites() {
        let vault = vault_with(&[]);
        fs::create_dir_all(vault.path().join("Templates")).unwrap();
        fs::write(
            vault.path().join(TEMPLATE),
            "---\nname: \"\"\naliases: []\nbirthday: \nrelationship: \"\"\ntags: [person]\n---\n\n# {{title}}\n\n## Gift Ideas\n",
        )
        .unwrap();
        let made = create_stub_at(vault.path(), "Johanna Chen", &["Johanna".into()], "coworker").unwrap();
        assert_eq!(made.id, "Johanna Chen");
        assert_eq!(made.aliases, vec!["Johanna"]);
        assert_eq!(made.relationship, "coworker");
        let text = fs::read_to_string(vault.path().join("People/Johanna Chen.md")).unwrap();
        assert!(text.contains("# Johanna Chen"), "{text}");
        assert!(text.contains("## Gift Ideas"), "template body kept: {text}");
        assert!(text.contains("tags: [person]"), "{text}");

        fs::write(vault.path().join("People/Johanna Chen.md"), "---\nrelationship: boss\n---\nmine").unwrap();
        let again = create_stub_at(vault.path(), "Johanna Chen", &[], "coworker").unwrap();
        assert_eq!(again.relationship, "boss");
        assert!(fs::read_to_string(vault.path().join("People/Johanna Chen.md")).unwrap().ends_with("mine"));
    }

    #[test]
    fn stub_rejects_a_name_that_would_escape_the_people_folder() {
        let vault = vault_with(&[]);
        assert!(create_stub_at(vault.path(), "../evil", &[], "").is_err());
        assert!(create_stub_at(vault.path(), "", &[], "").is_err());
    }

    #[test]
    fn obsidian_json_prefers_the_open_vault() {
        let json = r#"{"vaults":{"a":{"path":"C:\\old","ts":9,"open":false},"b":{"path":"C:\\Vault","ts":1,"open":true}}}"#;
        assert_eq!(vault_from_obsidian_json(json), Some(PathBuf::from("C:\\Vault")));
    }
}
