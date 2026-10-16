//! The user's people, read from the `People/` folder of their Obsidian vault.
//! One `.md` file per person, frontmatter per the vault's own
//! `Templates/Person.md` (`name`, `aliases`, `relationship`). The vault is the
//! single source of truth: the app never keeps its own copy of the list, so a
//! person added or renamed in Obsidian shows up on the next read.
//!
//! A person's identity is the file stem, because that is what Obsidian links
//! by (`[[Bruno Kecman]]`); `name` is only a display override and the
//! template ships it empty.
//!
//! A client (Zirtue, Revaire) is any note at the vault root whose frontmatter
//! lists `repos:`; its slug is the lowercased note name. A person's
//! `projects: [zirtue]` ties them to clients, and `project_aliases:
//! ["zirtue: backend"]` holds names used for them inside one client only.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

const PEOPLE_DIR: &str = "People";
const TEMPLATE: &str = "Templates/Person.md";

/// Mirrors the vault's `Templates/Person.md`, used only when that file is gone.
const FALLBACK_TEMPLATE: &str = "---\nname: \"\"\naliases: []\nbirthday: \nrelationship: \"\"\nlast_seen: \ngender: \nlanguage: \nmessaged_on: []\nprojects: []\nproject_aliases: []\ntags: [person]\n---\n\n# {{title}}\n\n## Notes\n\n";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Person {
    /// File stem under `People/`. The stable key drafts store.
    pub id: String,
    /// Frontmatter `name`, or the stem when that is empty.
    pub name: String,
    pub aliases: Vec<String>,
    pub relationship: String,
    #[serde(default)]
    pub gender: String,
    #[serde(default)]
    pub language: String,
    /// Where the user writes to them: Slack, Shortcut, Google Chat...
    #[serde(default)]
    pub messaged_on: Vec<String>,
    /// Client slugs they belong to. Empty means not tied to one client (a
    /// friend, an agency contact), so they count as known everywhere.
    #[serde(default)]
    pub projects: Vec<String>,
    /// `"zirtue: backend"`: a name for them inside that client only.
    #[serde(default)]
    pub project_aliases: Vec<String>,
}

impl Person {
    /// Their names that only apply inside `client`, e.g. "backend".
    pub fn aliases_in<'a>(&'a self, client: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.project_aliases.iter().filter_map(move |entry| {
            let (slug, name) = entry.split_once(':')?;
            (slug.trim().eq_ignore_ascii_case(client)).then(|| name.trim())
        })
    }

    pub fn belongs_to(&self, client: &str) -> bool {
        self.projects.iter().any(|p| p.trim().eq_ignore_ascii_case(client))
    }
}

/// A client note: `Zirtue.md` with `repos: [zng-app, ...]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    /// Lowercased note name, the key `projects`/`project_aliases` use.
    pub slug: String,
    pub name: String,
    pub repos: Vec<String>,
}

/// Every root-level note with a `repos:` list. Subfolders are not scanned:
/// journals and research notes never name repos, and the root is where
/// client notes live.
pub fn clients_at(vault: &Path) -> Vec<Client> {
    let Ok(entries) = fs::read_dir(vault) else { return Vec::new() };
    let mut clients: Vec<Client> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let text = fs::read_to_string(&path).ok()?;
            let repos = Frontmatter::parse(&text).list("repos");
            if repos.is_empty() {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_string();
            Some(Client { slug: name.to_lowercase(), name, repos })
        })
        .collect();
    clients.sort_by(|a, b| a.slug.cmp(&b.slug));
    clients
}

/// The client whose `repos` names any of `repo_names` (a Conductor project's
/// name, its folder name), case-insensitively.
pub fn client_for<'a>(clients: &'a [Client], repo_names: &[&str]) -> Option<&'a Client> {
    clients.iter().find(|c| {
        c.repos.iter().any(|r| repo_names.iter().any(|n| !n.trim().is_empty() && r.trim().eq_ignore_ascii_case(n.trim())))
    })
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
    let name = fm.scalar("name");
    Person {
        name: if name.is_empty() { id.clone() } else { name },
        id,
        aliases: fm.list("aliases"),
        relationship: fm.scalar("relationship"),
        gender: fm.scalar("gender"),
        language: fm.scalar("language"),
        messaged_on: fm.list("messaged_on"),
        projects: fm.list("projects"),
        project_aliases: fm.list("project_aliases"),
    }
}

/// Every `key: value` in a note's frontmatter, in order. A key with an empty
/// value followed by `- item` lines is a block list.
#[derive(Default)]
struct Frontmatter {
    entries: Vec<(String, FmValue)>,
}

enum FmValue {
    Scalar(String),
    List(Vec<String>),
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
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            if let Some(item) = line.trim().strip_prefix("- ") {
                if let Some((_, value)) = out.entries.last_mut() {
                    if let FmValue::Scalar(s) = value {
                        if s.is_empty() {
                            *value = FmValue::List(Vec::new());
                        }
                    }
                    if let FmValue::List(items) = value {
                        push_nonempty(items, item);
                    }
                }
                continue;
            }
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            let parsed = match value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                Some(inner) => {
                    let mut items = Vec::new();
                    for item in inner.split(',') {
                        push_nonempty(&mut items, item);
                    }
                    FmValue::List(items)
                }
                None => FmValue::Scalar(unquote(value)),
            };
            out.entries.push((key.trim().to_string(), parsed));
        }
        out
    }

    fn scalar(&self, key: &str) -> String {
        match self.entries.iter().find(|(k, _)| k == key) {
            Some((_, FmValue::Scalar(s))) => s.clone(),
            _ => String::new(),
        }
    }

    fn list(&self, key: &str) -> Vec<String> {
        match self.entries.iter().find(|(k, _)| k == key) {
            Some((_, FmValue::List(items))) => items.clone(),
            _ => Vec::new(),
        }
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
    resolve_in(people, text, None)
}

/// `resolve`, also matching the names people go by inside `client` only
/// ("backend" for Stevan in zirtue).
pub fn resolve_in<'a>(people: &'a [Person], text: &str, client: Option<&'a str>) -> Resolved<'a> {
    let wanted = norm(text);
    if wanted.is_empty() {
        return Resolved::None;
    }
    let names = |p: &'a Person| {
        std::iter::once(p.id.as_str())
            .chain(std::iter::once(p.name.as_str()))
            .chain(p.aliases.iter().map(String::as_str))
            .chain(client.into_iter().flat_map(move |c| p.aliases_in(c)))
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

/// People whose name or alias is within two letters of `text` ("Stefan" for
/// Stevan): the suggestions for a name nobody matches, since a voice mishear
/// is the common way a known person comes in unrecognised.
pub fn similar<'a>(people: &'a [Person], text: &str) -> Vec<&'a Person> {
    let wanted = norm(text);
    if wanted.chars().count() < 3 {
        return Vec::new();
    }
    let close = |n: &str| {
        let n = norm(n);
        edit_distance(&n, &wanted) <= 2 || edit_distance(first_word(&n), &wanted) <= 2
    };
    people
        .iter()
        .filter(|p| close(&p.id) || close(&p.name) || p.aliases.iter().any(|a| close(a)))
        .collect()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = if ca == *cb { prev } else { 1 + prev.min(cur).min(row[j]) };
            prev = cur;
        }
    }
    row[b.len()]
}

/// Adds `value` to the list `key` in `People/<id>.md`'s frontmatter, editing
/// only that line (or appending one block item, or adding the key), so a
/// concurrent edit elsewhere in the note survives. Already present
/// (case-insensitive) is a no-op. Returns the person as re-read.
pub fn add_to_list_at(vault: &Path, id: &str, key: &str, value: &str) -> Result<Person, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("nothing to add to {key}"));
    }
    let path = vault.join(PEOPLE_DIR).join(format!("{id}.md"));
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let current = person_from(id.to_string(), &text);
    let existing = Frontmatter::parse(&text).list(key);
    if existing.iter().any(|v| v.eq_ignore_ascii_case(value)) {
        return Ok(current);
    }
    let updated = with_list_item(&text, key, value).ok_or_else(|| format!("{} has no frontmatter", path.display()))?;
    fs::write(&path, &updated).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(person_from(id.to_string(), &updated))
}

/// `text` with `value` appended to frontmatter list `key`. `None` when the
/// note has no frontmatter block to put it in.
fn with_list_item(text: &str, key: &str, value: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return None;
    }
    let close = lines.iter().skip(1).position(|l| l.trim() == "---")? + 1;
    let item = yaml_str(value);
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let at = (1..close).find(|&i| lines[i].split_once(':').map(|(k, _)| k.trim()) == Some(key));
    match at {
        Some(i) => {
            let rest = lines[i].split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            if let Some(inner) = rest.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                let joined = if inner.trim().is_empty() { item } else { format!("{}, {item}", inner.trim()) };
                out[i] = format!("{key}: [{joined}]");
            } else if rest.is_empty() {
                // A block list (or an empty key): the item goes after its last `- ` line.
                let mut end = i + 1;
                while end < close && lines[end].trim().starts_with("- ") {
                    end += 1;
                }
                out.insert(end, format!("  - {item}"));
            } else {
                out[i] = format!("{key}: [{}, {item}]", yaml_str(&unquote(rest)));
            }
        }
        None => out.insert(close, format!("{key}: [{item}]")),
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    Some(joined)
}

/// What the new-person questionnaire collects, beyond the name.
#[derive(Default)]
pub struct NewPerson {
    pub aliases: Vec<String>,
    pub relationship: String,
    pub gender: String,
    pub language: String,
    pub messaged_on: Vec<String>,
    pub projects: Vec<String>,
}

/// Creates `<vault>/People/<name>.md` from the vault's Person template, with
/// name, aliases and relationship filled in. Never overwrites: a file that
/// already exists is read back and returned as-is.
pub fn create_stub_at(vault: &Path, name: &str, aliases: &[String], relationship: &str) -> Result<Person, String> {
    let fields = NewPerson { aliases: aliases.to_vec(), relationship: relationship.to_string(), ..Default::default() };
    create_at(vault, name, &fields)
}

/// `create_stub_at` with every questionnaire answer filled in.
pub fn create_at(vault: &Path, name: &str, fields: &NewPerson) -> Result<Person, String> {
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
    let text = fill_template(&template, name, fields);
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

fn yaml_list(items: &[String]) -> String {
    let list: Vec<String> = items.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(yaml_str).collect();
    format!("[{}]", list.join(", "))
}

/// Rewrites only the frontmatter keys this knows, line by line, so whatever
/// else the user's template carries survives untouched. A known key the
/// template lacks (an older template) is added before the closing `---`.
fn fill_template(template: &str, name: &str, f: &NewPerson) -> String {
    let scalar = |v: &str| (!v.trim().is_empty()).then(|| yaml_str(v.trim()));
    let list = |v: &[String]| (!v.is_empty()).then(|| yaml_list(v));
    let mut known: Vec<(&str, Option<String>)> = vec![
        ("name", Some(yaml_str(name))),
        ("aliases", Some(yaml_list(&f.aliases))),
        ("relationship", scalar(&f.relationship)),
        ("gender", scalar(&f.gender)),
        ("language", scalar(&f.language)),
        ("messaged_on", list(&f.messaged_on)),
        ("projects", list(&f.projects)),
    ];
    let mut in_frontmatter = false;
    let mut seen_open = false;
    let mut out = String::with_capacity(template.len() + 128);
    for line in template.lines() {
        if line.trim() == "---" {
            if in_frontmatter {
                for (key, value) in known.iter_mut() {
                    if let Some(v) = value.take() {
                        out.push_str(&format!("{key}: {v}\n"));
                    }
                }
            }
            in_frontmatter = !seen_open;
            seen_open = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let key = line.split_once(':').map(|(k, _)| k.trim());
        let slot = match (in_frontmatter, key) {
            (true, Some(k)) => known.iter_mut().find(|(name, _)| *name == k),
            _ => None,
        };
        let replaced = slot.and_then(|(key, value)| value.take().map(|v| format!("{key}: {v}")));
        out.push_str(&replaced.unwrap_or_else(|| line.replace("{{title}}", name)));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: &str, aliases: &[&str]) -> Person {
        Person { id: id.into(), name: id.into(), aliases: aliases.iter().map(|a| a.to_string()).collect(), ..Default::default() }
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
        assert_eq!(inline.scalar("name"), "Bruno Kecman");
        assert_eq!(inline.list("aliases"), vec!["Bruno", "Nuno"]);
        assert_eq!(inline.scalar("relationship"), "friend");
        let block = Frontmatter::parse("---\naliases:\n  - Dani\n  - 'Donna'\nrelationship: \"\"\n---\n");
        assert_eq!(block.list("aliases"), vec!["Dani", "Donna"]);
        assert_eq!(block.scalar("relationship"), "");
    }

    const STEVAN: &str = "---\nname: \"Stevan\"\naliases: []\nrelationship: \"coworker (Zirtue backend dev)\"\ngender: male\nlanguage: Croatian in DMs, English on Shortcut\nmessaged_on: [Slack, Shortcut]\nprojects: [zirtue]\nproject_aliases: [\"zirtue: backend\"]\ntags: [person, work]\n---\n\n# Stevan\n";

    #[test]
    fn a_person_reads_the_questionnaire_fields() {
        let p = person_from("Stevan".into(), STEVAN);
        assert_eq!(p.gender, "male");
        assert_eq!(p.language, "Croatian in DMs, English on Shortcut");
        assert_eq!(p.messaged_on, vec!["Slack", "Shortcut"]);
        assert_eq!(p.projects, vec!["zirtue"]);
        assert!(p.belongs_to("Zirtue"));
        assert_eq!(p.aliases_in("zirtue").collect::<Vec<_>>(), vec!["backend"]);
        assert_eq!(p.aliases_in("revaire").count(), 0);
    }

    #[test]
    fn a_client_nickname_resolves_only_inside_that_client() {
        let people = vec![person_from("Stevan".into(), STEVAN), person("Lenar Rakhmatulin", &["Lenar"])];
        assert_eq!(resolve_in(&people, "backend", Some("zirtue")), Resolved::One(&people[0]));
        assert_eq!(resolve_in(&people, "backend", Some("revaire")), Resolved::None);
        assert_eq!(resolve(&people, "backend"), Resolved::None);
    }

    #[test]
    fn clients_come_from_root_notes_that_list_repos() {
        let vault = vault_with(&[]);
        fs::write(vault.path().join("Zirtue.md"), "---\ntitle: Zirtue\nrepos: [zng-app, zng-api]\n---\n# Zirtue").unwrap();
        fs::write(vault.path().join("Revaire.md"), "---\nrepos:\n  - revaire-mobile\n---\n").unwrap();
        fs::write(vault.path().join("Rust.md"), "---\ntags: [lang]\n---\n").unwrap();
        let clients = clients_at(vault.path());
        assert_eq!(clients.iter().map(|c| c.slug.as_str()).collect::<Vec<_>>(), vec!["revaire", "zirtue"]);
        assert_eq!(client_for(&clients, &["ZNG-API"]).map(|c| c.slug.as_str()), Some("zirtue"));
        assert_eq!(client_for(&clients, &["claude_usage_in_taskbar", "revaire-mobile"]).map(|c| c.slug.as_str()), Some("revaire"));
        assert_eq!(client_for(&clients, &["fibo", ""]), None);
    }

    #[test]
    fn a_mishear_suggests_the_close_name() {
        let people = vec![person("Stevan", &[]), person("Lenar Rakhmatulin", &["Lenar"]), person("Tajana", &[])];
        let hits: Vec<&str> = similar(&people, "Stefan").iter().map(|p| p.id.as_str()).collect();
        assert_eq!(hits, vec!["Stevan"]);
        assert!(similar(&people, "Jo").is_empty(), "too short to guess from");
    }

    #[test]
    fn adding_to_a_list_edits_one_line_and_keeps_the_rest() {
        let vault = vault_with(&[("Stevan", STEVAN)]);
        let p = add_to_list_at(vault.path(), "Stevan", "project_aliases", "revaire: api guy").unwrap();
        assert_eq!(p.project_aliases, vec!["zirtue: backend", "revaire: api guy"]);
        let again = add_to_list_at(vault.path(), "Stevan", "projects", "ZIRTUE").unwrap();
        assert_eq!(again.projects, vec!["zirtue"], "already there, case-insensitively");
        let text = fs::read_to_string(vault.path().join("People/Stevan.md")).unwrap();
        assert!(text.contains("tags: [person, work]") && text.ends_with("# Stevan\n"), "{text}");

        let block = vault_with(&[("Dani", "---\naliases:\n  - Dani\nrelationship: x\n---\nbody\n")]);
        assert_eq!(add_to_list_at(block.path(), "Dani", "aliases", "Donna").unwrap().aliases, vec!["Dani", "Donna"]);
        let missing = vault_with(&[("Old", "---\nname: Old\n---\nbody\n")]);
        assert_eq!(add_to_list_at(missing.path(), "Old", "projects", "zirtue").unwrap().projects, vec!["zirtue"]);
    }

    #[test]
    fn a_new_person_gets_every_answer_even_from_an_older_template() {
        let vault = vault_with(&[]);
        fs::create_dir_all(vault.path().join("Templates")).unwrap();
        fs::write(vault.path().join(TEMPLATE), "---\nname: \"\"\naliases: []\nrelationship: \"\"\ntags: [person]\n---\n\n# {{title}}\n").unwrap();
        let fields = NewPerson {
            aliases: vec!["Tea".into()],
            relationship: "coworker (Revaire QA)".into(),
            gender: "female".into(),
            language: "Croatian".into(),
            messaged_on: vec!["Slack".into()],
            projects: vec!["revaire".into()],
        };
        let p = create_at(vault.path(), "Tajana", &fields).unwrap();
        assert_eq!((p.gender.as_str(), p.language.as_str()), ("female", "Croatian"));
        assert_eq!(p.messaged_on, vec!["Slack"]);
        assert_eq!(p.projects, vec!["revaire"]);
        let text = fs::read_to_string(vault.path().join("People/Tajana.md")).unwrap();
        assert!(text.contains("tags: [person]\ngender: \"female\""), "added before the closing ---: {text}");
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
